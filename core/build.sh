#!/usr/bin/env bash
# Build core/dist/core.mjs + core.wasm with Emscripten. Run from anywhere (Git Bash):
#   bash core/build.sh
# EMSDK_DIR overrides where emsdk lives (default $HOME/tools/emsdk).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMSDK_DIR="${EMSDK_DIR:-$HOME/tools/emsdk}"

if ! command -v em++ >/dev/null 2>&1; then
    if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
        echo "emsdk not found at $EMSDK_DIR (set EMSDK_DIR)" >&2
        exit 1
    fi
    # emsdk's sh wrapper looks for python/<ver>/bin/python3, but on Windows it is python/<ver>/python.exe
    if [ -z "${EMSDK_PYTHON:-}" ]; then
        for py in "$EMSDK_DIR"/python/*/python.exe "$EMSDK_DIR"/python/*/bin/python3; do
            if [ -f "$py" ]; then export EMSDK_PYTHON="$py"; break; fi
        done
    fi
    # shellcheck disable=SC1091
    EMSDK_QUIET=1 source "$EMSDK_DIR/emsdk_env.sh" >/dev/null
fi

mkdir -p "$HERE/dist"
cd "$HERE"
em++ -std=c++20 -O2 -fno-exceptions -Wall -Wextra \
    src/api.cpp src/json.cpp src/murmur3.cpp src/plan_api.cpp src/plan_final.cpp src/plan_heur.cpp src/plan_joint.cpp src/plan_lanes.cpp src/plan_merge.cpp src/plan_long.cpp src/plan_model.cpp src/plan_out.cpp src/plan_rebuild.cpp src/plan_scan.cpp src/plan_search.cpp src/plan_split.cpp src/recovery.cpp src/seedmath.cpp \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCore \
    -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH=1 \
    -sEXPORTED_FUNCTIONS=_st_call,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=stringToNewUTF8,UTF8ToString \
    -o dist/core.mjs
echo "built core/dist/core.mjs + core.wasm"
