#!/bin/bash
# the zero-copy spike: our Electron, hidden on a special workspace, importing the producer's buffers (run under the GPU lock)
# usage: zc-run.sh <tag> [MODE=tiled] [FRAMES=600] [DRAW=2d] [extra electron flags...]
set -u
Z=${ZC_DIR:-$(cd "$(dirname "$0")" && pwd)}   # (built here: producer/target, pidfd.node; results in out/)
TAG="$1"; shift
[[ "$TAG" =~ ^[a-z0-9-]+$ ]] || { echo "bad tag"; exit 2; }
MODE="${MODE:-tiled}"; FRAMES="${FRAMES:-600}"; DRAW="${DRAW:-2d}"; HEAVY="${HEAVY:-0}"; APPJS="${APPJS:-app/main.cjs}"
export HYPRLAND_INSTANCE_SIGNATURE=$(ls -t /run/user/1000/hypr/ | head -1)
WAS=$(hyprctl getoption misc:render_unfocused_fps | awk '/int:/ {print $2}')
hyprctl keyword misc:render_unfocused_fps 180 >/dev/null
trap 'hyprctl keyword misc:render_unfocused_fps "${WAS:-15}" >/dev/null' EXIT
rm -f -- "$Z/out/$TAG.json" "$Z/out/$TAG.png"; mkdir -p -- "$Z/out"
cat > "$Z/out/$TAG.sh" <<EOS
#!/bin/sh
exec env OUT='$Z/out/$TAG' PRODUCER='$Z/producer/target/release/producer' MODE='$MODE' FRAMES='$FRAMES' DRAW='$DRAW' HEAVY='$HEAVY' SPLIT='${SPLIT:-1}' /home/benjude/CodeProjects/electron/src/out/Release/electron '$Z/$APPJS' --ozone-platform=wayland $* > '$Z/out/$TAG.log' 2>&1
EOS
chmod +x "$Z/out/$TAG.sh"
hyprctl dispatch exec "[workspace special:ephzc silent; no_initial_focus on; suppress_event activate activatefocus; render_unfocused on] $Z/out/$TAG.sh" >/dev/null
for i in $(seq 1 120); do [ -s "$Z/out/$TAG.json" ] && break; sleep 1; done
sleep 1
grep -vE 'lsfg-vk|Unknown key' "$Z/out/$TAG.log" | grep -E 'FATAL|imported|import failed|send failed|failed|buffers|producer exit|worker|done:|report' | cut -c1-260 | head -30
