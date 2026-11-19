#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output="${1:-build/playback-resolver/resolver.wasm}"
mkdir -p "$(dirname "$output")"
go run ./scripts/resolver_codegen -check
python3 scripts/verify_resolver_dependencies.py
# Pin the validated guest toolchain independently from the application host.
# Do not advance it based only on mock/vector tests: exact-artifact live media
# verification is required for the Go/WASM engine combination.
GOTOOLCHAIN=go1.25.5 GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 go build \
  -buildmode=c-shared -trimpath -ldflags='-s -w' \
  -o "$output" ./core/cmd/playbackresolver
shasum -a 256 "$output"
