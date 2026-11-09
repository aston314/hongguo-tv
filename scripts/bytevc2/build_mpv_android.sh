#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true || { echo "Build Android experiments in GitHub Actions" >&2; exit 1; }
root=$(cd "$(dirname "$0")/../.." && pwd)
output=${1:?Usage: build_mpv_android.sh OUTPUT_DIRECTORY [arm64-v8a|armeabi-v7a]}
abi=${2:-arm64-v8a}
case "$abi" in
  arm64-v8a) target=aarch64-linux-android; cpu_family=aarch64; cpu=armv8-a; arch=aarch64; host=aarch64-linux-android; abi_cflags=() ;;
  armeabi-v7a) target=armv7a-linux-androideabi; cpu_family=arm; cpu=armv7-a; arch=arm; host=arm-linux-androideabi; abi_cflags=(--extra-cflags='-O2 -fPIC -march=armv7-a -mfpu=neon -mfloat-abi=softfp') ;;
  *) echo "Unsupported experiment ABI" >&2; exit 2 ;;
esac
mkdir -p "$output"
output=$(cd "$output" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 "$root/scripts/bytevc2/prepare_mpv_sources.py" "$work/src" "$output/source"
prefix="$work/prefix"
mkdir -p "$prefix"
toolchain="${ANDROID_HOME:?}/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin"
export CC="$toolchain/${target}23-clang"
export CXX="$toolchain/${target}23-clang++"
export AR="$toolchain/llvm-ar" RANLIB="$toolchain/llvm-ranlib"
export STRIP="$toolchain/llvm-strip"
export CFLAGS='-O2 -fPIC' CXXFLAGS='-O2 -fPIC'
export LDFLAGS='-Wl,-z,max-page-size=16384'
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
cross="$work/android.cross"
cat > "$cross" <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$AR'
strip = '$STRIP'
pkg-config = 'pkg-config'
[host_machine]
system = 'android'
cpu_family = '$cpu_family'
cpu = '$cpu'
endian = 'little'
[properties]
needs_exe_wrapper = true
[built-in options]
c_args = ['-O2', '-fPIC']
cpp_args = ['-O2', '-fPIC']
c_link_args = ['-Wl,-z,max-page-size=16384', '-lc++_static', '-lc++abi']
cpp_link_args = ['-Wl,-z,max-page-size=16384', '-static-libstdc++']
EOF
meson_install() {
  local name=$1; shift
  local library=static
  if [ "$name" = mpv ]; then library=shared; fi
  meson setup "$work/$name-build" "$work/src/$name" --cross-file "$cross" \
    --prefix "$prefix" --libdir lib --buildtype release --default-library "$library" \
    --wrap-mode nodownload "$@"
  ninja -C "$work/$name-build" -j"$(nproc)"
  ninja -C "$work/$name-build" install
}
# No external font engines or shader toolchains are needed by the retained
# Android vo=gpu path. libplacebo is still a mandatory modern MPV dependency.
rmdir "$work/src/freetype/subprojects/dlg"
mv "$work/src/dlg" "$work/src/freetype/subprojects/dlg"
meson_install freetype -Dzlib=disabled -Dbzip2=disabled -Dpng=disabled -Dharfbuzz=disabled -Dbrotli=disabled
meson_install fribidi -Dtests=false -Ddocs=false
meson_install harfbuzz -Dtests=disabled -Ddocs=disabled -Dglib=disabled -Dgobject=disabled -Dicu=disabled -Dfreetype=enabled
(
  cd "$work/src/libass"
  ./autogen.sh
  ./configure --host="$host" --prefix="$prefix" --libdir="$prefix/lib" \
    --disable-shared --enable-static --with-pic --disable-asm --disable-fontconfig \
    --disable-require-system-font-provider
  make -j"$(nproc)"
  make install
)
rmdir "$work/src/libplacebo/3rdparty/fast_float"
mv "$work/src/fast_float" "$work/src/libplacebo/3rdparty/fast_float"
meson_install libplacebo -Ddemos=false -Dtests=false -Dvulkan=disabled -Dopengl=disabled \
  -Dd3d11=disabled -Dshaderc=disabled -Dglslang=disabled -Dlcms=disabled \
  -Dlibdovi=disabled -Ddovi=disabled -Dxxhash=disabled -Dunwind=disabled
(
  cd "$work/src/ffmpeg"
  patch --batch --fuzz=0 -p1 < "$root/scripts/bytevc2/0001-add-bvc2-decoder.patch"
  patch --batch --fuzz=0 -p1 < "$root/scripts/bytevc2/0002-identify-bv2c.patch"
  ./configure --prefix="$prefix" --libdir="$prefix/lib" --target-os=android --arch="$arch" --cpu="$cpu" \
    --enable-cross-compile --cc="$CC" --cxx="$CXX" --ar="$AR" \
    --nm="$toolchain/llvm-nm" --ranlib="$RANLIB" --strip="$STRIP" \
    --disable-everything --disable-doc --disable-debug --disable-autodetect \
    --enable-gpl --enable-version3 --enable-static --disable-shared --enable-pic \
    --disable-programs --disable-avdevice --disable-vulkan \
    --enable-pthreads --enable-jni --enable-mediacodec \
    --enable-network --enable-protocol=file,http,tcp,pipe \
    --enable-demuxer=mov,mpegts,hls,aac --enable-parser=vvc,hevc,h264,aac \
    --enable-decoder='bvc2,vvc,hevc*,h264*,aac' \
    --enable-filter=abuffer,abuffersink,buffer,buffersink,anull,aresample,aformat,atempo,format,scale,volume \
    --enable-swscale --enable-swresample --enable-avfilter \
    "${abi_cflags[@]}" --extra-ldflags='-Wl,-z,max-page-size=16384'
  make -j"$(nproc)"
  make install
)
# Retain the app's established JNI contract when replacing media-kit's mpv.
python3 - "$work/src/mpv" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
header = root / 'include/mpv/client.h'
text = header.read_text()
needle = 'MPV_EXPORT void mpv_wakeup(mpv_handle *ctx);'
assert text.count(needle) == 1
header.write_text(text.replace(needle, needle + '\nMPV_EXPORT int mpv_lavc_set_java_vm(void *vm);'))
client = root / 'player/client.c'
text = client.read_text()
text += '\n#include <libavcodec/jni.h>\nint mpv_lavc_set_java_vm(void *vm) { return av_jni_set_java_vm(vm, NULL); }\n'
client.write_text(text)
PY
meson_install mpv -Dauto_features=disabled -Dgpl=true -Dlibmpv=true -Dcplayer=false \
  -Dlua=disabled -Dgl=enabled -Degl-android=enabled -Daudiotrack=enabled -Dopensles=enabled \
  -Dvector=enabled -Dbuild-date=false -Dmanpage-build=disabled
mkdir -p "$output/lib/$abi" "$output/include/mpv"
cp -L "$prefix/lib/libmpv.so" "$output/lib/$abi/libmpv.so"
"$STRIP" --strip-unneeded "$output/lib/$abi/libmpv.so"
cp "$prefix/include/mpv/"*.h "$output/include/mpv/"
"$toolchain/llvm-readelf" -Ws "$output/lib/$abi/libmpv.so" | grep 'mpv_lavc_set_java_vm'
"$toolchain/llvm-readelf" -d "$output/lib/$abi/libmpv.so" | tee "$output/ELF.txt"
cp "$root/scripts/bytevc2/"*.patch "$root/scripts/bytevc2/build_mpv_android.sh" \
  "$root/scripts/bytevc2/prepare_mpv_sources.py" "$output/source/"
cp "$cross" "$output/source/android.cross"
cp "$work/src/ffmpeg/config.h" "$work/src/ffmpeg/config_components.h" "$output/source/"
cp "$work/mpv-build/config.h" "$output/source/mpv-config.h"
cat > "$output/BUILD.txt" <<EOF
Isolated $abi Android MPV ByteVC2 experiment; not a stable application update.
MPV 0.41.0; FFmpeg 8.1.3 + BVC2 decoder + bv2C identification.
NDK 27.2.12479018/API23; GPL build; vo=gpu/Android EGL; AudioTrack/OpenSL ES.
HTTP/file input; no direct HTTPS (the app uses its existing loopback media proxy).
Repository commit: ${GITHUB_SHA:-local-source-only}
EOF
cd "$output"
find lib include source -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt
