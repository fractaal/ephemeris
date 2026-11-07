// The main thread on macOS: Cocoa's run loop (NSApplication's: what a plugin's editor runs on, its timers and events),
// with posted tasks run on it (the main dispatch queue, which the loop serves); editor windows are NSWindows, the editor
// attached to their content view. The host is an accessory application (no Dock icon or menu bar of its own); a window
// is brought to the front when it opens, as the person asked for it. Compiled with ARC (as the VST3 SDK's module_mac.mm).
#include "gui.h"

#include "pluginterfaces/gui/iplugview.h"

#import <Cocoa/Cocoa.h>

#include <future>
#include <thread>

using namespace Steinberg;

// (a window's close button asks the host to close the editor, which destroys the window: it is never closed by itself)
@interface EphemerisPluginWindowDelegate : NSObject <NSWindowDelegate>
@property (nonatomic, assign) std::function<void ()>* closing;
@end
@implementation EphemerisPluginWindowDelegate
- (BOOL)windowShouldClose:(NSWindow*)sender {
  if (self.closing && *self.closing) (*self.closing) ();
  return NO;
}
@end

struct gui::Window { NSWindow* window; EphemerisPluginWindowDelegate* delegate; std::function<void ()> closing; };

namespace {
const std::thread::id mainThread = std::this_thread::get_id ();   // (static initialisation runs on the main thread)
}

void gui::run () {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp run];
  }
}

void gui::quit () {
  dispatch_async (dispatch_get_main_queue (), ^{
    [NSApp stop:nil];
    // (stop is seen after the next event: one is posted so the loop ends now)
    NSEvent* e = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0
                                windowNumber:0 context:nil subtype:0 data1:0 data2:0];
    [NSApp postEvent:e atStart:YES];
  });
}

void gui::post (std::function<void ()> fn) {
  auto* f = new std::function<void ()> (std::move (fn));
  dispatch_async (dispatch_get_main_queue (), ^{ (*f) (); delete f; });
}

void gui::call (std::function<void ()> fn) {
  if (std::this_thread::get_id () == mainThread) return fn ();
  std::promise<void> done;
  post ([&] { fn (); done.set_value (); });
  done.get_future ().wait ();
}

gui::Window* gui::open (const std::string& title, int w, int h, bool resizable, std::function<void ()> closing, std::string& error) {
  NSUInteger style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | (resizable ? NSWindowStyleMaskResizable : 0);
  NSWindow* win = [[NSWindow alloc] initWithContentRect:NSMakeRect (0, 0, w, h) styleMask:style backing:NSBackingStoreBuffered defer:NO];
  if (!win) { error = "no window could be opened (no display to open it on)"; return nullptr; }
  [win setReleasedWhenClosed:NO];
  [win setTitle:[NSString stringWithUTF8String:title.c_str ()]];
  auto* g = new gui::Window {win, [[EphemerisPluginWindowDelegate alloc] init], std::move (closing)};
  g->delegate.closing = &g->closing;
  [win setDelegate:g->delegate];
  [win center];
  [win makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  return g;
}

void gui::resize (Window* g, int w, int h) {
  if (g) [g->window setContentSize:NSMakeSize (w, h)];
}

void gui::destroy (Window* g) {
  if (!g) return;
  [g->window setDelegate:nil];
  [g->window orderOut:nil];
  [g->window close];
  delete g;   // (its window and delegate let go with it)
}

void* gui::handle (Window* g) { return (__bridge void*) [g->window contentView]; }
const char* gui::platformType () { return kPlatformTypeNSView; }
void* gui::runLoop () { return nullptr; }   // (macOS plugins run on the main run loop: they ask for none)
