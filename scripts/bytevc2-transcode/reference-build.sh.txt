#!/usr/bin/env bash
set -euo pipefail

# Build a minimal static FFmpeg with the ByteVC2 patch for the native host.
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ffmpeg_commit=f6e945886e17c2cf882143bd98222b1bd66ffe28
x264_commit=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
prefix="$work/x264-install"
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
case "$(uname -s)" in
  MINGW*|MSYS*) suffix=.exe; extra_ldflags=-static; cc_flags='--cc=clang --cxx=clang++'; export CC=clang CXX=clang++ ;;
  Darwin) suffix=; extra_ldflags=; cc_flags= ;;
  *) echo 'Unsupported platform' >&2; exit 1 ;;
esac

curl -fsSL "https://github.com/mirror/x264/archive/${x264_commit}.tar.gz" -o "$work/x264.tar.gz"
mkdir "$work/x264"
tar -xzf "$work/x264.tar.gz" -C "$work/x264" --strip-components=1
(cd "$work/x264" && ./configure --prefix="$prefix" --enable-static --disable-cli --disable-asm && make -j4 && make install)

curl -fsSL "https://codeload.github.com/jellyfin/jellyfin-ffmpeg/tar.gz/${ffmpeg_commit}" -o "$work/ffmpeg.tar.gz"
mkdir "$work/ffmpeg"
tar -xzf "$work/ffmpeg.tar.gz" -C "$work/ffmpeg" --strip-components=1
cd "$work/ffmpeg"
patch -p1 < "$root/vendor/bytevc2/0001-add-bvc2-decoder.patch"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
./configure --disable-everything --disable-doc --disable-debug --disable-autodetect --disable-asm \
  --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-static --disable-shared \
  --enable-protocol=file,pipe --enable-demuxer=mov --enable-muxer=mp4 \
  --enable-decoder=bvc2,aac --enable-encoder=libx264,aac --enable-libx264 \
  --enable-filter=scale,format,aresample --enable-gpl --enable-version3 \
  --pkg-config-flags=--static $cc_flags ${extra_ldflags:+--extra-ldflags=$extra_ldflags}
make -j4 "ffmpeg$suffix"
./ffmpeg$suffix -hide_banner -decoders 2>&1 | grep -q ' bvc2 '
./ffmpeg$suffix -hide_banner -encoders 2>&1 | grep -q ' libx264 '
mkdir -p "$root/build/bytevc2/$arch"
cp "ffmpeg$suffix" "$root/build/bytevc2/$arch/ffmpeg$suffix"
