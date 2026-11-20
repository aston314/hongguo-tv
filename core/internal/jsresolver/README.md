# Playback-only JavaScript resolver experiment

`resolver.js` is a replaceable source bundle, generated from an explicit function
and module allow-list in `scripts/resolver_js_codegen`. Registration, TTEncrypt
framing/key derivation, V5 signing/carrier math, identity state, model/key parsing
and codec fallback execute in JS. Go exposes generic hash/AES/gzip/random byte
primitives and bounded HTTP only. No account store, native signer or resolver
fallback is exposed to the script.
The standard SM3 hash is accelerated by the existing native primitive, generated
from its original implementation. Protocol-specific F13/carrier operations stay
in JS. The same bundle retains a pure-JS hash on hosts without native SM3.

The Goja/Buffer dependencies are pinned to versions compatible with Go 1.25.
No new JS runtime is imported by the normal application entry: the core adapter
is gated by `resolverjsprobe`/`resolverjstest` build tags. This is not enabled in
production, and no production update endpoint or key is changed.

The artifact is Promise-based ES5 JS so hosts with asynchronous HTTP can adapt
it too. The Goja host executes bounded HTTP synchronously on the resolver's
serialized worker; callers waiting for the gate can cancel. The source cannot
load filesystem modules or access signed-in account data. Buffer slice/view
semantics are explicitly adapted and checked with independent signing vectors.
HTTP, input/output and stack limits plus context interruption are enforced;
Goja does not provide a hard isolated heap quota. Only reviewed, signed modules
may be used. A source-size limit is not a JavaScript heap limit.

Reproduce from the repository root:

```sh
go run ./scripts/resolver_js_codegen
go run ./scripts/resolver_js_codegen -check
go test ./core/internal/jsresolver
HONGGUO_LIVE_RESOLVER_JS=1 go test -tags resolverjstest ./core/cmd/hongguotv \
  -run '^TestJSPlaybackResolverLiveMedia$' -v -count=1
```

The opt-in live test obtains compatible sources, completely downloads/decrypts
them and verifies actual audio/video decoding. Passing mocks or a clean batch
does not establish stable upstream acceptance; cold sessions have also returned
empty responses in the native and JS implementations.

The isolated `resolver-js-diagnostic` Android package has explicit `js` and
`native` modes in the same APK, HTML page and media pipeline. JS mode has no
native resolver fallback. It validates a disposable signed manifest through the
existing update/activation verifier, then executes the local script. This is a
local-file replacement test, not acceptance of production online updates or LG
hardware. APK/native builds run only in GitHub Actions.
