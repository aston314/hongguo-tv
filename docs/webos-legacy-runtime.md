# webOS 4 service compatibility (#248 / #249)

LG documents Node 0.12.2 for webOS 3.x/4.x and Node 8.12.0 for 5.x/6.x:
https://webostv.developer.lge.com/develop/guides/js-service-basics
The service runtime is separate from the TV browser engine.

## Changes

- Load `runtime-compat.js` before importing the service's production modules.
  Supply only the missing Buffer, Object, Array and Number operations used by
  the service. Keep native implementations on newer Node versions.
- Replace the signer's Buffer mapping with a byte loop, remove block-level
  function declarations rejected by strict ES5, and replace the trace prefix's
  `padStart` call with equivalent padding. Signing vectors must remain identical.
- Node 0.12 also lacks `Server#listening`; use its bound address to determine
  readiness and close the server. New runtimes keep using the native property.
- Scope the official DigiCert G2 root to six verified upstream API/registration/
  web hosts on Node 0.12. See [certificate provenance and scope](../webos/service/certs/README.md).
  Normal TLS chain/hostname/expiry verification remains enabled; other hosts,
  media CDN URLs, update proxies and newer runtimes keep default trust.
- Classify Node 0.12's hostname error (which has no `code`) as the fixed `tls`
  diagnostic reason without exposing its message.

Luna waits, UI timeouts, playback provider order and shared Go core are unchanged.

## Verification (2026-11-20)

Before the fix, official Node 0.12.2 rejected strict-mode block functions and
could not import the signers due to missing Buffer APIs. On the six scoped
hosts, it returned `SELF_SIGNED_CERT_IN_CHAIN`; current Node validated their
RapidSSL TLS RSA CA G1 -> DigiCert Global Root G2 chains. With the scoped root,
Node 0.12.2 validated all six hosts and received HTTP responses (including
200, 404 and 504). Receiving an HTTP error here proves TLS completion, not
successful playback.

The automated probe executes the packaged entry with the complete production
provider/account/signing/storage graph. Only LG's external `webos-service`
binding is substituted; it verifies method registration, concurrent ping,
HTTP health/status/diagnostics and shutdown, plus independent Passport and V5
signature vectors. It also parses every production service JS file in the
selected old VM. A loopback TLS 1.2 fixture verifies 200/404/503 delivery and
rejection of wrong hostnames, expired certificates and untrusted CAs. Test CA
keys live under `tests/fixtures` and are never packaged with the app.

Local runs passed on official Node 0.12.2, Node 8.12.0 and current Node. CI
downloads checksum-pinned official Linux binaries for both old runtimes, then
runs the same probes from a current Node test runner:

```sh
WEBOS_LEGACY_NODE=/absolute/path/to/old/node \
  node --test tests/webos-legacy-runtime.test.cjs tests/webos-upstream-tls.test.cjs
bash scripts/verify_webos.sh
```

These checks do not replace installation and playback verification on an actual
LG webOS 4 TV. They do not assert that every HTTPS/media host has a G2 chain.
