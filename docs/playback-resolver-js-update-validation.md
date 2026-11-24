# Local JS resolver update experiment — 2026-11-24

This is a continuation of the current-production JS performance experiment,
not an approved production rollout. Native production entrypoints remain
unchanged. All Android work uses the separate `rocks.aston.hongguoresolverjsdiag`
package. No account, production preference, or installed production APK is changed.

## Contract and activation

The downloaded JS contains registration, signature/request orchestration and
model parsing. It runs locally in Goja. The update fixture only serves signed
files; it does not resolve video addresses. Generic hashes/byte operations and
bounded provider HTTP remain host capabilities.

`jsupdate` accepts a canonical JSON payload inside a base64 Ed25519 envelope.
The signed payload includes schema/product, monotonic control revision,
`enabled`, issued/expiry times, and the module's version, wire protocol, host
API version, URL, exact byte size and SHA256. Disabling is signed too. Fresh
incoming controls have at most 30-day lifetime and five-minute future clock
skew. Stored controls remain usable offline after expiry; expiry limits
acceptance, not the lifetime of a previously accepted working algorithm.

Checks serialize. The current Resolve owns a gate until it finishes; activation
and old-VM close wait for that gate. Updating cannot change the algorithm in
mid-request. No request is silently retried with a different algorithm. One VM
remains resident; at most one candidate is temporarily compiled beside it, under the same gate
so a concurrent rollback cannot create a third VM. A
rollback copy is retained as a file, not a second idle VM.

The candidate must pass size/digest, compilation, metadata/host compatibility,
and all four independent signing vectors with HTTP disabled, before activation.
Validation has a deadline. A local file is fsynced and renamed before the
single state file is atomically replaced. State rename is the commit point;
memory switches only afterwards. Network, compile, validation, and pre-commit
storage failures retain the old active state. Stray stage files and unreferenced
content-addressed scripts are pruned on restart. Storage retains active and
previous scripts (each at most 1 MiB); one staged candidate may exist during an
update or after a crash until cleanup.

A candidate becomes eligible as the next rollback version only after a real
successful Resolve. This writes one small state update per activated module,
not one write per episode. Consecutive unverified updates preserve the earlier
verified rollback. Host-observed execution/ABI faults quarantine the active
hash and restore the previous verified file or embedded implementation. Typed
provider/business errors (including empty model), cancellation and timeouts do
not prove a bad algorithm and do not trigger rollback. The rejected request
still fails explicitly; only subsequent requests use the restored algorithm.

Disable persists the newest signed revision, clears active/previous files and
uses embedded JS. Replayed older enabled controls cannot undo it, including
after restart. Same revision with different content is rejected. A newer
revision cannot reactivate a quarantined hash. These protections assume intact
app-private local state; deleting app data also deletes its revision history.

## Transport and isolated lab

The production-shaped transport helper permits only the dedicated experimental
path in the official public repository. It tries the existing four proxy routes
(`gh-proxy.com`, `v4.gh-proxy.org`, `gh-proxy.org`, `ghfast.top`), then direct,
validating each result before advancing. A proxy's HTTP-200 HTML, wrong signature,
redirect or bad digest is a route failure, not activation. No cookies, auth,
referrer or redirects are sent/followed. Per-route and whole-check deadlines,
manifest limits and script limits apply. There is **no published production
manifest or production trust key** in this change.

For deterministic device failure injection, the test-only `-update-lab` flag
uses a disposable public key and fixed `127.0.0.1:18872` endpoint via ADB reverse.
`scripts/resolver_js_update_lab.cjs` serves signed files from the lab computer.
The signing private key stays outside the repository and APK. This is a lab
transport, not a permanent server requirement, user-facing setting, or proof
that the four real internet proxies delivered these files on the TVs. Host TLS
fixture tests separately verify rejection and route fallback behavior. The
`-update-internet` lab flag additionally downloads a signed fixture from the
independent `codex/resolver-js-update-fixtures` branch through the same four
proxies and direct fallback, without ADB reverse. Its endpoint and disposable
public key are fixed in the test APK. The total check budget is 60 seconds,
allowing both manifest and script to exhaust four failed proxy routes and
still reach direct; each individual route is capped at four seconds.

`-simulate-stale` deliberately disables the embedded algorithm with
`SIMULATED_OLD_ALGORITHM`. Native fallback stays off. The same installed APK
must go from that failure to downloaded JS fetching and playing real media,
then restore that JS after process restart without another install. Remote
disable returns to the deliberately stale embedded behavior, making the control
observable without hiding it behind native fallback.

## Verification status

Host fault-injection tests cover signature/control tampering, digest/size,
HTTP-200 HTML/redirect/offline, syntax, undefined API/getter exceptions,
metadata, self-test failure/timeout/forbidden HTTP, revision conflict/replay,
expiry/API mismatch, atomic activation storage failure, leftover crash files,
corrupt-active restore, runtime fault rollback/quarantine, provider-empty and
cancellation classification, concurrent checks/Resolve/Close, rollback during an artifact download, invalid
caller input that must not trigger rollback, repeated module
revision, distinct rollback retention and real optimized-script self-test.
Device results and CI build identity are added after execution, never inferred
from these host tests.

Limits: Goja has no per-runtime hard heap quota; signing and bounded I/O do not
turn arbitrary author-signed JS into a memory-isolated process. Offline clients
cannot receive a new disable until a successful check. Self-tests do not prove
upstream availability. A script requiring a new host capability still needs an
app release. Long-duration/low-end/multiplatform rollout remains unaccepted.
