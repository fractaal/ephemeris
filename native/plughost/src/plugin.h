// One loaded plugin, whatever its format (vst3.cpp). The host (main.cpp) calls process() from its render thread; the
// rest (state, parameters' info, the editor) from the main thread, as plugin formats ask.
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

struct Param {
  uint32_t id;
  std::string title, units;
  int steps;          // 0: continuous; else the number of steps (a switch: 1)
  double value;       // normalized, 0–1, as the plugin is now
  std::string text;   // that value as the plugin writes it ("" where it does not)
  bool automatable, readOnly;
};

struct Note { int64_t at; bool on; int note; float vel; };   // at: the sample (in a block: its offset)

struct Point { int64_t at; uint32_t id; double value; };       // a parameter's value from a sample on (automation)

struct Transport { int64_t pos; double sr, bpm = 120, offset = 0; int beatsPerBar = 4; bool playing = true; };

class Plugin {
public:
  virtual ~Plugin () = default;
  virtual std::string name () const = 0;
  virtual std::string vendor () const = 0;
  virtual std::vector<Param> params () = 0;
  /** Every parameter's normalized value now (as its state set them). Main thread. */
  virtual std::vector<std::pair<uint32_t, double>> values () = 0;
  virtual int latency () = 0;
  virtual bool start (double sr, int block) = 0;
  /** Silence: what it holds released, its tails cut (a seek). */
  virtual void reset () = 0;
  virtual bool setState (const std::string& bytes) = 0;
  virtual std::string getState () = 0;
  /** A parameter's normalized value, from the next block on. Any thread. */
  virtual void setParam (uint32_t id, double value) = 0;
  /** A parameter's normalized value as the plugin writes it ("800 Hz", "Saw"), or "" where it does not say. */
  virtual std::string text (uint32_t id, double value) = 0;
  /** Text as the plugin reads it ("800 Hz", "800") into a normalized value; false where it cannot. */
  virtual bool parse (uint32_t id, const std::string& text, double& value) = 0;
  /** n samples into L and R (written), the notes and the parameters' points at their offsets in the block. */
  virtual void process (float* L, float* R, int n, const std::vector<Note>& notes, const std::vector<Point>& points, bool soundOff, const Transport& t) = 0;
  virtual bool hasEditor () = 0;
  /** Opens its window (main thread); closed() when it is closed, by the person or by closeEditor(). An error, or "". */
  virtual std::string openEditor (const std::string& title, std::function<void ()> closed) = 0;
  virtual void closeEditor () = 0;
  /** Called when the plugin changes itself (its editor turned a knob, chose a preset): its state is worth saving. */
  std::function<void ()> onEdited = [] {};
};

std::unique_ptr<Plugin> openVst3 (const std::string& path, const std::string& name, std::string& error);
