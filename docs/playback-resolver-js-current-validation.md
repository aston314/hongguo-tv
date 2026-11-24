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

The paired device study uses the same six requested episode IDs repeated 20 times
for resolve-only tests, then 12 media preparations and ten-second playback
windows. It alternates JS/native order between Shield and Zidoo, and records
both raw and forced-GC snapshots. Runs are short repeat-call tests, not whole
20-episode playback or hours-long stability acceptance. There is no audio-output
measurement, MPV rendering test or full-app automatic-next-episode UI test here.

The old Zidoo WebView does not report decoded/dropped frame counters. Its canvas
readback returned a constant black fingerprint even when device screen captures
showed changing video. Preserve that as unavailable observability, not zero
actual decoded frames or a failed resolver. Native and JS media SHA256s can be
compared independently of the device's rendering API capabilities.

The dedicated diagnostic build and lint passed. General branch CI encountered
an unrelated baseline webOS API parity assertion for /api/v1/announcements;
none of the webOS service files were modified for this experiment. Do not report
that all repository CI passed or fix unrelated product behavior in this branch.

## JSON parsing optimization (same APK, replaced script)

The 24 KB JSON in this study is the upstream playback response, not the remote
script/update manifest. The old exact-number parser appended one character at a
time. A synthetic 24 KB response microbenchmark on this host measured 33.664 ms
and 311,647,096 allocated bytes per call; V5 request construction measured 3.672
ms and 4,246,584 allocated bytes. This disproves the earlier attribution of most
of the observed multi-second overhead to signing alone. Request traces showed
that native and JS made the same two warm requests with similar network waits.

The optimized parser consumes complete quoted-string/numeric tokens and only
quotes long integer literals. URLs, escaped quotes/backslashes, nested JSON
strings, fractions, exponents, booleans and null retain their types/content.
Independent tests also reject malformed JSON. Both device-registration and model
parsers use the same pure-JS helper; signing constants, request order, native
capabilities and HTTP implementation are unchanged. This optimization does not
move protocol-specific methods out of the replaceable script.

After the change, the same host microbenchmark measured 0.480 ms and 838,152
allocated bytes per 24 KB parse (about 70x less time and 372x fewer allocated
bytes). These are host microbenchmarks, not Android network latency or retained
memory. Raw benchmark outputs are in the accompanying evidence directory.

The current diagnostic APK built by GitHub Actions (run 45309459350) was kept
installed. Only `files/resolver-probe/candidate.js` was replaced. The test app
loaded it via its explicit private-script flag; `/health.sha256` was checked
before collecting any results. APK SHA256 stayed
`3da8daa622e6e2af965585a6cc48afb0fb90e436e3a12add343211b96be7541c`.
Old script: `d259fefdd439a0dd8a8adfb427aa1fbcdd838724212eef1ab4a734185c3d36d9`.
Optimized script: `bc78025a68f37da6137198a75dc0fb0fd96c87caeab63ad610a983a25a64a094`.

Zidoo's paired 20-request median dropped from 2977.5 ms to 644.5 ms (4.62x).
All 20 resolves succeeded before and after. Six post-change complete media files
were downloaded/decrypted; their SHA256 matched the baseline, and every playback
window advanced beyond ten seconds without a media error. Native/JS baseline
screen captures had previously established real changing frames; Zidoo's old
WebView frame counters and canvas readback remain unavailable as documented
above. No claim of zero dropped frames is made for this device.

Zidoo resolve-20 GC PSS was 20.058 MiB before and 20.105 MiB afterward. Retained
Go heap grew from about 1.54 MiB to 2.16 MiB because the new regex also retains
working storage. Playback-end GC PSS was 20.253 MiB before (12 short windows)
and 21.496 MiB afterward (6 short windows). Reduced cumulative allocations do
not imply an identical reduction in retained PSS. The limited repeat-call
samples show a warm plateau, not proof of hours-long leak-free playback.

Shield's paired 20-request median dropped from 891 ms to 322.5 ms (2.76x).
All 20 resolves succeeded. Three post-change media files were prepared and
played beyond ten seconds with positive decoded-frame counters; all three
SHA256s matched the baseline. The fourth media preparation test timed out at
100 seconds. Follow-up /health and /memory timed out and ADB stopped responding;
the cause was not established. This run is deliberately marked incomplete and
is not reported as a six-playback pass or a diagnosed network failure.
Resolve-20 GC PSS was 32.824 MiB before and 28.372 MiB afterward. Its retained
heap rose from 2.222 to 3.475 MiB, consistent with regex working storage rather
than the old quadratic temporary string churn. Do not describe PSS reduction as
an equal reduction in live heap. The normal native control median was 223 ms
on Shield and 214.5 ms on Zidoo (sequential, same-sample baseline runs).

Conclusion: avoidable JSON allocation/copying was the dominant old overhead;
this script-only repair reduces it substantially while keeping all protocol
logic replaceable. Remaining latency is measurable interpreter work plus
network variation; this study does not attribute it entirely to signatures.
No generic accelerators or new native protocol methods were added. Production
integration and all-platform acceptance remain separate work.

Optimized experimental commit: `ae23e4e`. GitHub diagnostic build/lint run
[45315153675](https://github.com/aston314/hongguo-tv/actions/runs/45315153675)
completed successfully. Its published script digest was checked and exactly
matches the candidate used on both devices. Local exact-number/escaping tests,
JS package race checks, Node asynchronous/signing vectors, generation freshness
and native/JS registration wire parity passed.

The final Shield follow-up was interrupted by an ADB timeout before additional
playback evidence was collected. The tested Zidoo diagnostic package was stopped.
A final Shield force-stop could not be confirmed because the device was offline;
no additional Shield cleanup success or playback result is claimed. Formal
Android/desktop/webOS apps and main were not changed by this experiment.
