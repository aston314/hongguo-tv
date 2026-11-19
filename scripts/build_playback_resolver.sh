#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output="${1:-build/playback-resolver/resolver.wasm}"
mkdir -p "$(dirname "$output")"
GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 go build \
  -tags resolverwasm -buildmode=c-shared -trimpath -ldflags='-s -w' \
  -o "$output" ./core/cmd/hongguotv
shasum -a 256 "$output"
