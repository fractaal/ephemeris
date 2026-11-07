// VST3 plugins, through the Steinberg SDK's hosting helpers (MIT since VST 3.8). Threads as the format asks: state,
// activation and the editor on the main thread (gui::call), process() on the render thread.
#include "gui.h"
#include "plugin.h"

#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

#include <cmath>
#include <cstring>
#include <mutex>
#include <set>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {
void hostApp () {
  static HostApplication* app = [] { auto* a = new HostApplication; PluginContextFactory::instance ().setPluginContext (a); return a; } ();
  (void) app;
}

// what the controller tells the host: an edit in its editor (passed on to the processor), a change in itself
class Handler : public U::ImplementsNonDestroyable<U::Directly<IComponentHandler>> {
public:
  std::function<void (ParamID, ParamValue)> edit;
  std::function<void ()> changed;
  tresult PLUGIN_API beginEdit (ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit (ParamID id, ParamValue v) override { edit (id, v); return kResultOk; }
  tresult PLUGIN_API endEdit (ParamID) override { changed (); return kResultOk; }
  tresult PLUGIN_API restartComponent (int32) override { changed (); return kResultOk; }
};

// the editor's frame: its resizing, and (Linux) the run loop it asks for
class Frame : public IPlugFrame {
public:
  std::function<void (int, int)> resize;
  tresult PLUGIN_API resizeView (IPlugView* view, ViewRect* r) override {
    if (resize) resize (r->getWidth (), r->getHeight ());
    view->onSize (r);
    return kResultTrue;
  }
  tresult PLUGIN_API queryInterface (const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual (iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual (iid, FUnknown::iid)) { *obj = this; return kResultTrue; }
#if SMTG_OS_LINUX
    if (FUnknownPrivate::iidEqual (iid, Linux::IRunLoop::iid)) { *obj = gui::runLoop (); return kResultTrue; }
#endif
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef () override { return 1; }
  uint32 PLUGIN_API release () override { return 1; }
};

class Vst3 final : public Plugin {
public:
  VST3::Hosting::Module::Ptr module;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> component;
  IPtr<IEditController> controller;
  FUnknownPtr<IAudioProcessor> processor;
  std::string name_, vendor_;
  HostProcessData data;
  EventList events;
  ParameterChanges changes;
  ProcessContext ctx {};
  Handler handler;
  Frame frame;
  IPtr<IPlugView> view;
  gui::Window* window = nullptr;
  std::function<void ()> closed;
  std::mutex pendingMutex;
  std::vector<std::pair<ParamID, ParamValue>> pending, taken;
  ParamID soundOff[2] = {kNoParamId, kNoParamId};   // the parameters standing for MIDI's all-sounds-off and all-notes-off

  ~Vst3 () override { closeEditor (); }
  std::string name () const override { return name_; }
  std::string vendor () const override { return vendor_; }
  int latency () override { return (int) processor->getLatencySamples (); }
  bool hasEditor () override { return controller != nullptr; }

  std::vector<Param> params () override {
    std::vector<Param> out;
    if (!controller) return out;
    // (a parameter standing for a MIDI controller is the plugin's way to hear MIDI: not one of its own)
    std::set<ParamID> midi;
    if (FUnknownPtr<IMidiMapping> mm (controller); mm)
      for (int16 ch = 0; ch < 16; ch++)
        for (int16 cc = 0; cc < ControllerNumbers::kCountCtrlNumber; cc++) { ParamID id; if (mm->getMidiControllerAssignment (0, ch, cc, id) == kResultTrue) midi.insert (id); }
    for (int32 i = 0, n = controller->getParameterCount (); i < n; i++) {
      ParameterInfo pi {};
      if (controller->getParameterInfo (i, pi) != kResultOk || (pi.flags & ParameterInfo::kIsHidden) || midi.count (pi.id)) continue;
      double v = controller->getParamNormalized (pi.id);
      out.push_back ({pi.id, VST3::StringConvert::convert (pi.title), VST3::StringConvert::convert (pi.units), pi.stepCount,
                      v, text (pi.id, v), (pi.flags & ParameterInfo::kCanAutomate) != 0, (pi.flags & ParameterInfo::kIsReadOnly) != 0});
    }
    return out;
  }

  std::string text (uint32_t id, double value) override {
    String128 s {};
    if (!controller || controller->getParamStringByValue (id, value, s) != kResultOk) return "";
    return VST3::StringConvert::convert (s);
  }

  bool parse (uint32_t id, const std::string& text, double& value) override {
    if (!controller) return false;
    std::u16string u = VST3::StringConvert::convert (text);
    ParamValue v = 0;
    if (controller->getParamValueByString (id, const_cast<TChar*> (reinterpret_cast<const TChar*> (u.c_str ())), v) != kResultOk) return false;
    value = std::min (1.0, std::max (0.0, v));
    return true;
  }

  bool start (double sr, int block) override {
    // its main output and its first event input; any other bus (a sidechain input, extra outputs) off
    for (int32 i = 0; i < component->getBusCount (kAudio, kOutput); i++) component->activateBus (kAudio, kOutput, i, i == 0);
    for (int32 i = 0; i < component->getBusCount (kAudio, kInput); i++) component->activateBus (kAudio, kInput, i, false);
    for (int32 i = 0; i < component->getBusCount (kEvent, kInput); i++) component->activateBus (kEvent, kInput, i, i == 0);
    std::vector<SpeakerArrangement> ins (component->getBusCount (kAudio, kInput), SpeakerArr::kStereo), outs (component->getBusCount (kAudio, kOutput), SpeakerArr::kStereo);
    processor->setBusArrangements (ins.data (), (int32) ins.size (), outs.data (), (int32) outs.size ());
    ProcessSetup setup {kRealtime, kSample32, block, sr};   // (realtime in renders too: what plays live is what renders)
    if (processor->setupProcessing (setup) != kResultOk) return false;
    component->setActive (true);
    processor->setProcessing (true);
    data.prepare (*component, block, kSample32);
    events.setMaxSize (1024);
    changes.setMaxParameters (64);
    data.inputEvents = &events;
    data.inputParameterChanges = &changes;
    data.processContext = &ctx;
    return true;
  }

  void reset () override {
    gui::call ([&] {
      processor->setProcessing (false);
      component->setActive (false);
      component->setActive (true);
      processor->setProcessing (true);
    });
  }

  bool setState (const std::string& bytes) override {
    bool ok = false;
    gui::call ([&] {
      MemoryStream s;
      int32 written = 0;
      s.write ((void*) bytes.data (), (int32) bytes.size (), &written);
      s.seek (0, IBStream::kIBSeekSet, nullptr);
      ok = component->setState (&s) == kResultOk;
      if (controller) { s.seek (0, IBStream::kIBSeekSet, nullptr); controller->setComponentState (&s); }
    });
    return ok;
  }

  std::string getState () override {
    std::string out;
    gui::call ([&] {
      MemoryStream s;
      if (component->getState (&s) == kResultOk) out.assign (s.getData (), (size_t) s.getSize ());
    });
    return out;
  }

  std::vector<std::pair<uint32_t, double>> values () override {
    std::vector<std::pair<uint32_t, double>> out;
    if (!controller) return out;
    for (auto& p : params ()) out.push_back ({p.id, controller->getParamNormalized (p.id)});
    return out;
  }

  void setParam (uint32_t id, double value) override {
    std::lock_guard<std::mutex> l (pendingMutex);
    pending.push_back ({id, value});
  }

  void change (ParamID id, ParamValue v, int32 offset = 0) {
    int32 index;
    if (auto* q = changes.addParameterData (id, index)) q->addPoint (offset, v, index);
  }

  void process (float* L, float* R, int n, const std::vector<Note>& notes, const std::vector<Point>& points, bool off, const Transport& t) override {
    events.clear ();
    changes.clearQueue ();
    { std::lock_guard<std::mutex> l (pendingMutex); taken.swap (pending); }
    for (auto& [id, v] : taken) change (id, v);
    taken.clear ();
    if (off) for (ParamID id : soundOff) if (id != kNoParamId) change (id, 0);
    for (auto& p : points) change (p.id, p.value, (int32) p.at);
    for (auto& nt : notes) {
      Event e {};
      e.busIndex = 0;
      e.sampleOffset = (int32) nt.at;
      if (nt.on) {
        e.type = Event::kNoteOnEvent;
        e.noteOn.pitch = (int16) nt.note; e.noteOn.velocity = nt.vel; e.noteOn.noteId = -1;
      } else {
        e.type = Event::kNoteOffEvent;
        e.noteOff.pitch = (int16) nt.note; e.noteOff.noteId = -1;
      }
      events.addEvent (e);
    }
    // the timeline's tempo; its music time counted from the grid's first downbeat (whole bars added, so never negative)
    double beat = 60.0 / t.bpm, bar = beat * t.beatsPerBar, lead = std::ceil (std::max (0.0, t.offset) / bar) * bar;
    double music = (t.pos / t.sr - t.offset + lead) / beat;
    ctx.state = (t.playing ? ProcessContext::kPlaying : 0) | ProcessContext::kTempoValid | ProcessContext::kTimeSigValid |
                ProcessContext::kProjectTimeMusicValid | ProcessContext::kBarPositionValid;
    ctx.sampleRate = t.sr;
    ctx.projectTimeSamples = t.pos;
    ctx.tempo = t.bpm;
    ctx.timeSigNumerator = t.beatsPerBar;
    ctx.timeSigDenominator = 4;
    ctx.projectTimeMusic = music;
    ctx.barPositionMusic = std::floor (music / t.beatsPerBar) * t.beatsPerBar;
    data.numSamples = n;
    processor->process (data);
    if (data.numOutputs < 1 || data.outputs[0].numChannels < 1) { std::memset (L, 0, n * 4); std::memset (R, 0, n * 4); return; }
    float** ch = data.outputs[0].channelBuffers32;
    std::memcpy (L, ch[0], n * 4);
    std::memcpy (R, ch[data.outputs[0].numChannels > 1 ? 1 : 0], n * 4);
  }

  std::string openEditor (const std::string& title, std::function<void ()> onClosed) override {
    if (view) return "";
    if (!controller) return "it has no editor";
    view = owned (controller->createView (ViewType::kEditor));
    if (!view) return "it has no editor";
    if (view->isPlatformTypeSupported (gui::platformType ()) != kResultTrue) { view = nullptr; return "its editor does not run on this system"; }
    ViewRect r {};
    view->getSize (&r);
    std::string error;
    window = gui::open (title, r.getWidth (), r.getHeight (), view->canResize () == kResultTrue, [this] { closeEditor (); }, error);
    if (!window) { view = nullptr; return error; }
    frame.resize = [this] (int w, int h) { gui::resize (window, w, h); };
    view->setFrame (&frame);
    if (view->attached (gui::handle (window), gui::platformType ()) != kResultOk) { closeEditor (); return "its editor would not open"; }
    closed = std::move (onClosed);
    return "";
  }

  void closeEditor () override {
    if (!view) return;
    view->removed ();
    view->setFrame (nullptr);
    view = nullptr;
    gui::destroy (window);
    window = nullptr;
    if (auto c = std::move (closed)) { closed = nullptr; c (); }
  }
};
}

std::unique_ptr<Plugin> openVst3 (const std::string& path, const std::string& name, std::string& error) {
  hostApp ();
  auto p = std::make_unique<Vst3> ();
  p->module = VST3::Hosting::Module::create (path, error);
  if (!p->module) return nullptr;
  auto factory = p->module->getFactory ();
  for (auto& info : factory.classInfos ()) {
    if (info.category () != kVstAudioEffectClass || (!name.empty () && info.name () != name)) continue;
    p->provider = owned (new PlugProvider (factory, info, true));
    p->name_ = info.name ();
    p->vendor_ = info.vendor ();
    break;
  }
  if (!p->provider) { error = name.empty () ? "it holds no instrument or effect" : "it holds nothing named " + name; return nullptr; }
  p->component = owned (p->provider->getComponent ());
  p->controller = owned (p->provider->getController ());
  p->processor = FUnknownPtr<IAudioProcessor> (p->component);
  if (!p->component || !p->processor) { error = "it would not start"; return nullptr; }
  auto* raw = p.get ();
  p->handler.edit = [raw] (ParamID id, ParamValue v) { raw->setParam (id, v); };
  p->handler.changed = [raw] { raw->onEdited (); };
  if (p->controller) {
    p->controller->setComponentHandler (&p->handler);
    if (FUnknownPtr<IMidiMapping> midi (p->controller); midi) {
      midi->getMidiControllerAssignment (0, 0, ControllerNumbers::kCtrlAllSoundsOff, p->soundOff[0]);
      midi->getMidiControllerAssignment (0, 0, ControllerNumbers::kCtrlAllNotesOff, p->soundOff[1]);
    }
  }
  return p;
}
