# Current-production JavaScript resolver experiment

This experiment ports the current anonymous playback source sequence into a
replaceable local JS bundle: video_tab, primary/alternate V5 with same-identity
recovery, fresh-identity legacy requests, registered single-video requests,
old single-video profile, model/key parsing and compatible-codec requests.
The bundle is generated from explicit allowlisted current webOS functions and
modules. Generic hash/AES/gzip/random byte primitives and bounded HTTP remain
in Go. JS has no account store, filesystem, native signer, registration helper,
or native high-level resolver fallback.

The normal application entry does not import Goja. Only the diagnostic entry,
selected by `resolverjsprobe`, imports the JS host. Native diagnostic mode calls
`miniReelNativeOptionsWithSources` from production baseline `fd454dc` directly;
it is not the old standalone V5-only control. Both modes use the same APK,
WebView, media downloader and Go media decryption code.

Only four anonymous registration cookie names cross the host boundary. Header,
request/response size, call-count, per-call timeout and stack bounds plus context
interruption apply. Goja has no hard isolated heap quota. Production remote
manifest verification, atomic activation and rollback are not enabled by this
experiment. An embedded or explicitly private test bundle is not evidence that
production online script distribution has been accepted.

The same Promise-based ES5 bundle runs in the Goja synchronous HTTP host and a
Node asynchronous test host. Standard SM3 uses a generic native primitive when
available; protocol-specific signing stays in JS and retains pure-JS SM3 for
hosts without the primitive.

```sh
go run ./scripts/resolver_js_codegen -check
go test -race ./core/internal/jsresolver
node --test tests/resolver-js-bundle.test.cjs
go test -tags resolverjstest ./core/cmd/hongguotv \
  -run '^TestJSResolverRegistrationWireParity$' -count=1
HONGGUO_CURRENT_LIVE=1 go test ./core/internal/jsresolver \
  -run '^TestCurrentJSLive$' -v -count=1
```

The last command checks real resolution only. Physical playback acceptance is
recorded separately in `docs/playback-resolver-js-current-validation.md`.
Android native libraries and the isolated APK are built in GitHub Actions;
production update channels and installed production applications are unchanged.

Signed-update continuation: see
[`playback-resolver-js-update-validation.md`](../../../docs/playback-resolver-js-update-validation.md).
The isolated APK now verifies downloaded local JS, preserves a verified rollback,
and supports signed disable/replay protection. Shield and Zidoo both recovered
real playback without APK replacement, including a real fixed GitHub fixture
through the existing proxy/direct routes. This is experimental only; production
native entrypoints still have no Goja/updater dependency.
