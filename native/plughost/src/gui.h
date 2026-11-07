// The host's main thread: a run loop (a plugin's editor needs one: its timers, its file descriptors) and the windows its
// editors are opened in. gui_linux.cpp (X11), gui_mac.mm (Cocoa), gui_windows.cpp (Win32).
#pragma once
#include <functional>
#include <string>

namespace gui {
/** Runs the loop on this thread until quit(). */
void run ();
void quit ();
/** Runs fn on the main thread (from any thread). */
void post (std::function<void ()> fn);
/** Runs fn on the main thread and waits for it. */
void call (std::function<void ()> fn);

struct Window;
/** A window for a plugin's editor, `w`×`h`; closing() when the person closes it. Null where there is no display. */
Window* open (const std::string& title, int w, int h, bool resizable, std::function<void ()> closing, std::string& error);
void resize (Window*, int w, int h);
void destroy (Window*);
/** What an editor is attached to: the platform's handle and its type name (as the plugin formats name them). */
void* handle (Window*);
const char* platformType ();
/** The run loop a plugin asks its editor's frame for (Linux: Steinberg::Linux::IRunLoop), as a FUnknown. */
void* runLoop ();
}
