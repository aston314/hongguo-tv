# Local playback repair rules

For rule authors, use the maintained [generation, acceptance and publication
specification](../../../docs/playback-rule-authoring.md) and the project's
`hongguo-playback-rules` skill. Do not edit the generated bundle directly.

Anonymous registration, request signing, provider selection, model/key parsing
and compatible-codec requests run locally in this generated JS bundle. Generic
hash/AES/gzip/random byte operations and bounded HTTP remain host capabilities.
The script cannot access accounts, user files, the UI, native high-level
signing/resolution, or the media player. All media download/decryption/player
lifecycle behavior remains in the existing application.

The production Go application imports the host lazily: the default-off setting
creates no JS VM. Enabling checks the signed public release-repository channel;
only an accepted downloaded rule is selected before the complete native source
sequence. No accepted rule, remote disable, rule/transport failure, or restoring
native resolution preserves that native path. Decoder errors do not offer the
address-repair action.

The bundle is generated from explicitly allowlisted existing webOS playback
modules; see `THIRD_PARTY_NOTICES.md`. Goja has no hard per-runtime heap quota.
Its context interruption, stack bound, bounded provider request count/sizes,
script size/signature/host protocol and self-test checks do not establish a hard
memory sandbox. Default-off and the native fallback remain deliberate policy.

Regenerate and verify:

```sh
go run ./scripts/resolver_js_codegen
go run ./scripts/resolver_js_codegen -check
go test -race ./core/internal/jsresolver ./core/internal/jsupdate
node --test tests/resolver-js-bundle.test.cjs tests/playback-repair.test.cjs
```

Android and desktop share the Go host. webOS uses the same signed bundle in a
separately supervised Node worker, with its original provider as fallback. It
never executes downloaded code in the account/media service. Its actual old
Node runtimes and LG TV behavior require distinct acceptance evidence.
