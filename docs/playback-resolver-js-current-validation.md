# Current production resolver in local JavaScript (2026-11-24)

Experimental branch only. Production source baseline: `fd454dc` (main at test start).
Native mode calls `miniReelNativeOptionsWithSources` from that baseline directly.
JS mode calls no native registration, signer, resolver or parsing fallback.
It uses the same WebView/media download/decrypt pipeline as the native control.

The older 2026-11-20 diagnostic's native mode was a standalone V5 reference,
not the current production source sequence. Its HTTP 200/empty results cannot
establish that the production app or all upstream interfaces are unavailable.
Those batches also never reached decoding and are not playback memory tests.

The JS port includes primary video_tab GET, 74332 V5 primary and alternate POST,
same-identity signed video_tab recovery, fresh-identity legacy POSTs, registered
single-video POST, old single-video profile, spade_a/key_seed parsing and
ByteVC2-compatible codec requests (including codec_type=3). Protocol primitives
and constants are bundled from current webOS source with an explicit allowlist.
It retains separate anonymous identity caches and bounded requests/deadlines.
The test uses default decoding capability and initial production provider order;
production series source promotion and resume after media failure are outside
this isolated resolver-return test. The normal production entry never calls JS.

Only four anonymous registration cookie names cross the host boundary. Account
state, arbitrary response headers, filesystem, module loading and native
high-level resolvers remain unavailable. Goja still has no hard isolated heap
quota; this experiment is not a production remote-script rollout.

The diagnostic provides `/api/resolve` (no media), `/api/run` (real complete
media download/decryption), `/memory` (POST performs forced GC/FreeOSMemory), and
`/report`. Reports omit source URLs, keys, request signatures and identities.
Keep PSS in KiB and divide by 1024 when converting to MiB. Do not equate
HeapAlloc, reserved Go Sys, RSS and PSS or infer playback success from a URL.

APK/native Android builds run in GitHub Actions. The package is isolated from
standard and MPV editions. No production update channel or release is changed.
