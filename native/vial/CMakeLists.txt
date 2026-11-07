# The pinned Vial sources, built as a Windows VST3 without the proprietary IPP or Firebase SDKs.
cmake_minimum_required (VERSION 3.25)
project (Vial CXX)
if (NOT WIN32 OR NOT MSVC)
  message (FATAL_ERROR "Use build.sh on Linux and macOS; this target uses Windows' MSVC toolchain.")
endif ()
set (CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set (CMAKE_CXX_STANDARD 14)
set (CMAKE_CXX_STANDARD_REQUIRED ON)
if (NOT EXISTS "${VITAL_SOURCE_DIR}/src/unity_build/plugin.cpp")
  message (FATAL_ERROR "VITAL_SOURCE_DIR must name the pinned, patched source (build.ps1 prepares it).")
endif ()
file (TO_CMAKE_PATH "${VITAL_SOURCE_DIR}" SRC)
set (JLC "${SRC}/plugin/JuceLibraryCode")
file (GLOB interfaces "${SRC}/src/unity_build/interface_*.cpp")
add_library (Vial SHARED
  ${SRC}/src/unity_build/common.cpp ${interfaces} ${SRC}/src/unity_build/plugin.cpp
  ${SRC}/src/unity_build/synthesis.cpp ${JLC}/BinaryData.cpp
  ${JLC}/include_juce_audio_plugin_client_utils.cpp ${JLC}/include_juce_audio_plugin_client_VST3.cpp)
foreach (module audio_basics audio_devices audio_formats audio_processors audio_utils core data_structures dsp events graphics gui_basics gui_extra opengl)
  target_sources (Vial PRIVATE ${JLC}/include_juce_${module}.cpp)
endforeach ()
foreach (dir third_party/JUCE/modules/juce_audio_processors/format_types/VST3_SDK plugin/JuceLibraryCode
  third_party/JUCE/modules third_party/JUCE/modules/juce_audio_plugin_client src/common src/common/wavetable
  src/interface/editor_components src/interface/editor_sections src/interface/look_and_feel src/interface/wavetable
  src/interface/wavetable/editors src/interface/wavetable/overlays src/plugin src/synthesis/synth_engine
  src/synthesis/effects src/synthesis/filters src/synthesis/framework src/synthesis/lookups
  src/synthesis/modulators src/synthesis/modules src/synthesis/producers src/synthesis/utilities third_party)
  target_include_directories (Vial PRIVATE "${SRC}/${dir}")
endforeach ()
target_compile_definitions (Vial PRIVATE
  _CRT_SECURE_NO_WARNINGS WIN32 _WINDOWS NOMINMAX _ENABLE_EXTENDED_ALIGNED_STORAGE __SSE2__=1
  WINVER=0x0A00 _WIN32_WINNT=0x0A00 NO_AUTH=1 JUCE_OPENGL3=1 JUCE_APP_VERSION=1.0.6 JUCE_APP_VERSION_HEX=0x10006
  JucePlugin_Build_VST=0 JucePlugin_Build_VST3=1 JucePlugin_Build_AU=0 JucePlugin_Build_AUv3=0
  JucePlugin_Build_RTAS=0 JucePlugin_Build_AAX=0 JucePlugin_Build_Standalone=0 JucePlugin_Build_Unity=0
  JUCE_VST3_CAN_REPLACE_VST2=0)
target_compile_options (Vial PRIVATE /bigobj /utf-8 /fp:fast)
target_link_libraries (Vial PRIVATE wininet version comdlg32 shlwapi rpcrt4 winmm imm32 ole32 oleaut32 uuid ws2_32 opengl32)
set_target_properties (Vial PROPERTIES PREFIX "" SUFFIX ".vst3")
