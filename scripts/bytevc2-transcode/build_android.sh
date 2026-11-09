#!/usr/bin/env bash
# Isolated Android transcoder experiment; only runs in GitHub Actions.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true || { echo 'Build this experiment in GitHub Actions' >&2; exit 1; }
root=$(cd "$(dirname "$0")/../.." && pwd)
output=${1:?Usage: build_android.sh OUTPUT reference-or-optimized}
variant=${2:?Choose reference or optimized}
case "$variant" in reference|optimized) ;; *) exit 2 ;; esac
mkdir -p "$output"
output=$(cd "$output" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ffmpeg_commit=f6e945886e17c2cf882143bd98222b1bd66ffe28
x264_commit=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
ffmpeg_sha=05ed62f673ab735cf798870cd3eb31f3588286194fa4f000f2279e21059fd7d1
x264_sha=cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9
toolchain="${ANDROID_HOME:?}/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64"
export CC="$toolchain/bin/aarch64-linux-android23-clang"
export CXX="$toolchain/bin/aarch64-linux-android23-clang++"
export AR="$toolchain/bin/llvm-ar" RANLIB="$toolchain/bin/llvm-ranlib"
export STRIP="$toolchain/bin/llvm-strip"
export CFLAGS='-O2 -fPIC' LDFLAGS='-Wl,-z,max-page-size=16384'
prefix="$work/prefix"
curl --fail --location --retry 4 "https://codeload.github.com/mirror/x264/tar.gz/$x264_commit" -o "$work/x264.tar.gz"
curl --fail --location --retry 4 "https://codeload.github.com/jellyfin/jellyfin-ffmpeg/tar.gz/$ffmpeg_commit" -o "$work/ffmpeg.tar.gz"
echo "$x264_sha  $work/x264.tar.gz" | sha256sum --check --status
echo "$ffmpeg_sha  $work/ffmpeg.tar.gz" | sha256sum --check --status
mkdir "$work/x264" "$work/ffmpeg"
tar -xzf "$work/x264.tar.gz" -C "$work/x264" --strip-components=1
tar -xzf "$work/ffmpeg.tar.gz" -C "$work/ffmpeg" --strip-components=1
asm=()
decoders=bvc2,aac
if [ "$variant" = reference ]; then
  # Preserve the reference's global assembly-disabled build as a baseline.
  asm=(--disable-asm)
else
  # VVC enables the ARM VVC DSP objects reused by the BVC2 decoder.
  decoders=bvc2,vvc,aac
fi
(
  cd "$work/x264"
  ./configure --host=aarch64-linux-android --prefix="$prefix" \
    --sysroot="$toolchain/sysroot" --enable-static --disable-cli --enable-pic \
    --disable-opencl "${asm[@]}"
  make -j"$(nproc)"
  make install
)
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
(
  cd "$work/ffmpeg"
  patch --batch --fuzz=0 -p1 < "$root/scripts/bytevc2-transcode/0001-add-bvc2-decoder.patch"
  # Android samples use hvc1+bv2C; the previous experiment proved default HEVC
  # identification is wrong. This identifies the codec, not a playback tuning.
  patch --batch --fuzz=0 -p1 < "$root/scripts/bytevc2-transcode/0002-identify-bv2c.patch"
  ./configure --target-os=android --arch=aarch64 --cpu=armv8-a --enable-cross-compile \
    --cc="$CC" --cxx="$CXX" --ar="$AR" --nm="$toolchain/bin/llvm-nm" \
    --ranlib="$RANLIB" --strip="$STRIP" --prefix="$prefix" \
    --disable-everything --disable-doc --disable-debug --disable-autodetect "${asm[@]}" \
    --disable-network --disable-avdevice --disable-ffplay --enable-ffmpeg --enable-ffprobe \
    --enable-static --disable-shared --enable-pic --enable-pthreads \
    --enable-protocol=file,pipe --enable-demuxer=mov --enable-muxer=mp4 \
    --enable-decoder="$decoders" --enable-encoder=libx264,aac --enable-libx264 \
    --enable-filter=scale,format,aresample --enable-swscale --enable-swresample \
    --enable-gpl --enable-version3 --pkg-config-flags=--static \
    --extra-cflags='-O2 -fPIC' --extra-ldflags='-Wl,-z,max-page-size=16384'
  make -j"$(nproc)" ffmpeg ffprobe
)
mkdir -p "$output/bin" "$output/source"
cp "$work/ffmpeg/ffmpeg" "$work/ffmpeg/ffprobe" "$output/bin/"
"$STRIP" --strip-unneeded "$output/bin/ffmpeg" "$output/bin/ffprobe"
"$toolchain/bin/llvm-readelf" -d "$output/bin/ffmpeg" > "$output/ELF.txt"
cp "$work/ffmpeg.tar.gz" "$work/x264.tar.gz" "$output/source/"
cp "$root/scripts/bytevc2-transcode/"*.patch "$root/scripts/bytevc2-transcode/build_android.sh" "$output/source/"
cp "$work/ffmpeg/config.h" "$work/ffmpeg/config_components.h" "$work/ffmpeg/ffbuild/config.mak" "$output/source/"
cp "$work/x264/config.h" "$output/source/x264-config.h"
cp "$work/x264/config.mak" "$output/source/x264-config.mak"
cp "$work/ffmpeg/COPYING.GPLv3" "$work/x264/COPYING" "$output/source/"
cat > "$output/BUILD.txt" <<EOF
Independent ByteVC2 -> H.264 Android transcoder; not a production application.
Variant: $variant; NDK 27.2.12479018/API23; arm64-v8a; GPLv3.
FFmpeg: $ffmpeg_commit; x264: $x264_commit.
Reference: zfdang/hongguo-open-player 36316dcbe35aa05cfa0176036e56edba17188567.
Same x264 ultrafast/CRF25 and AAC conversion are selected by runtime arguments.
The reference variant disables assembly, as the reference build does.
The optimized variant enables ARM assembly and VVC DSP; measured separately.
bv2C atom identification added for the already-confirmed Android hvc1 samples.
Repository commit: $GITHUB_SHA
EOF
cd "$output"
find bin source -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt
