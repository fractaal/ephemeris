#!/bin/bash
# run.sh <label> <renderer GPU> <host Vulkan driver, nvidia|radeon|""> <x11|wayland> [extra host flags] [w] [h]: one combination
D=$(dirname "$(readlink -f "$0")"); L=$1; G=$2; HV=$3; B=$4; X=$5; W=${6:-1920}; H=${7:-1080}
export XDG_RUNTIME_DIR=/run/user/1000 ELECTRON=$D/../../../node_modules/electron/dist/electron
[ "$B" = x11 ] && export DISPLAY=:0 && unset WAYLAND_DISPLAY; [ "$B" = wayland ] && export WAYLAND_DISPLAY=wayland-1
export HOST_FLAGS="--enable-features=Vulkan --use-angle=vulkan --enable-gpu --ignore-gpu-blocklist --disable-gpu-watchdog --ozone-platform=$B $X"
[ -n "$HV" ] && export HOST_VK=/usr/share/vulkan/icd.d/${HV}_icd.json
echo "=== $L"; timeout 150 $D/target/release/dom-textures --gpu "$G" --seeks ${SEEKS:-60} --w $W --h $H --out $D/out/$L 2>&1 | grep -vE "^adapter:|lsfg" | cut -c1-290
