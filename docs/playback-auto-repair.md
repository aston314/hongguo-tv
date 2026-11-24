# Optional automatic playback repair

The feature is off by default. Android (including MPV/Android 5 builds) and
desktop share one Go service. Settings exposes one persistent switch, current
native/repair status, last check and manual check/disable actions. The setting
lives in app-private storage, independent of account and WebView port changes.

Rule maintenance follows the Chinese [authoring, acceptance and publication
contract](playback-rule-authoring.md), with a reusable project skill at
`.agents/skills/hongguo-playback-rules/SKILL.md`. It describes the intended path
towards routine rule delivery without changing default adoption or treating the
current bounded evidence as full platform acceptance.

Only address/model/registration failures with the switch off offer “启用自动修复
并重试”. Media I/O, cache, decryption, account and decoder failures do not.
Enabling saves first, checks in the background and retries the original episode
only when a verified repair is available and the page, playback generation and
account still match. Leaving/changing content prevents the pending retry from
starting stale media. The user's saved option remains enabled.

Enabled startup restores accepted cached rules and checks once in the
background. Manual check is available in Settings. There is no repeating remote
update timer. UI status polls only while a check is pending or the settings
page is visible; it never polls upstream to update a label. Checks coalesce.
No update modal steals focus; successful updates may show a toast outside an
active playback session. Opening settings shows status without interrupting
playback. Language resources cover Simplified/Traditional Chinese and Japanese.

No JS runtime exists while disabled. Enabling/loading/updating/retiring runtimes
is serialized. Rapid toggles cancel obsolete downloads and drain the prior
runtime before another is created. In-flight Resolve calls finish on their
original runtime. New requests see the saved off selection immediately. There
is one resident VM and at most one validation candidate; rollback versions stay
on disk. The repair has an eight-second slice of the original 30-second model
budget, preserving bounded native fallback. An unusable requested quality or
media-source transport failure advances to the native sequence too. Native
quality, ByteVC2 rejection, media cache and decryption retain their boundaries.

The stable channel is the public `hongguo-tv-releases` repository's
`main/resolver-js/manifest.json`. It has a distinct product/key from the earlier
`experimental/resolver-js` fixtures. The signed payload covers enable/disable,
monotonic control revision, freshness, module version, protocol/host API, URL,
size and SHA256. Immutable `modules/<sha256>.js` URLs prevent an old cached
manifest from accidentally receiving different bytes. Four existing GitHub
proxies precede direct; each response is validated before trying another.

Compilation, metadata and four independent signing vectors must pass with
network disabled before atomic activation. Active and previous verified files
are retained; failed candidates cannot displace the last runtime. Only a rule
that actually resolves may become the next rollback copy. Runtime execution/ABI
faults quarantine the active hash; typed upstream-empty, user cancellation and
timeouts do not establish a bad script. A signed remote disable persists its
revision and returns subsequent requests to native resolution; older enabled
controls cannot undo it. Offline clients cannot learn a new disable. Previously
accepted controls remain usable offline after their acceptance expiry.

The “关闭自动修复” action turns off automatic repair; it preserves the previously
verified download so later explicit re-enabling need not depend on network.
No user-entered URL, account credential or server-side resolver is involved.
webOS now uses the same signed channel through a separately supervised Node
worker, preserving the original provider as fallback. Downloaded code never
runs in its account/media service process. See [webOS host boundaries and
acceptance](playback-rule-webos.md); runtime checks do not certify LG hardware.

## Updating rules without packaging the app

Use the source repository's `Publish signed playback resolver rules` manual
workflow from `main`, with an increasing control revision and new module version
for changed content. The Ed25519 seed is kept only in the encrypted Repository
Secret `PLAYBACK_RESOLVER_SIGNING_SEED`; `HONGGUO_RELEASES_TOKEN` publishes the
static files. The APK contains only the public trust anchor. The publisher
runs metadata/signature vectors, checks the preceding signed revision and
refuses same-version changed bytes. `disable=true` publishes a signed control
without a module. App releases, update manifests and release tags are unchanged.
A host API expansion still needs a new app release.


## Announcement integration

The repair card is immediately after system announcements and before ordinary
settings. Notice Down enters its switch; switch Down enters check/disable when
enabled, then the normal settings controls. Up returns through the same path;
Left returns to the sidebar. Mouse/remote share existing focus styling.

An announcement action `repair_playback` opens this card. Off users confirm the
switch themselves; enabled users can check for rules from the notice action.
`min_revision` refers to the actually active module's signed revision, not the
anti-replay control high-water. A rolled-back newer control must not falsely
show its issue as fixed. Notices never change consent, execute code or supply
artifact URLs. “知道了” only dismisses the notice. A notice without a matching
actual rule stays pending. Identical announcement refreshes and changing repair
status update text without rebuilding the focused buttons.

## Acceptance evidence (2026-11-24)

- GitHub checks passed for the implementation: Go/JavaScript checks, Android 5,
  actual Node 0.12/8 webOS runtimes, and macOS/Windows packaging. These are build
  checks, not desktop-device playback certification.
- Browser checks at 960×540 and 1280×720 covered the notice/card order, visible
  focus, and off/on states. A local preview notice located the off switch without
  enabling it, checked rules when enabled, and changed to ready only after the
  matching signed revision became active.
- Side-by-side standard and MPV debug packages on one Android TV device passed
  actual D-pad navigation through switch/check/disable/adjacent settings. Both
  accepted stable signed revision 1, module `2026.11.24.1`, and returned to native
  resolution after disabling. Production packages were not replaced.
- The normal core's media preparation endpoint returned a usable source with
  `active_verified` set by a successful rule resolve. Muted HTML playback showed
  advancing time and positive decoded-frame counts. A separate MPV adapter smoke
  test produced its presentation-ready event with nonzero dimensions and more
  than five seconds of advancing playback position. The MPV event is not a
  measurement of physical first-frame latency.
- Race checks include twenty rapid enable/disable cycles; the fake-runtime
  counter observed at most one resident runtime and zero after closure.

This is bounded feature acceptance, not a new latency/memory benchmark or a
long-duration playback test. The second, lower-end device was unavailable for
this normal-app retest. Earlier isolated experiment results do not substitute
for it. No claim is made that every device, title, codec or desktop player works.
Raw device reports/screenshots remain local and are not published.

## Device-envelope rule update (2026.11.24.2)

The rule's first `video_tab` GET now uses the complete v5 device query and
Medusa envelope verified against OOIUa/hongguo-android v0.8.0. Anonymous
registration includes bounded best-effort activation and optional `klink_egdi`.
The empty GET body uses MD5(empty), and query escaping preserves Android's
literal `*`. Existing source fallbacks, native fallback, host API, default-off
selection and eight-second repair budget remain intact. The native Go baseline
and embedded webOS provider still require their normal later application update.

Four additional synthetic wire vectors were independently generated with the
released Kotlin implementation. They run inside the rule's offline self-test
while retaining the four-vector contract understood by installed clients.
The legacy envelope remains available and still matches its existing vectors.

One resident Goja instance completed nine consecutive live resolves across six
episodes, including consecutive episodes, title changes and returning to an
earlier episode: 9/9 independent JS successes, 181–2235 ms (median 350 ms) in
this network sample. All six distinct episodes completed full 1080P HEVC/AAC
decode using returned addresses/keys and the application's unchanged media code,
across the continuous run and a focused retry. Some CDN responses required the
existing full-file path instead of Range initialization; one full-file download
timed out before a separate JS resolve and full-media verification passed.
These network observations do not guarantee every CDN request succeeds.

Generation checks, Go tests, resolver/updater/application race checks and 999
Node tests passed. Tests cover complete query/activation, exact numeric IDs,
old and new signature vectors, ByteVC2 compatibility, fallback, rule lifecycle
and the isolated webOS worker. Malformed registration responses retain upstream
error classification rather than identifying a healthy script as broken.
This does not constitute LG-device acceptance,
an expanded default rollout, or a new device memory benchmark. Raw URLs, media,
identities and keys stay outside the repository.
