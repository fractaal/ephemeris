#!/bin/sh
# Builds plughost, Ephemeris's plugin host (src/main.cpp says what it is), into the cache, where the studio and renders
# look for it (tools/plugins.mjs plughostPath). Needs cmake, git and a C++17 compiler (on a Mac, Apple's command line
# tools are enough); on Linux, the X11 headers. It
# fetches the VST3 SDK (MIT) and nlohmann/json (MIT) at pinned versions.
#   native/plughost/build.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="${EPHEMERIS_CACHE:-$HOME/.cache/ephemeris}/plughost"
gen=""
command -v ninja >/dev/null 2>&1 && gen="-G Ninja"
# (a Mac with Apple's command line tools and no Xcode: the VST3 SDK asks xcodebuild for Xcode's version, which they do not
# have; their compiler's version is given in its place)
xcode=""
if [ "$(uname)" = Darwin ] && ! xcodebuild -version >/dev/null 2>&1; then
  XCODE_VERSION=$(clang --version | sed -n 's/.*clang version \([0-9][0-9]*\).*/\1/p' | head -1); export XCODE_VERSION
  xcode="-DXCODE_VERSION=$XCODE_VERSION"
fi
cmake -S "$here" -B "$here/build" -DCMAKE_BUILD_TYPE=Release $gen $xcode
cmake --build "$here/build" --parallel
mkdir -p "$out"
# (renamed into place: a host playing now keeps the file it started from, the next one starts this)
cp "$here/build/plughost" "$out/plughost.new" && mv -f "$out/plughost.new" "$out/plughost"
# (with the licences of what it is built with: the app ships them beside it, app/build.mjs)
cp "$here/build/_deps/vst3sdk-src/LICENSE.txt" "$out/vst3sdk-LICENSE.txt"
cp "$here/build/_deps/json-src/LICENSE.MIT" "$out/json-LICENSE.txt"
echo "plughost: $out/plughost"
