#!/bin/sh
# Builds Ephemeris's shared frames for Linux (src/main.rs and getfd.c say what they are) into the cache, where the
# studio looks for them (app/frames.cjs): ephemeris-frames, the helper that makes the frame images, and getfd.node, the
# addon that takes them into a process. Needs Rust (cargo, with the ash and libc crates or the network to fetch them), a C
# compiler, and Node's headers (node_api.h, from the node on PATH).
#   native/frames/build.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="${EPHEMERIS_CACHE:-$HOME/.cache/ephemeris}/frames"
[ "$(uname)" = Linux ] || { echo "frames: Linux only"; exit 0; }
cargo build --release --manifest-path "$here/Cargo.toml" --target-dir "$here/target" ${CARGO_OFFLINE:+--offline}
inc="$(dirname "$(dirname "$(command -v node)")")/include/node"
[ -f "$inc/node_api.h" ] || { echo "frames: no node_api.h under $inc"; exit 1; }
mkdir -p "$out"
cc -shared -fPIC -O2 -I"$inc" "$here/getfd.c" -o "$out/getfd.node.new"
# (renamed into place: a process running now keeps the file it started from)
cp "$here/target/release/ephemeris-frames" "$out/ephemeris-frames.new"
mv -f "$out/ephemeris-frames.new" "$out/ephemeris-frames"
mv -f "$out/getfd.node.new" "$out/getfd.node"
echo "frames: $out/ephemeris-frames, $out/getfd.node"
