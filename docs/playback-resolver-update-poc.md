# Playback resolver update POC

This first phase does not change the production playback source order. It
introduces the host-side transport and artifact contract needed for a future
independently updated resolver:

- proxy URLs are tried in the same order as the existing application update
  channels, followed by the direct HTTPS URL;
- resolver manifests are bounded and validate the product, protocol, size,
  digest, URL and detached Ed25519 signature;
- artifacts are downloaded to an application-private temporary file, checked
  against the declared size and SHA256, and atomically renamed only after all
  checks pass;
- a failed proxy, corrupt artifact or invalid signature cannot replace an
  existing resolver file.
- activation state is written atomically, downgrades are rejected, and a
  failed module load or restore removes the activation record and falls back
  to the embedded resolver.

The first production-facing validation step now wraps the existing Go V5
resolver behind a stable host contract. The source sequence still keeps
`video_tab` first, then the resolver-backed V5 path, and then the existing
legacy/single/codec fallbacks. The resolver wrapper is covered by tests that
compare its candidate options with the old V5 call and verify its metadata.
webOS exports the same resolver metadata while retaining its current provider
implementation and source order.

The production startup path now restores a previously activated module from the
application-private `playback-resolver/` directory when the release build
contains a trusted Ed25519 key. The manifest endpoint is compiled into the
application and fixed to the existing public release repository
(`playback-resolver.json`); users do not enter an address, configure a proxy,
or run a server. The same built-in proxy/direct order as the app update
channel is used. Builds without the trusted key stay on embedded V5 and make
no resolver request. Restore and update failures leave the embedded resolver
available.

The release workflow injects the key at build time with
`-ldflags -X main.playbackResolverPublicKeyRaw=...`; leave it empty until the
real resolver module has been reviewed and signed. A public key alone enables
offline restore of an already activated local module, while the fixed endpoint
enables its automatic check once the key is present.

## Signing a reviewed artifact

The repository does not contain a placeholder production module. After a real
resolver implementation has passed playback tests, create its manifest with
the checked-in tool:

```sh
export PLAYBACK_RESOLVER_PRIVATE_KEY='base64-or-hex-private-key'
go run ./scripts/playback_resolver_manifest \
  -artifact resolver.wasm \
  -version 2026.11.19.1 \
  -artifact-url https://github.com/aston314/hongguo-tv-releases/releases/download/playback-resolver-v2026.11.19.1/resolver.wasm \
  -out playback-resolver.json \
  -public-key-out playback-resolver-public-key.txt
```

The tool signs the exact product, version, protocol, size, digest and artifact
URL string used by the Go core. Keep the private key outside the repository;
store only the derived public key in the `PLAYBACK_RESOLVER_PUBLIC_KEY` GitHub
secret. The release workflows pass that public key into Android, desktop and
Linux core builds. When the secret is absent, the core does not contact the
manifest endpoint and continues using the embedded V5 resolver.

After reviewing the generated manifest and testing the module, publish the
artifact and update the fixed manifest file with the maintainer-only command:

```sh
GH_TOKEN=... python3 scripts/publish_playback_resolver.py \
  -artifact resolver.wasm \
  -manifest playback-resolver.json \
  -notes docs/playback-resolver-release.md
```

The script publishes an independent `playback-resolver-v<version>` release in
the existing public download repository, verifies the uploaded bytes, then
updates `main/playback-resolver.json`. It does not run in the normal APK or
desktop release and it does not require a playback server or a user-supplied
configuration URL.

## Local WASM ABI (protocol 1)

The Go core now has a real `wazero` loader for the local artifact. Production
startup restores it only when a trusted key is explicitly configured; the
default build has no key and therefore remains embedded-only.

The module exports:

```text
memory          linear memory
resolver_alloc  (i32 size) -> i32 pointer
resolver_resolve(i32 request_pointer, i32 request_length) -> i64 packed result
resolver_free   (i32 pointer, i32 length) -> ()
```

The production module may additionally import one function from the host
module `hongguo_resolver_host`:

```text
resolver_http(i32 request_pointer, i32 request_length,
              i32 response_pointer, i32 response_capacity) -> i32
```

The request is JSON containing `method`, `url`, optional headers and a bounded
body. The host permits HTTPS `*.fqnovel.com` and `*.snssdk.com` endpoints (including
`log.snssdk.com/service/2/device_register/`), GET/POST, and non-account headers.
Redirects are checked against the same host and port rules. It writes a bounded JSON response containing HTTP status
and body into the supplied guest buffer. Go reactors also import WASI for runtime initialization, clocks and fresh
entropy. No filesystem mounts, environment, arguments, account cookies,
authorization or socket capability is supplied. HTTP goes only through the
bounded host callback.

The packed `i64` result uses the high 32 bits for the output pointer and the
low 32 bits for the UTF-8 output length. The request is JSON:

```json
{"vid":"...","codec_mode":"default","content_type":"1004"}
```

The response is JSON containing `options`, with the same candidate fields used
by the embedded V5 source (`url`, `key`, `codec`, `width`, `height`, `quality`,
`duration`). The host accepts only HTTPS candidates, bounded dimensions,
quality/codec fields and a bounded key. The fixture uses the no-import form to
prove the memory, call and validation boundary; it is not a playable production
resolver. A production module can use the allow-listed HTTP callback above to
implement registration, signing and response parsing inside the module. The
host still owns media download, decryption, ByteVC2 filtering and all fallback
decisions. A malformed response or a trapped module is therefore just a
resolver failure and advances to the existing embedded/legacy sequence.

The loader uses wazero's interpreter configuration for the first cross-platform
implementation. The loader rejects unknown host modules,
and the HTTP callback is allow-listed. The Go WASI reactor receives no
filesystem mounts or socket capability. Linear memory is capped at 256 MiB and
context cancellation terminates a running guest. The same ABI can be implemented
by a browser `WebAssembly` loader for webOS later; the artifact and signed
manifest format stay unchanged.

## Local WASM direction

The update artifact is a local `resolver.wasm`, not a remote playback service.
The core downloads it through the existing proxy/direct update path, verifies
the detached Ed25519 signature, size and SHA256, then atomically activates it.
Playback continues to use the embedded V5 resolver whenever the module is
missing, cannot be loaded, returns an invalid result or is rolled back.

The experimental algorithm now compiles the existing Go V5 implementation as a
WASI reactor (`resolverwasm` build tag). Registration, TTEncrypt, real V5 signing,
identity refresh on confirmed empty bodies, model parsing, `spade_a` decoding
and ByteVC2-to-compatible-codec fallback execute inside the module itself. The
host callback supplies HTTP only; it cannot supply a model or signature.

Local live verification on 2026-11-19 resolved six episode IDs with the WASM
resolver alone, downloaded and decrypted complete files, and decoded the first
eight seconds of both audio and video with FFmpeg. All six produced HEVC video.
This proves local algorithm execution, not Android playback or every platform.

The remaining production work is device measurements, update replacement
verification and platform acceptance, followed by signing the reviewed module. Until that
artifact exists, the trusted-key secret must remain unset and every build uses
the embedded V5 resolver. Android, desktop and webOS can share the same Go host
ABI; no separate playback server is required.


## Isolated GitHub APK validation

`resolver-diagnostic.yml` builds the real reactor with Go 1.25, runs its ABI and
algorithm tests, builds arm64/armv7 Android hosts and lints an isolated APK.
Outputs go to a temporary draft Release, never a stable update channel.

Package: `rocks.aston.hongguoresolverdiag` (Android 6+). The host verifies a
test-only signature on the bundled module, exposes only loopback HTTP, and
uses a runtime with no embedded resolver. The page tests three episodes from
one series and three samples from other series, downloads/decrypts the media,
and records actual video dimensions and playback past five seconds. Failure
cannot silently fall back to native V5. Exit destroys the child, which also
checks its Android parent PID.

The bundled module is generated, not checked into Git:

```sh
bash scripts/build_playback_resolver.sh /tmp/resolver.wasm
HONGGUO_RESOLVER_WASM_FILE=/tmp/resolver.wasm \
  go test ./core/cmd/hongguotv -run TestWASMPlaybackResolverRealAlgorithm -v
HONGGUO_RESOLVER_WASM_FILE=/tmp/resolver.wasm HONGGUO_LIVE_RESOLVER_WASM=1 \
  go test ./core/cmd/hongguotv -run TestWASMPlaybackResolverLiveMedia -v
```

webOS currently exports only protocol metadata; its JS service does not yet
load this reactor. Cross-platform parity is still pending.
