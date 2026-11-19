#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build_playback_resolver.sh core/cmd/hongguotv/resolver-probe-assets/resolver.wasm
export HONGGUO_RESOLVER_WASM_FILE="$PWD/core/cmd/hongguotv/resolver-probe-assets/resolver.wasm"
go test ./core/cmd/hongguotv -run 'TestWASMPlaybackResolver' -count=1
go test -tags resolverprobe ./core/cmd/hongguotv -run '^$'
toolchain="${ANDROID_HOME:?}/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin"
for abi in arm64-v8a armeabi-v7a; do
  if [[ "$abi" == arm64-v8a ]]; then
    arch=arm64; compiler=aarch64-linux-android23-clang
  else
    arch=arm; compiler=armv7a-linux-androideabi23-clang
  fi
  destination="android/resolver-diagnostic/src/main/jniLibs/$abi"
  mkdir -p "$destination"
  GOOS=android GOARCH="$arch" GOARM=7 CGO_ENABLED=1 CC="$toolchain/$compiler" \
    go build -tags resolverprobe -trimpath -buildmode=pie -ldflags='-s -w' \
      -o "$destination/libresolverprobe.so" ./core/cmd/hongguotv
done
