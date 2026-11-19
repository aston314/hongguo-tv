#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
go run ./scripts/resolver_js_codegen -check
go test ./core/internal/jsresolver -count=1
node --test tests/resolver-js-bundle.test.cjs
go test -tags resolverjsprobe ./core/cmd/hongguotv -run '^$'
go test -tags resolverjstest ./core/cmd/hongguotv -run '^TestJSResolverRegistrationWireParity$' -count=1
python3 scripts/package_resolver_js_notices.py
toolchain="${ANDROID_HOME:?}/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin"
for abi in arm64-v8a armeabi-v7a; do
  if [[ "$abi" == arm64-v8a ]]; then
    arch=arm64; compiler=aarch64-linux-android23-clang
  else
    arch=arm; compiler=armv7a-linux-androideabi23-clang
  fi
  destination="android/resolver-js-diagnostic/src/main/jniLibs/$abi"
  mkdir -p "$destination"
  GOOS=android GOARCH="$arch" GOARM=7 CGO_ENABLED=1 CC="$toolchain/$compiler" \
    go build -tags resolverjsprobe -trimpath -buildmode=pie -ldflags='-s -w' \
      -o "$destination/libresolverjsprobe.so" ./core/cmd/hongguotv
done
