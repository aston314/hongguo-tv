# Standalone playback resolver

The WASI entry point is `core/cmd/playbackresolver`; this package contains only
anonymous registration, V5 request construction, signatures, model parsing,
URL/content-key decoding and compatible-codec fallback. The application command,
account UI/state, media downloader/decryptor, TLS/HTTP client and wazero loader
are outside this dependency tree. `resolverwire` is the unchanged JSON ABI.

`protocol_generated.go` is generated from an explicit declaration allow-list in
`scripts/resolver_codegen`. It reuses the already verified crypto, device profile
and option parser implementations, rather than maintaining another edited copy.
Change shared primitives in their original source, then run from the repo root:

```sh
go run ./scripts/resolver_codegen
bash scripts/build_playback_resolver.sh /tmp/resolver.wasm
```

The build rejects stale generated code/vectors and forbidden guest dependencies.
The guest compiler is pinned to Go 1.25.5 independently from the application host;
changing that pin requires live verification of the exact resulting artifact.
Fixed vectors and mocked HTTP alone do not establish upstream acceptance.

The host owns HTTP, request deadlines, URL/redirect validation, signature checks
on updates, media download/decryption and the production fallback sequence. The
guest owns its anonymous identity and never receives account credentials.
One module serializes calls and reuses one bounded HTTP callback buffer. There
is no added identity wait or playback retry policy in the final implementation.

Validate with the same existing core tests and real playback path:

```sh
HONGGUO_RESOLVER_WASM_FILE=/tmp/resolver.wasm \
  go test ./core/cmd/hongguotv -run TestWASMPlaybackResolver -v
HONGGUO_RESOLVER_WASM_FILE=/tmp/resolver.wasm HONGGUO_LIVE_RESOLVER_WASM=1 \
  go test ./core/cmd/hongguotv -run TestWASMPlaybackResolverLiveMedia -v
```

Native unit tests cover independent device/signature vectors, cancellation and
same-episode/duration checks for codec fallback. The diagnostic APK can load a
private `candidate.wasm` without changing its APK, allowing device memory and
playback comparisons against the earlier full-command prototype.
