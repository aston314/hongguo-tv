#!/usr/bin/env bash
# Experimental standalone decoder; never replaces the app's pinned libmpv.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
output=${1:?Usage: build_android.sh OUTPUT_DIRECTORY}
mkdir -p "$output"
output=$(cd "$output" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
commit=f6e945886e17c2cf882143bd98222b1bd66ffe28
archive_sha=05ed62f673ab735cf798870cd3eb31f3588286194fa4f000f2279e21059fd7d1
ndk="${ANDROID_HOME:?}/ndk/27.2.12479018"
toolchain="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
curl --fail --location --retry 4 "https://codeload.github.com/jellyfin/jellyfin-ffmpeg/tar.gz/$commit" -o "$work/ffmpeg.tar.gz"
echo "$archive_sha  $work/ffmpeg.tar.gz" | sha256sum --check --status
mkdir "$work/source"
tar -xzf "$work/ffmpeg.tar.gz" -C "$work/source" --strip-components=1
cd "$work/source"
patch --batch --fuzz=0 -p1 < "$root/scripts/bytevc2/0001-add-bvc2-decoder.patch"
# Enable VVC too so architecture-specific VVC DSP objects are included. Keep
# assembly/NEON enabled; the desktop reference disables assembly globally.
./configure --target-os=android --arch=aarch64 --cpu=armv8-a \
  --enable-cross-compile --cc="$toolchain/aarch64-linux-android23-clang" \
  --cxx="$toolchain/aarch64-linux-android23-clang++" \
  --ar="$toolchain/llvm-ar" --nm="$toolchain/llvm-nm" \
  --ranlib="$toolchain/llvm-ranlib" --strip="$toolchain/llvm-strip" \
  --disable-everything --disable-doc --disable-debug --disable-autodetect \
  --disable-network --disable-avdevice --disable-ffplay \
  --enable-ffmpeg --enable-ffprobe --enable-static --disable-shared \
  --enable-gpl --enable-version3 --enable-pthreads \
  --enable-protocol=file,pipe --enable-demuxer=mov \
  --enable-decoder=bvc2,vvc,hevc,h264,aac \
  --enable-parser=vvc,hevc,h264,aac \
  --enable-encoder=wrapped_avframe,rawvideo,ppm \
  --enable-muxer=null,framemd5,image2 \
  --enable-filter=null,format,scale --enable-swscale
make -j"$(nproc)" ffmpeg ffprobe
mkdir -p "$output/bin" "$output/source"
cp ffmpeg ffprobe "$output/bin/"
"$toolchain/llvm-strip" "$output/bin/ffmpeg" "$output/bin/ffprobe"
"$toolchain/llvm-readelf" -h "$output/bin/ffmpeg" | tee "$output/ELF.txt"
"$toolchain/llvm-readelf" -d "$output/bin/ffmpeg" >> "$output/ELF.txt"
# Ship the complete pinned upstream source and the exact patch/build script
# together with the experiment's binaries. No app, credentials, or media.
cp "$work/ffmpeg.tar.gz" "$output/source/ffmpeg-$commit.tar.gz"
cp "$root/scripts/bytevc2/0001-add-bvc2-decoder.patch" "$output/source/"
cp "$root/scripts/bytevc2/build_android.sh" "$output/source/"
cp COPYING.GPLv3 COPYING.LGPLv2.1 "$output/source/"
cp config.h ffbuild/config.mak "$output/source/"
cat > "$output/BUILD.txt" <<EOF
Experimental standalone Android arm64 ByteVC2 decoder; not an app update.
FFmpeg: jellyfin/jellyfin-ffmpeg $commit (8.1.3)
FFmpeg archive SHA256: $archive_sha
Patch: zfdang/hongguo-open-player 36316dcbe35aa05cfa0176036e56edba17188567
Original patch: wxyzh/ffmpeg-bvc2 04f87d26d67162c0f73c3d9bd1870fd5900f3aee
NDK: 27.2.12479018; API: 23; ABI: arm64-v8a
Assembly: enabled; GPL/version3: enabled; network: disabled
Scope: actual decode and seek/throughput testing; no GPU/audio output test.
Repository commit: ${GITHUB_SHA:-local-source-only}
EOF
cd "$output"
find bin source -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt
