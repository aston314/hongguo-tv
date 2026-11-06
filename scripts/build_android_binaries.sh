#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-dev}"
ANDROID_API="${ANDROID_API:-23}"
if [[ "$ANDROID_API" = 21 ]]; then
  OUT_DIR="$ROOT_DIR/android/app/src/android5/jniLibs"
else
  OUT_DIR="$ROOT_DIR/android/app/src/main/jniLibs"
fi
TOOLCHAIN_DIR="${ANDROID_NDK_TOOLCHAIN_DIR:-}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

resolve_toolchain_dir() {
  if [[ -n "$TOOLCHAIN_DIR" ]]; then return; fi
  local ndk_dir="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
  if [[ -z "$ndk_dir" && -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME/ndk" ]]; then
    ndk_dir="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
  fi
  if [[ -z "$ndk_dir" || ! -d "$ndk_dir" ]]; then
    echo "Android NDK not found" >&2
    exit 1
  fi
  local host_tag
  case "$(uname -s)" in
    Linux) host_tag="linux-x86_64" ;;
    Darwin) [[ -d "$ndk_dir/toolchains/llvm/prebuilt/darwin-arm64" ]] && host_tag="darwin-arm64" || host_tag="darwin-x86_64" ;;
    *) echo "Unsupported build host" >&2; exit 1 ;;
  esac
  TOOLCHAIN_DIR="$ndk_dir/toolchains/llvm/prebuilt/$host_tag/bin"
}

build_one() {
  local abi="$1" goarch="$2" goarm="${3:-}" cc="$4"
  local output="$OUT_DIR/$abi/libhongguotv.so"
  mkdir -p "$OUT_DIR/$abi"
  echo "Building $abi -> $output"
  if [[ -n "$goarm" ]]; then
    GOOS=android GOARCH="$goarch" GOARM="$goarm" CGO_ENABLED=1 CC="$cc" \
      go build -trimpath -buildmode=pie -ldflags "-s -w -X main.version=$VERSION" \
      -o "$output" ./core/cmd/hongguotv
  else
    GOOS=android GOARCH="$goarch" CGO_ENABLED=1 CC="$cc" \
      go build -trimpath -buildmode=pie -ldflags "-s -w -X main.version=$VERSION" \
      -o "$output" ./core/cmd/hongguotv
  fi
}

cd "$ROOT_DIR"
resolve_toolchain_dir
build_one "arm64-v8a" "arm64" "" "$TOOLCHAIN_DIR/aarch64-linux-android$ANDROID_API-clang"
build_one "armeabi-v7a" "arm" "7" "$TOOLCHAIN_DIR/armv7a-linux-androideabi$ANDROID_API-clang"
build_one "x86_64" "amd64" "" "$TOOLCHAIN_DIR/x86_64-linux-android$ANDROID_API-clang"
