// plughost: one audio plugin, played for Ephemeris (tools/plugins.mjs starts one for each instrument that is a plugin).
//   plughost <plugin.vst3> [--name <its class, where it holds several>] [--sr 48000] [--block 128]
// It speaks in frames on stdin and stdout: [u32 length][u8 kind][payload], the length counting the kind and the payload.
//   kind 1: JSON: a command (in), an event (out)
//   kind 2 (out): sound: [i64 sample][u32 n][n floats, left][n floats, right]
//   kind 3: the plugin's state, as its format keeps it (in: take it; out: what getState asked for)
// Commands:
//   tempo { bpm, offset, beatsPerBar }       the timeline's grid (tempo-synced LFOs and delays follow it)
//   notes { list: [[sample, on, note, velocity], …] }   the instrument's notes on the timeline's samples, in order (again
//                                            whenever they change: what plays goes on, a held note gone is released)
//   params { values: { <id>: 0–1 } }         parameters set, from the next block
//   texts { list: [[<id>, 0–1], …] }          those values as the plugin writes them: texts { list: ["800 Hz", …] }
//   parse { list: [[<id>, "800 Hz"], …] }     text as the plugin reads it: parsed { list: [0–1 | null, …] }
//   play { from, ahead }                     silence, then its sound from that sample, kept `ahead` samples past the
//                                            last ack { pos } (the listener's place)
//   render { from, to }                      silence, then its sound from `from` to `to` as fast as it goes; then done
//   monitor { from, ahead }                  as play, without the notes: the timeline is stopped, and the plugin is
//                                            heard as it is played (its window's keyboard, or note)
//   note { on, note, velocity }              a note now (at the next block made), while it plays or is monitored
//   automation { list: [[sample, id, 0–1], …] }   parameters' values over the timeline, in order (a value holds until
//                                            the next of its parameter's): from where it plays, each at its sample
//   stop | getState | editor { open, title } | quit (as stdin closing)
// Events: ready { name, vendor, latency, editor, params: [{ id, title, units, steps, value, text, automatable }] } once loaded;
// state { ok, values: { <id>: 0–1 } } (kind 3 taken; its parameters as it sets them); done { pos }; edited (changed in its window: its state is worth saving); editor { open };
// error { message }.
// It plays in blocks of `block` on a grid counted from where it was asked to play, so a render from the start and
// playing from the start cut the sound the same way; notes land at their own samples inside a block. Its threads that
// make sound and hear where the listener is run as sound threads (soundThread): it keeps only a little ahead, and on a
// busy machine an ordinary thread waits too long to be run.
#include "gui.h"
#include "plugin.h"

#include <nlohmann/json.hpp>
#if defined(_WIN32)
#include <windows.h>
#include <ole2.h>
#include <avrt.h>
#include <io.h>
#include <fcntl.h>
#include <process.h>
#else
#include <unistd.h>
#endif
#include <climits>
#include <cstdio>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <thread>

#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/thread_policy.h>
#include <pthread.h>
#elif defined(__linux__)
#include <pthread.h>
#include <sched.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#endif

using json = nlohmann::json;

namespace {
std::mutex outMutex;
std::atomic<bool> editorOpen {false};   // (a change is the person's only while its window is open: the rest are ours)

// The calling thread run as a sound thread, as far as the system lets this user: on macOS a real-time thread with a
// block's time constraint (no privilege needed); on Linux SCHED_FIFO where its limits allow (an audio group's rtprio),
// else the highest priority they allow (RLIMIT_NICE). Nothing changes where neither is allowed.
void soundThread (double sr, int block) {
#if defined(__APPLE__)
  mach_timebase_info_data_t tb;
  mach_timebase_info (&tb);
  const double abs = 1e9 * block / sr * tb.denom / tb.numer;   // (a block, in the clock's units)
  thread_time_constraint_policy_data_t p {(uint32_t) abs, (uint32_t) (abs * 0.5), (uint32_t) abs, 1};
  thread_policy_set (pthread_mach_thread_np (pthread_self ()), THREAD_TIME_CONSTRAINT_POLICY, (thread_policy_t) &p, THREAD_TIME_CONSTRAINT_POLICY_COUNT);
#elif defined(__linux__)
  sched_param sp {};
  sp.sched_priority = std::min (10, sched_get_priority_max (SCHED_FIFO));
  if (pthread_setschedparam (pthread_self (), SCHED_FIFO, &sp) == 0) return;
  rlimit r {};
  if (getrlimit (RLIMIT_NICE, &r) != 0) return;
  const int nice = r.rlim_cur == RLIM_INFINITY ? -20 : 20 - (int) std::min<rlim_t> (r.rlim_cur, 40);   // (its ceiling)
  if (nice < 0) setpriority (PRIO_PROCESS, (id_t) syscall (SYS_gettid), nice);
#elif defined(_WIN32)
  DWORD task = 0;
  AvSetMmThreadCharacteristicsW (L"Pro Audio", &task);
  (void) sr; (void) block;
#else
  (void) sr; (void) block;
#endif
}

void writeAll (const void* p, size_t n) {
  auto* c = static_cast<const char*> (p);
  while (n) {
#if defined(_WIN32)
    auto w = ::_write (1, c, (unsigned) std::min<size_t> (n, INT_MAX));
#else
    auto w = ::write (1, c, n);
#endif
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) _exit (0);   // (no one is listening any more)
    c += w; n -= (size_t) w;
  }
}
void frame (uint8_t kind, std::initializer_list<std::pair<const void*, size_t>> parts) {
  uint32_t len = 1;
  for (auto& p : parts) len += (uint32_t) p.second;
  std::lock_guard<std::mutex> l (outMutex);
  writeAll (&len, 4); writeAll (&kind, 1);
  for (auto& p : parts) writeAll (p.first, p.second);
}
void send (const json& j) { std::string s = j.dump (); frame (1, {{s.data (), s.size ()}}); }
bool readAll (void* p, size_t n) {
  auto* c = static_cast<char*> (p);
  while (n) {
#if defined(_WIN32)
    auto r = ::_read (0, c, (unsigned) std::min<size_t> (n, INT_MAX));
#else
    auto r = ::read (0, c, n);
#endif
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return false;
    c += r; n -= (size_t) r;
  }
  return true;
}

struct Command { uint8_t kind; json j; std::string bytes; };

// The render thread: commands in order, and the sound made while it is wanted.
class Player {
public:
  Player (Plugin& p, double sr, int block) : plug (p), sr (sr), block (block), L (block), R (block) { t.sr = sr; }

  void push (Command c) {
    { std::lock_guard<std::mutex> l (m); queue.push_back (std::move (c)); }
    cv.notify_one ();
  }

  void run () {
    while (!quitting) {
      std::deque<Command> cmds;
      {
        std::unique_lock<std::mutex> l (m);
        cv.wait (l, [&] { return !queue.empty () || wanted (); });
        cmds.swap (queue);
      }
      for (auto& c : cmds) {
        try { handle (c); } catch (const std::exception& e) { send ({{"event", "error"}, {"message", e.what ()}}); }
      }
      if (!quitting && wanted ()) step ();
    }
  }

private:
  enum class Mode { Idle, Play, Monitor, Render };
  Plugin& plug;
  double sr;
  int block;
  std::vector<float> L, R;
  std::mutex m;
  std::condition_variable cv;
  std::deque<Command> queue;
  bool quitting = false, soundOff = false;
  Mode mode = Mode::Idle;
  int64_t pos = 0, ack = 0, ahead = 0, end = 0;
  Transport t;
  std::vector<Note> notes, due;
  size_t cursor = 0;
  std::array<int, 128> held {};
  std::vector<int> offs;
  std::vector<Note> now;   // notes played now (note), for the next block
  std::vector<Point> autos, points;   // automation (in order), and the points for the block being made
  size_t acursor = 0;

  bool wanted () const { return mode == Mode::Render ? pos < end : (mode == Mode::Play || mode == Mode::Monitor) && pos < ack + ahead; }
  size_t firstAt (int64_t s) const { return std::lower_bound (notes.begin (), notes.end (), s, [] (const Note& n, int64_t v) { return n.at < v; }) - notes.begin (); }
  size_t firstAuto (int64_t s) const { return std::lower_bound (autos.begin (), autos.end (), s, [] (const Point& p, int64_t v) { return p.at < v; }) - autos.begin (); }
  // each automated parameter's value at sample s (its last point before it), set at the next block's start
  void automationAt (int64_t s) {
    std::map<uint32_t, double> last;
    for (size_t i = 0, e = firstAuto (s + 1); i < e; i++) last[autos[i].id] = autos[i].value;
    for (auto& [id, v] : last) plug.setParam (id, v);
    acursor = firstAuto (s + 1);
  }

  void begin (int64_t from, Mode next) {
    plug.reset ();
    for (int k = 0; k < 128; k++) if (held[k]) offs.push_back (k);
    held.fill (0);
    soundOff = true;
    pos = from; cursor = firstAt (pos); mode = next;
    if (next != Mode::Monitor) automationAt (pos);
  }

  void handle (Command& c) {
    if (c.kind == 3) {
      bool ok = plug.setState (c.bytes);
      json values = json::object ();
      gui::call ([&] { for (auto& [id, v] : plug.values ()) values[std::to_string (id)] = v; });
      send ({{"event", "state"}, {"ok", ok}, {"values", values}});
      return;
    }
    const json& j = c.j;
    std::string op = j.value ("op", "");
    if (op == "tempo") { t.bpm = j.value ("bpm", 120.0); t.offset = j.value ("offset", 0.0); t.beatsPerBar = std::max (1, j.value ("beatsPerBar", 4)); }
    else if (op == "notes") {
      notes.clear ();
      for (auto& e : j.at ("list")) notes.push_back ({e.at (0).get<int64_t> (), e.at (1).get<int> () != 0, e.at (2).get<int> () & 127, e.size () > 3 ? e.at (3).get<float> () : 0.8f});
      cursor = firstAt (pos);
      // a held note whose release is gone: released now
      for (int k = 0; k < 128; k++) {
        if (!held[k]) continue;
        auto it = std::find_if (notes.begin () + cursor, notes.end (), [k] (const Note& n) { return n.note == k; });
        if (it == notes.end () || it->on) { offs.push_back (k); held[k] = 0; }
      }
    }
    else if (op == "automation") {
      autos.clear ();
      for (auto& e : j.at ("list")) autos.push_back ({e.at (0).get<int64_t> (), e.at (1).get<uint32_t> (), e.at (2).get<double> ()});
      std::stable_sort (autos.begin (), autos.end (), [] (const Point& a, const Point& b) { return a.at < b.at; });
      if (mode == Mode::Play || mode == Mode::Render) automationAt (pos); else acursor = firstAuto (pos);   // (heard at once)
    }
    else if (op == "params") { for (auto& [k, v] : j.at ("values").items ()) plug.setParam ((uint32_t) std::stoul (k), v.get<double> ()); }
    else if (op == "texts") {
      json out = json::array ();
      for (auto& e : j.at ("list")) out.push_back (plug.text (e.at (0).get<uint32_t> (), e.at (1).get<double> ()));
      send ({{"event", "texts"}, {"list", out}});
    }
    else if (op == "parse") {
      json out = json::array ();
      for (auto& e : j.at ("list")) { double v = 0; out.push_back (plug.parse (e.at (0).get<uint32_t> (), e.at (1).get<std::string> (), v) ? json (v) : json (nullptr)); }
      send ({{"event", "parsed"}, {"list", out}});
    }
    else if (op == "play" || op == "monitor") { begin (j.value ("from", (int64_t) 0), op == "play" ? Mode::Play : Mode::Monitor); ack = pos; ahead = j.value ("ahead", (int64_t) (sr / 10)); }
    else if (op == "note") { if (mode == Mode::Play || mode == Mode::Monitor) now.push_back ({0, j.value ("on", true), j.value ("note", 60) & 127, j.value ("velocity", 0.8f)}); }
    else if (op == "render") { begin (j.value ("from", (int64_t) 0), Mode::Render); end = j.value ("to", pos); }
    else if (op == "ack") ack = j.value ("pos", ack);
    else if (op == "stop") mode = Mode::Idle;
    else if (op == "getState") { std::string s = plug.getState (); frame (3, {{s.data (), s.size ()}}); }
    else if (op == "editor") {
      bool open = j.value ("open", true);
      std::string title = j.value ("title", plug.name ());
      gui::post ([this, open, title] {
        if (!open) return plug.closeEditor ();
        std::string error = plug.openEditor (title, [] { editorOpen = false; send ({{"event", "editor"}, {"open", false}}); });
        editorOpen = error.empty ();
        send (error.empty () ? json {{"event", "editor"}, {"open", true}} : json {{"event", "error"}, {"message", error}});
      });
    }
    else if (op == "quit") quitting = true;
    else send ({{"event", "error"}, {"message", "no command " + op}});
  }

  void step () {
    int n = mode == Mode::Render ? (int) std::min<int64_t> (block, end - pos) : block;
    due.clear ();
    for (int k : offs) due.push_back ({0, false, k, 0});
    offs.clear ();
    for (auto& e : now) {
      if (e.on) held[e.note]++;
      else if (held[e.note]) held[e.note]--;
      due.push_back (e);
    }
    now.clear ();
    while (mode != Mode::Monitor && cursor < notes.size () && notes[cursor].at < pos + n) {
      Note e = notes[cursor++];
      e.at = std::max<int64_t> (0, e.at - pos);
      if (e.on) held[e.note]++;
      else if (held[e.note]) held[e.note]--;
      due.push_back (e);
    }
    points.clear ();
    while (mode != Mode::Monitor && acursor < autos.size () && autos[acursor].at < pos + n) {
      Point p = autos[acursor++];
      p.at = std::max<int64_t> (0, p.at - pos);
      points.push_back (p);
    }
    t.pos = pos;
    t.playing = mode != Mode::Monitor;
    plug.process (L.data (), R.data (), n, due, points, soundOff, t);
    soundOff = false;
    int64_t at = pos;
    uint32_t count = (uint32_t) n;
    frame (2, {{&at, 8}, {&count, 4}, {L.data (), (size_t) n * 4}, {R.data (), (size_t) n * 4}});
    pos += n;
    if (mode == Mode::Render && pos >= end) { mode = Mode::Idle; send ({{"event", "done"}, {"pos", pos}}); }
  }
};
}

int hostMain (int argc, char** argv) {
  std::string path, name;
  double sr = 48000;
  int block = 128;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--name" && i + 1 < argc) name = argv[++i];
    else if (a == "--sr" && i + 1 < argc) sr = atof (argv[++i]);
    else if (a == "--block" && i + 1 < argc) block = std::max (16, atoi (argv[++i]));
    else path = a;
  }
  if (path.empty ()) { send ({{"event", "error"}, {"message", "usage: plughost <plugin.vst3> [--name <class>] [--sr 48000] [--block 128]"}}); return 2; }
  std::string error;
  auto plug = openVst3 (path, name, error);
  if (!plug) { send ({{"event", "error"}, {"message", path + ": " + error}}); return 1; }
  if (!plug->start (sr, block)) { send ({{"event", "error"}, {"message", path + ": it would not play at " + std::to_string ((int) sr) + " Hz"}}); return 1; }

  json params = json::array ();
  for (auto& p : plug->params ())
    if (!p.readOnly) params.push_back ({{"id", p.id}, {"title", p.title}, {"units", p.units}, {"steps", p.steps}, {"value", p.value}, {"text", p.text}, {"automatable", p.automatable}});
  plug->onEdited = [] { if (editorOpen) send ({{"event", "edited"}}); };
  send ({{"event", "ready"}, {"name", plug->name ()}, {"vendor", plug->vendor ()}, {"latency", plug->latency ()}, {"editor", plug->hasEditor ()}, {"params", params}});

  Player player (*plug, sr, block);
  std::thread render ([&] { soundThread (sr, block); player.run (); gui::quit (); });
  std::thread reader ([&] {
    soundThread (sr, block);   // (the listener's place, each ack, as soon as it comes)
    for (;;) {
      uint32_t len;
      uint8_t kind;
      if (!readAll (&len, 4) || len < 1 || !readAll (&kind, 1)) break;
      std::string payload (len - 1, '\0');
      if (!readAll (payload.data (), payload.size ())) break;
      Command c {kind, {}, {}};
      if (kind == 1) {
        c.j = json::parse (payload, nullptr, false);
        if (c.j.is_discarded ()) { send ({{"event", "error"}, {"message", "a command that is not JSON"}}); continue; }
      } else c.bytes = std::move (payload);
      player.push (std::move (c));
    }
    player.push ({1, {{"op", "quit"}}, {}});
  });
  reader.detach ();
  gui::run ();
  render.join ();
  plug->closeEditor ();
  _exit (0);   // (a plugin's own teardown is not waited for: the process is done)
}

#if defined(_WIN32)
int wmain (int argc, wchar_t** wide) {
  // The protocol is binary, never the CRT's default text mode (CRLF and Ctrl-Z would corrupt audio and state).
  _setmode (_fileno (stdin), _O_BINARY);
  _setmode (_fileno (stdout), _O_BINARY);
  OleInitialize (nullptr);
  SetProcessDpiAwarenessContext (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  std::vector<std::string> strings;
  std::vector<char*> args;
  for (int i = 0; i < argc; i++) {
    const int n = WideCharToMultiByte (CP_UTF8, 0, wide[i], -1, nullptr, 0, nullptr, nullptr);
    std::string s (n, '\0');
    WideCharToMultiByte (CP_UTF8, 0, wide[i], -1, s.data (), n, nullptr, nullptr);
    strings.push_back (std::move (s));
  }
  for (auto& s : strings) args.push_back (s.data ());
  return hostMain (argc, args.data ());
}
#else
int main (int argc, char** argv) { return hostMain (argc, argv); }
#endif
