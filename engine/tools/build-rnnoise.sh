#!/bin/sh
# Build engine/native/rnnoise.dll (win-x64) from the classic xiph/rnnoise
# (model baked into src/rnn_data.c, commit bad0a75, BSD-licensed). Needs MinGW gcc.
# Usage: sh build-rnnoise.sh  (run from anywhere)
set -e
d=$(mktemp -d)
git clone https://github.com/xiph/rnnoise "$d"
git -C "$d" checkout bad0a75dcedeebf312cca2384b69d802e0ce191b
gcc -shared -O2 -I"$d/include" -DRNNOISE_EXPORT="__declspec(dllexport)" \
  -o "$(dirname "$0")/../native/rnnoise.dll" \
  "$d"/src/denoise.c "$d"/src/rnn.c "$d"/src/rnn_data.c "$d"/src/pitch.c \
  "$d"/src/kiss_fft.c "$d"/src/celt_lpc.c "$d"/src/rnn_reader.c \
  -Wl,--export-all-symbols
echo "built native/rnnoise.dll"
