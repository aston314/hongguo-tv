# Local WASM resolver: Shield validation, 2026-11-19

This is an experimental validation, not production acceptance. Android/desktop
stay on the embedded resolver unless a trusted production update key is configured.

## Exact build and device

- GitHub build: https://github.com/aston314/hongguo-tv/actions/runs/44549030884
- APK source commit: `0c5b9dd525fad14abfcfff55af631cf6035ca613`.
- Compiler: Go 1.27.1; diagnostic package `rocks.aston.hongguoresolverdiag`.
- Device: NVIDIA Shield (darcy), Android 11, arm64, WebView 120.0.6099.230.
- Real Go registration, TTEncrypt, V5 signatures, empty-body identity refresh,
  model parsing, `spade_a` and ByteVC2-compatible-codec fallback run in WASM.
- Host supplies bounded HTTP and media download/decryption. Embedded resolver
  is **nil**; a failing module cannot pass through a native resolver.
- The diagnostic page buttons were driven through the physical WebView debug
  connection. This is not a remote-focus acceptance test of the production UI.

## Actual playback

| VID | Compatible codec | Resolve ms | Complete media bytes | Actual video | Playback seconds | Frames | Drops |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |
| 7706514645208534041 | bytevc1 | 3346 | 22013835 | 1080×1920 | 5.255 | 135 | 39 |
| 7706514815799282713 | bytevc1 | 1479 | 7258839 | 1080×1920 | 5.113 | 132 | 0 |
| 7706514627462433817 | bytevc1 | 1372 | 3875487 | 1080×1920 | 5.086 | 132 | 0 |
| 7702841946812714008 | h265 | 3555 | 27320959 | 1920×1080 | 5.070 | 157 | 0 |
| 7702841953875938328 | h265 | 3707 | 7522899 | 1920×1080 | 5.117 | 127 | 0 |
| 7703473857562151961 | h265 | 3588 | 16120440 | 1920×1080 | 5.059 | 155 | 4 |

All six resolved, downloaded/decrypted and actually decoded on the device.
The first three are episode switches; the later samples include live-action
and animation source switches. `bytevc1` is HEVC. The last animation was also
observed playing beyond 70 seconds, with a visible screenshot.
The fallback trace for the horizontal samples included `codec_type=4` followed
by `codec_type=1`, all inside the guest. This is not merely accepting ByteVC2.

The page waits for a decoded frame and time progression, not just a model URL.
This diagnostic uses full-file downloads; its total prepare times must not be
presented as production Range-mode episode-switch latency.

## Module replacement without reinstalling APK

A second, different real module compiled locally with Go 1.25.5 was copied by
ADB into the diagnostic app’s private `candidate.wasm`, then the same APK was
restarted with the explicit private-module test option. Both modules pass all
four independent Kotlin wire vectors inside the guest.

- Bundled module SHA256: `7cce629cddfc6627f54e824eca4fe0f8e97c7a9e907d8227e9ecb84e38d6b274`.
- Replacement module SHA256: `fcb8a23db64c81f688a697cf0e639f4eb77df501bb09ca33d3904bbef99e04a0`.
- Installed APK SHA256 before and after:
  `a1070e7cfb61584774525d06eab4d67430ce0b60d578d87bca0f72dcdfac219a`.
- Replacement VID `7702841946812714008`: HEVC 1920×1080, 27,320,959 bytes,
  actual playback 5.104 seconds, 158 frames, 0 drops. Resolve 4,356 ms.

This proves loading and executing a replacement local algorithm module without
replacing the APK. It does **not** prove the network auto-update path: the test
host signs its explicitly selected private file with a disposable local test key.
The production manifest signature/download/rollback path currently has unit
coverage; real signed online update acceptance and webOS loading remain pending.

## Failed build retained as evidence

The earlier Go 1.25.14 GitHub artifact (build `44546227971`, module SHA256
`89c3a0a6bf5612dabfcf0e904511f39c3c5c4cb00e2bb941f491e81dd595a289`)
registered devices but got HTTP 200 / zero-byte V5 responses on both Shield
and Mac. The same IDs worked with the locally compiled Go 1.27.1 module.
The final Go 1.27.1 GitHub artifact works on both. A locally compiled Go 1.25.5
module also works, so do not claim all Go 1.25 builds are broken. The precise
cause of the Go 1.25.14 artifact discrepancy is not yet minimized. A build pass
and fixed-wire/mock tests alone do not establish live resolver acceptance.

## Performance and boundaries

- Bundled WASM: 16,494,596 bytes; Shield module load metric 2,510 ms.
- Diagnostic Go process after six samples: PSS 457,837 KiB (~447 MiB),
  RSS 459,312 KiB (~449 MiB). These are whole-process figures, **not** a
  measured increase over the production core, and exclude Java/WebView.
- This is too expensive to accept as the production low-end TV solution.
  Separate algorithm-only code and measure live/retained memory before enabling
  updates; six requests alone cannot diagnose a leak.
- First clip reported 39 drops and the final clip 4; four middle clips 0.
  Do not call every sample drop-free or use this short run as stability proof.
- After Back/Activity destruction, the native diagnostic child disappeared.
  Android retained a cached Java process, which was then force-stopped for cleanup.
- No Windows, Linux, webOS, Android 5 or other TV hardware acceptance is implied.
- Results remain on the experimental branch; production merge/release is pending.
