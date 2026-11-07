// Windows' message loop and HWNDs for VST3 editors. Posted work and plugin timers run on the main thread.
#include "gui.h"
#include "pluginterfaces/gui/iplugview.h"
#include <windows.h>
#include <future>
#include <memory>

struct gui::Window { HWND hwnd; std::function<void ()> closing; };

namespace {
constexpr UINT taskMessage = WM_APP + 1;
const DWORD mainThread = [] {
  MSG msg;
  PeekMessageW (&msg, nullptr, 0, 0, PM_NOREMOVE);   // create the queue before any worker can post to it
  return GetCurrentThreadId ();
} ();

LRESULT CALLBACK procedure (HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
  auto* window = reinterpret_cast<gui::Window*> (GetWindowLongPtrW (hwnd, GWLP_USERDATA));
  if (msg == WM_CLOSE && window) {
    auto closing = window->closing;   // closing the editor also destroys this Window
    if (closing) closing ();
    return 0;
  }
  return DefWindowProcW (hwnd, msg, w, l);
}
}

void gui::run () {
  MSG msg;
  while (GetMessageW (&msg, nullptr, 0, 0) > 0) {
    if (!msg.hwnd && msg.message == taskMessage) {
      std::unique_ptr<std::function<void ()>> fn (reinterpret_cast<std::function<void ()>*> (msg.lParam));
      (*fn) ();
    } else { TranslateMessage (&msg); DispatchMessageW (&msg); }
  }
}
void gui::post (std::function<void ()> fn) {
  auto task = std::make_unique<std::function<void ()>> (std::move (fn));
  if (PostThreadMessageW (mainThread, taskMessage, 0, reinterpret_cast<LPARAM> (task.get ()))) task.release ();
}
void gui::quit () { post ([] { PostQuitMessage (0); }); }
void gui::call (std::function<void ()> fn) {
  if (GetCurrentThreadId () == mainThread) return fn ();
  std::promise<void> done;
  post ([&] { fn (); done.set_value (); });
  done.get_future ().wait ();
}

gui::Window* gui::open (const std::string& title, int w, int h, bool resizable, std::function<void ()> closing, std::string& error) {
  const auto instance = GetModuleHandleW (nullptr);
  WNDCLASSW cls {};
  cls.lpfnWndProc = procedure;
  cls.hInstance = instance;
  cls.hCursor = LoadCursorW (nullptr, IDC_ARROW);
  cls.lpszClassName = L"EphemerisPluginEditor";
  if (!RegisterClassW (&cls) && GetLastError () != ERROR_CLASS_ALREADY_EXISTS) { error = "the editor window could not be registered"; return nullptr; }
  const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | (resizable ? WS_THICKFRAME | WS_MAXIMIZEBOX : 0);
  RECT rect {0, 0, w, h};
  AdjustWindowRectEx (&rect, style, FALSE, 0);
  std::wstring wide (MultiByteToWideChar (CP_UTF8, 0, title.data (), (int) title.size (), nullptr, 0), L'\0');
  MultiByteToWideChar (CP_UTF8, 0, title.data (), (int) title.size (), wide.data (), (int) wide.size ());
  HWND hwnd = CreateWindowExW (0, cls.lpszClassName, wide.c_str (), style, CW_USEDEFAULT, CW_USEDEFAULT,
                              rect.right - rect.left, rect.bottom - rect.top, nullptr, nullptr, instance, nullptr);
  if (!hwnd) { error = "no window could be opened"; return nullptr; }
  auto* window = new Window {hwnd, std::move (closing)};
  SetWindowLongPtrW (hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR> (window));
  ShowWindow (hwnd, SW_SHOW);
  SetForegroundWindow (hwnd);
  return window;
}
void gui::resize (Window* window, int w, int h) {
  if (!window) return;
  RECT rect {0, 0, w, h};
  AdjustWindowRectEx (&rect, (DWORD) GetWindowLongPtrW (window->hwnd, GWL_STYLE), FALSE, 0);
  SetWindowPos (window->hwnd, nullptr, 0, 0, rect.right - rect.left, rect.bottom - rect.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}
void gui::destroy (Window* window) {
  if (!window) return;
  SetWindowLongPtrW (window->hwnd, GWLP_USERDATA, 0);
  DestroyWindow (window->hwnd);
  delete window;
}
void* gui::handle (Window* window) { return window->hwnd; }
const char* gui::platformType () { return Steinberg::kPlatformTypeHWND; }
void* gui::runLoop () { return nullptr; }
