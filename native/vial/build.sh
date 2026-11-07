#!/bin/sh
# Builds Vial, the open-source build of Vital (Matt Tytel's wavetable synth, GPLv3: github.com/mtytel/vital) and the
# studio's synth, as a VST3 into the cache's plugins folder, where a checkout finds it (tools/plugins.mjs pluginFolders)
# and the app's build takes it from (app/build.mjs). It fetches Vital's source at a pinned commit and builds it here.
# Its online sign-in is left out (NO_AUTH: it crashes on Linux, and Ephemeris needs none), and so is VST2 (its SDK is
# not public); vital.patch fixes three parameters whose choice names were too few for their range.
#   native/vial/build.sh           (Linux: needs make, a C++ compiler, and the ALSA, freetype, curl, GL, X11 and
#                                   libsecret headers; macOS: Apple's command line tools)
set -e
here=$(cd "$(dirname "$0")" && pwd)
cache="${EPHEMERIS_CACHE:-$HOME/.cache/ephemeris}"
src="$cache/vital-src"
commit=636ca0ef517a4db087a6a08a6a8a5e704e21f836
[ -d "$src/.git" ] || git clone https://github.com/mtytel/vital.git "$src"
git -C "$src" fetch -q origin "$commit" 2>/dev/null || true
git -C "$src" checkout -q -f "$commit"
git -C "$src" apply "$here/vital.patch"
case "$(uname)" in
  Linux)
    make -C "$src/plugin/builds/linux_vst" -j"$(nproc)" CONFIG=Release CPPFLAGS="-DNO_AUTH=1 -DJUCE_VST3_CAN_REPLACE_VST2=0" VST3
    mkdir -p "$cache/plugins"
    rm -rf "$cache/plugins/Vial.vst3"
    cp -r "$src/plugin/builds/linux_vst/build/Vial.vst3" "$cache/plugins/"
    ;;
  Darwin)
    # (Vital's Mac build is an Xcode project; without Xcode its translation units, the ones its Linux Makefile builds
    # with JUCE's Objective-C++ modules in place of its C++ ones, are compiled here by the command line tools' clang,
    # a few at once, and linked into a VST3 bundle by hand)
    b="$src/plugin/builds/macos"
    rm -rf "$b"; mkdir -p "$b/obj"
    jlc="$src/plugin/JuceLibraryCode"
    set -- "$src"/src/unity_build/common.cpp "$src"/src/unity_build/interface_*.cpp "$src"/src/unity_build/plugin.cpp \
      "$src"/src/unity_build/synthesis.cpp "$jlc/BinaryData.cpp" "$jlc/include_juce_audio_plugin_client_utils.cpp" \
      "$jlc/include_juce_audio_plugin_client_VST3.cpp" "$jlc/include_juce_audio_plugin_client_VST_utils.mm"
    for m in audio_basics audio_devices audio_formats audio_processors audio_utils core data_structures dsp events \
      graphics gui_basics gui_extra opengl; do set -- "$@" "$jlc/include_juce_$m.mm"; done
    inc=""
    for d in third_party/JUCE/modules/juce_audio_processors/format_types/VST3_SDK plugin/JuceLibraryCode \
      third_party/JUCE/modules third_party/JUCE/modules/juce_audio_plugin_client src/common src/common/wavetable \
      src/interface/editor_components src/interface/editor_sections src/interface/look_and_feel src/interface/wavetable \
      src/interface/wavetable/editors src/interface/wavetable/overlays src/plugin src/synthesis/synth_engine \
      src/synthesis/effects src/synthesis/filters src/synthesis/framework src/synthesis/lookups \
      src/synthesis/modulators src/synthesis/modules src/synthesis/producers src/synthesis/utilities third_party; do
      inc="$inc -I$src/$d"
    done
    export VIAL_CXXFLAGS="-std=c++14 -O3 -ffast-math -fvisibility=hidden -fvisibility-inlines-hidden -mmacosx-version-min=11.0 -w
      -DNDEBUG=1 -D_NDEBUG=1 -DNO_AUTH=1 -DJUCE_OPENGL3=1 -DJUCE_APP_VERSION=1.0.6 -DJUCE_APP_VERSION_HEX=0x10006
      -DJucePlugin_Build_VST=0 -DJucePlugin_Build_VST3=1 -DJucePlugin_Build_AU=0 -DJucePlugin_Build_AUv3=0
      -DJucePlugin_Build_RTAS=0 -DJucePlugin_Build_AAX=0 -DJucePlugin_Build_Standalone=0 -DJucePlugin_Build_Unity=0
      -DJUCE_VST3_CAN_REPLACE_VST2=0 $inc" VIAL_OBJ="$b/obj"
    printf '%s\n' "$@" | xargs -P "$(sysctl -n hw.ncpu)" -n 1 sh -c '
      f="$1"; o="$VIAL_OBJ/$(basename "${f%.*}").o"
      case "$f" in *.mm) lang=objective-c++ ;; *) lang=c++ ;; esac
      echo "compiling $(basename "$f")"
      clang++ -x $lang $VIAL_CXXFLAGS -c "$f" -o "$o" || exit 255' sh
    out="$b/Vial.vst3"
    mkdir -p "$out/Contents/MacOS"
    fw=""
    for f in Accelerate AudioToolbox AudioUnit AVFoundation Carbon Cocoa CoreAudio CoreAudioKit CoreMIDI CoreServices \
      DiscRecording Foundation IOKit OpenGL QuartzCore Security WebKit; do fw="$fw -framework $f"; done
    clang++ -bundle -mmacosx-version-min=11.0 -o "$out/Contents/MacOS/Vial" "$b"/obj/*.o $fw
    sed 's/\${EXECUTABLE_NAME}/Vial/' "$src/plugin/builds/osx/Info-VST3.plist" > "$out/Contents/Info.plist"
    printf 'BNDL????' > "$out/Contents/PkgInfo"
    codesign --force --sign - "$out" >/dev/null 2>&1 || true   # (ad hoc: Apple silicon loads only signed code)
    mkdir -p "$cache/plugins"
    rm -rf "$cache/plugins/Vial.vst3"
    cp -R "$out" "$cache/plugins/"
    ;;
  *) echo "native/vial: building Vial here is not set up yet (Linux and macOS)"; exit 1 ;;
esac
echo "Vial: $cache/plugins/Vial.vst3"
