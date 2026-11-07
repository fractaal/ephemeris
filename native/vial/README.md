# Vial

[Vital](https://vital.audio) is Matt Tytel's wavetable synth. Its source is open under the GPLv3
([github.com/mtytel/vital](https://github.com/mtytel/vital)); its open-source build is named Vial. Vial is the studio's
synth: Ephemeris plays it as a plugin instrument (`tools/plugins.mjs`), like any VST3, and the app ships it.

`build.sh` fetches Vital's source at a pinned commit, applies `vital.patch`, and builds the VST3 into
`~/.cache/ephemeris/plugins/`, where a checkout finds it and the app's build takes it from (`app/build.mjs`):

    native/vial/build.sh

The build leaves out Vital's online sign-in (it crashes on Linux, and Ephemeris needs none) and VST2. On Linux it needs
make, a C++ compiler, and the ALSA, freetype, curl, GL, X11 and libsecret headers; on macOS, Apple's command line tools
(Vital's own Mac build is an Xcode project: `build.sh` compiles its sources with clang instead).

On Windows x64, `powershell -NoProfile -ExecutionPolicy Bypass -File native/vial/build.ps1` uses Visual Studio Build
Tools (Desktop development with C++, CMake and a Windows SDK). It reads the same source pin and applies the same
patch as `build.sh`. `CMakeLists.txt` compiles the unity sources and JUCE modules without the proprietary IPP and
Firebase dependencies of Vital's old Visual Studio project. The C++ runtime is linked statically; the plugin is kept
as `plugins/Vial.vst3/Contents/x86_64-win/Vial.vst3` in the cache. `EPHEMERIS_CACHE` overrides the cache location on
all platforms.

Presets: the studio's own Vial presets are in `assets/presets/Vial/`; other `.vital` files come from the preset folders
of the studio's settings (`tools/presets.mjs`), and one picked there is copied into the film's project. No third-party
presets are in this repo or the app. Vial's own browser reads a data folder the studio makes of links to the preset
folders (and their wavetables): it points Vial's config (`data_directory`) at it.

Licence: Vial is Vital's code under the GPLv3. The app ships it with the GPLv3's text and where its source is (the
pinned commit and `vital.patch`: `bin/NOTICE.md` in the app). Vital's README asks that a build not be named Vital, not
connect to vital.audio, and not include the presets of Vital's free version.
