#!/usr/bin/env bash
# Reproducible, source-built LGPL decoder. Run in the dedicated GitHub job.
set -euo pipefail
: "${GITHUB_ACTIONS:?Build decoder in GitHub Actions}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_BUILD_DIR="${RUNNER_TEMP:?}/hongguo-hevc-wasm"
WASM_OUT="$ROOT_DIR/desktop/wasm-runtime"
FFMPEG_COMMIT=894da5ca7d742e4429ffb2af534fcda0103ef593
mkdir -p "$WASM_BUILD_DIR" "$WASM_OUT"
cd "$WASM_BUILD_DIR"
curl -fL --retry 3 "https://github.com/FFmpeg/FFmpeg/archive/$FFMPEG_COMMIT.tar.gz" -o ffmpeg.tar.gz
mkdir -p ffmpeg
tar -xzf ffmpeg.tar.gz -C ffmpeg --strip-components=1
cd ffmpeg
emconfigure ./configure --prefix="$WASM_BUILD_DIR/install" --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --enable-cross-compile --target-os=none --arch=wasm32 --disable-asm --disable-x86asm --disable-runtime-cpudetect \
  --disable-autodetect --disable-network --disable-programs --disable-doc --disable-debug --disable-everything \
  --disable-pthreads --disable-w32threads --disable-os2threads --disable-avdevice --disable-avfilter \
  --enable-avformat --enable-avcodec --enable-avutil --enable-swscale --enable-swresample \
  --enable-demuxer=mov --enable-decoder=hevc,h264,aac --enable-parser=hevc,h264,aac \
  --extra-cflags='-O3 -msimd128' --extra-ldflags='-O3 -msimd128'
emmake make -j4
emmake make install
emcc "$ROOT_DIR/desktop/wasm/decoder.c" -I"$WASM_BUILD_DIR/install/include" \
  -L"$WASM_BUILD_DIR/install/lib" -lavformat -lavcodec -lswscale -lswresample -lavutil -lm \
  -O3 -msimd128 -sMODULARIZE=1 -sEXPORT_NAME=HongguoWasmDecoder -sENVIRONMENT=worker \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 -sFILESYSTEM=0 -sASSERTIONS=0 -sINVOKE_RUN=0 -o "$WASM_OUT/decoder.js"
cp COPYING.LGPLv2.1 "$WASM_OUT/FFmpeg-LICENSE.txt"
cat > "$WASM_OUT/NOTICE.txt" <<NOTICE
FFmpeg n8.0.1, commit $FFMPEG_COMMIT, LGPL-2.1-or-later.
Source: https://github.com/FFmpeg/FFmpeg/tree/$FFMPEG_COMMIT
Build and application wrapper: desktop/wasm/decoder.c and scripts/build_windows_wasm.sh in the corresponding application source revision.
No GPL, nonfree, external codecs, network protocols, or extracted third-party binaries.
NOTICE
# Preserve the exact source, wrapper and linkable objects for redistribution/relinking.
cp "$ROOT_DIR/desktop/wasm/decoder.c" "$WASM_BUILD_DIR/decoder.c"
emcc -c "$WASM_BUILD_DIR/decoder.c" -I"$WASM_BUILD_DIR/install/include" -O3 -msimd128 -o "$WASM_BUILD_DIR/decoder.o"
tar -czf "$WASM_BUILD_DIR/lgpl-relink.tar.gz" -C "$WASM_BUILD_DIR" ffmpeg.tar.gz decoder.c decoder.o install/lib
sha256sum "$WASM_OUT/decoder.js" "$WASM_OUT/decoder.wasm"
