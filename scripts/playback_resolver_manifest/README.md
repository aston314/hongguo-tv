# Playback resolver manifest tool

This command signs an already reviewed `resolver.wasm` artifact. It does not
build the resolver algorithm and it does not upload files. The private key is
read from `PLAYBACK_RESOLVER_PRIVATE_KEY` or `-private-key-file`; it is never
accepted as a command-line value.

```sh
export PLAYBACK_RESOLVER_PRIVATE_KEY='base64-or-hex-private-key'
go run ./scripts/playback_resolver_manifest \
  -artifact resolver.wasm \
  -version 2026.11.19.1 \
  -artifact-url https://github.com/aston314/hongguo-tv-releases/releases/download/playback-resolver-v2026.11.19.1/resolver.wasm \
  -out playback-resolver.json \
  -public-key-out playback-resolver-public-key.txt
```

The output format and signature message are intentionally kept in sync with
`core/cmd/hongguotv/playback_resolver_update.go`. The public key is what CI
injects into release builds; the private key must remain in the maintainer's
secret store.
