# Optional automatic playback repair

The feature is off by default. Android (including MPV/Android 5 builds) and
desktop share one Go service. Settings exposes one persistent switch, current
native/repair status, last check and manual check/disable actions. The setting
lives in app-private storage, independent of account and WebView port changes.

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
The legacy webOS Node service explicitly reports `supported:false`: secure
execution on that different runtime has not been accepted, so no ineffective
setting is displayed and normal webOS playback is preserved.

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
