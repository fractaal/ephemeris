# plughost: Ephemeris's plugin host (src/main.cpp says what it does). Built by build.sh, into the cache.
cmake_minimum_required (VERSION 3.25)
project (plughost CXX)
set (CMAKE_CXX_STANDARD 17)
set (CMAKE_CXX_STANDARD_REQUIRED ON)
if (NOT CMAKE_BUILD_TYPE)
  set (CMAKE_BUILD_TYPE Release)
endif ()

if (MSVC)
  # No separately installed Visual C++ runtime is needed by the packaged helper.
  set (CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  set (SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
  add_compile_definitions (NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
  add_compile_options (/utf-8)
endif ()

include (FetchContent)
# the VST3 SDK (MIT since 3.8): its hosting helpers only
set (SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set (SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set (SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set (SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set (SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
FetchContent_Declare (vst3sdk
  GIT_REPOSITORY https://github.com/steinbergmedia/vst3sdk.git
  GIT_TAG v3.8.0_build_66
  GIT_SHALLOW TRUE
  GIT_SUBMODULES base cmake pluginterfaces public.sdk)
# nlohmann/json (MIT): the commands and events
FetchContent_Declare (json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d)
FetchContent_MakeAvailable (vst3sdk json)

set (SDK ${vst3sdk_SOURCE_DIR})
add_executable (plughost
  src/main.cpp src/vst3.cpp
  ${SDK}/public.sdk/source/common/memorystream.cpp
  ${SDK}/public.sdk/source/vst/hosting/plugprovider.cpp
  ${SDK}/public.sdk/source/vst/utility/stringconvert.cpp)
target_link_libraries (plughost PRIVATE sdk_hosting nlohmann_json::nlohmann_json)
if (APPLE)
  target_sources (plughost PRIVATE src/gui_mac.mm ${SDK}/public.sdk/source/vst/hosting/module_mac.mm)
  set_source_files_properties (src/gui_mac.mm ${SDK}/public.sdk/source/vst/hosting/module_mac.mm PROPERTIES COMPILE_FLAGS -fobjc-arc)
  target_link_libraries (plughost PRIVATE "-framework Cocoa")
elseif (WIN32)
  target_sources (plughost PRIVATE src/gui_windows.cpp ${SDK}/public.sdk/source/vst/hosting/module_win32.cpp)
  target_link_libraries (plughost PRIVATE user32 ole32 avrt)
else ()
  find_package (X11 REQUIRED)
  target_sources (plughost PRIVATE src/gui_linux.cpp ${SDK}/public.sdk/source/vst/hosting/module_linux.cpp)
  target_link_libraries (plughost PRIVATE X11::X11 dl pthread)
endif ()
