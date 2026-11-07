// The main thread on Linux: a poll() loop over the posted tasks, the X display (opened when a window is first asked for,
// so a render needs none) and what plugins register with it (Steinberg::Linux::IRunLoop: their file descriptors and
// timers); editor windows are plain X11 top-level windows, marked as dialogs so tiling window managers float them.
#include "gui.h"

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugview.h"

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <deque>
#include <future>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

using namespace Steinberg;

struct gui::Window { ::Window xid; std::function<void ()> closing; };

namespace {
using Clock = std::chrono::steady_clock;

const int xThreads = (XInitThreads (), 0);   // (before any Xlib call: plugins draw from their own threads)
std::mutex mtx;
std::deque<std::function<void ()>> tasks;
int wake[2] = {-1, -1};
std::once_flag wakeOnce;
std::atomic<bool> stopping {false};
std::thread::id mainThread;
Display* dpy = nullptr;
Atom wmDelete = None;
std::map<::Window, gui::Window*> windows;

void wakeUp () {
  std::call_once (wakeOnce, [] { if (pipe2 (wake, O_CLOEXEC | O_NONBLOCK) != 0) wake[0] = wake[1] = -1; });
  char c = 1;
  if (wake[1] >= 0) (void) !write (wake[1], &c, 1);
}

struct RunLoop : U::ImplementsNonDestroyable<U::Directly<Linux::IRunLoop>> {
  struct Timer { IPtr<Linux::ITimerHandler> h; Linux::TimerInterval ms; Clock::time_point next; };
  std::map<int, IPtr<Linux::IEventHandler>> fds;
  std::vector<Timer> timers;

  tresult PLUGIN_API registerEventHandler (Linux::IEventHandler* h, Linux::FileDescriptor fd) override {
    if (!h) return kInvalidArgument;
    fds[fd] = h;
    return kResultTrue;
  }
  tresult PLUGIN_API unregisterEventHandler (Linux::IEventHandler* h) override {
    for (auto it = fds.begin (); it != fds.end ();) it = it->second == h ? fds.erase (it) : std::next (it);
    return kResultTrue;
  }
  tresult PLUGIN_API registerTimer (Linux::ITimerHandler* h, Linux::TimerInterval ms) override {
    if (!h || !ms) return kInvalidArgument;
    timers.push_back ({h, ms, Clock::now () + std::chrono::milliseconds (ms)});
    return kResultTrue;
  }
  tresult PLUGIN_API unregisterTimer (Linux::ITimerHandler* h) override {
    timers.erase (std::remove_if (timers.begin (), timers.end (), [h] (const Timer& t) { return t.h == h; }), timers.end ());
    return kResultTrue;
  }
};
RunLoop loop;

void xEvents () {
  while (dpy && XPending (dpy)) {
    XEvent e;
    XNextEvent (dpy, &e);
    if (e.type == ClientMessage && (Atom) e.xclient.data.l[0] == wmDelete) {
      auto it = windows.find (e.xclient.window);
      if (it != windows.end () && it->second->closing) it->second->closing ();
    }
  }
}
}

void gui::run () {
  mainThread = std::this_thread::get_id ();
  wakeUp ();   // (makes the pipe)
  while (!stopping) {
    std::vector<pollfd> p {{wake[0], POLLIN, 0}};
    if (dpy) p.push_back ({ConnectionNumber (dpy), POLLIN, 0});
    std::vector<int> fds;
    for (auto& [fd, h] : loop.fds) { p.push_back ({fd, POLLIN, 0}); fds.push_back (fd); }
    int timeout = -1;
    auto now = Clock::now ();
    for (auto& t : loop.timers) {
      int ms = std::max (0, (int) std::chrono::duration_cast<std::chrono::milliseconds> (t.next - now).count ());
      timeout = timeout < 0 ? ms : std::min (timeout, ms);
    }
    if (dpy) { XFlush (dpy); if (XPending (dpy)) timeout = 0; }
    poll (p.data (), p.size (), timeout);

    char buf[64];
    while (read (wake[0], buf, sizeof buf) > 0) {}
    std::deque<std::function<void ()>> run;
    { std::lock_guard<std::mutex> l (mtx); run.swap (tasks); }
    for (auto& fn : run) fn ();
    xEvents ();
    for (size_t i = 0; i < fds.size (); i++) {
      if (!p[p.size () - fds.size () + i].revents) continue;
      auto it = loop.fds.find (fds[i]);   // (a handler may have gone meanwhile)
      if (it != loop.fds.end ()) { IPtr<Linux::IEventHandler> h = it->second; h->onFDIsSet (fds[i]); }
    }
    now = Clock::now ();
    std::vector<IPtr<Linux::ITimerHandler>> due;
    for (auto& t : loop.timers) if (t.next <= now) { due.push_back (t.h); t.next = now + std::chrono::milliseconds (t.ms); }
    for (auto& h : due) if (std::any_of (loop.timers.begin (), loop.timers.end (), [&] (auto& t) { return t.h == h; })) h->onTimer ();
  }
}

void gui::quit () { stopping = true; wakeUp (); }

void gui::post (std::function<void ()> fn) {
  { std::lock_guard<std::mutex> l (mtx); tasks.push_back (std::move (fn)); }
  wakeUp ();
}

void gui::call (std::function<void ()> fn) {
  if (std::this_thread::get_id () == mainThread) return fn ();
  std::promise<void> done;
  post ([&] { fn (); done.set_value (); });
  done.get_future ().wait ();
}

gui::Window* gui::open (const std::string& title, int w, int h, bool resizable, std::function<void ()> closing, std::string& error) {
  if (!dpy) {
    dpy = XOpenDisplay (nullptr);
    if (!dpy) { error = "no display to open a window on (DISPLAY)"; return nullptr; }
    wmDelete = XInternAtom (dpy, "WM_DELETE_WINDOW", False);
  }
  int screen = DefaultScreen (dpy);
  ::Window xid = XCreateSimpleWindow (dpy, RootWindow (dpy, screen), 0, 0, w, h, 0, BlackPixel (dpy, screen), BlackPixel (dpy, screen));
  XStoreName (dpy, xid, title.c_str ());
  XChangeProperty (dpy, xid, XInternAtom (dpy, "_NET_WM_NAME", False), XInternAtom (dpy, "UTF8_STRING", False), 8, PropModeReplace,
                   (const unsigned char*) title.data (), (int) title.size ());
  XClassHint cls {(char*) "ephemeris-plugin", (char*) "Ephemeris"};
  XSetClassHint (dpy, xid, &cls);
  Atom dialog = XInternAtom (dpy, "_NET_WM_WINDOW_TYPE_DIALOG", False);
  XChangeProperty (dpy, xid, XInternAtom (dpy, "_NET_WM_WINDOW_TYPE", False), XA_ATOM, 32, PropModeReplace, (const unsigned char*) &dialog, 1);
  if (!resizable) {
    XSizeHints* hints = XAllocSizeHints ();
    hints->flags = PMinSize | PMaxSize;
    hints->min_width = hints->max_width = w;
    hints->min_height = hints->max_height = h;
    XSetWMNormalHints (dpy, xid, hints);
    XFree (hints);
  }
  XSetWMProtocols (dpy, xid, &wmDelete, 1);
  XSelectInput (dpy, xid, StructureNotifyMask);
  XMapWindow (dpy, xid);
  XSync (dpy, False);
  auto* win = new gui::Window {xid, std::move (closing)};
  windows[xid] = win;
  return win;
}

void gui::resize (Window* win, int w, int h) {
  if (!win || !dpy) return;
  XSizeHints* hints = XAllocSizeHints ();
  long supplied;
  XGetWMNormalHints (dpy, win->xid, hints, &supplied);
  if (hints->flags & PMaxSize) { hints->min_width = hints->max_width = w; hints->min_height = hints->max_height = h; XSetWMNormalHints (dpy, win->xid, hints); }
  XFree (hints);
  XResizeWindow (dpy, win->xid, w, h);
  XFlush (dpy);
}

void gui::destroy (Window* win) {
  if (!win) return;
  windows.erase (win->xid);
  if (dpy) { XDestroyWindow (dpy, win->xid); XFlush (dpy); }
  delete win;
}

void* gui::handle (Window* win) { return reinterpret_cast<void*> (win->xid); }
const char* gui::platformType () { return kPlatformTypeX11EmbedWindowID; }
void* gui::runLoop () { return static_cast<Linux::IRunLoop*> (&loop); }
