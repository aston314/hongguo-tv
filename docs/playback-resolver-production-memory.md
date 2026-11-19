# Shield: production and native playback memory, 2026-11-20

The installed official APKs are already the latest Android release,
[v0.2.173](https://github.com/aston314/hongguo-tv-releases/releases/tag/v0.2.173).
Both installed APK hashes exactly match that release's SHA256SUMS:

- Standard: `0e90af73d1dcea586a5f7193e440c3b7371701270bc58f093481f45d047b75c8`.
- MPV: `0668e9fc28c70b406f86bd3a135c973ca098471f49d14ab002497fa70fa09b40`.

No official APK was upgraded, uninstalled or cleared. Standard's initial
recommendation and known VID `7702841946812714008` in series
`7702841940475120702` returned `VIDEO_MODEL_EMPTY`. Therefore the official APK
provided an **unplayed/error-state snapshot**, not a valid playback baseline.
The installed MPV APK's identity was checked; its playback was not benchmarked.

## Actual playback baseline from the current branch

To obtain real playback measurements, a separate standard debug APK was built
on GitHub, using the complete app UI and native embedded V5 resolver. It is
**an experimental preview, not a new official release**:

- Build: https://github.com/aston314/hongguo-tv/actions/runs/44633173312
- Source: `b6392ac03343483f767c0210f062fe65775a5377`.
- Package: `rocks.aston.hongguotv.debug`, version `0.2.173-debug`.
- APK SHA256: `07ea97597f97f436228671f7db9e821d01d73b2dcab42f9bc016620a2c2e5bae`.
- Native core: Go 1.25.14, arm64. Status reported `embedded-v5`,
  resolver version `2026.11.19.1`; no WASM module loaded and no update key set.
- Standard/MPV build, unit tests, lint, signature/identity and ABI checks passed.
  The first preview workflow failed because MPV notices were not staged.
  Adding the same notice/source-kit preparation as release CI fixed the
  preview workflow; no player implementation was changed for this comparison.

The initial screen-saver/background state was excluded. The app was woken and
foreground visibility checked. An automatic 720P warm-up was also excluded.
1080P was then selected through the normal quality UI. The same series' first,
17th and 18th episodes were played twice: six actual 1920×1080 HEVC samples,
all using HTML5 without Media3 fallback. The first and 17th episodes overlap the
WASM diagnostic samples. This is not the exact six-VID/source-switch sequence
used by the WASM diagnostic.

| Episode/run | Position s | Decoded frames | Drops | First frame confirmed |
| --- | ---: | ---: | ---: | --- |
| 1, first | 80.840 | 547 | 0 | yes |
| 17, first | 38.412 | 925 | 0 | yes |
| 18, first | 5.326 | 132 | 2 | yes |
| 1, second | 5.724 | 176 | 2 | yes |
| 17, second | 5.624 | 139 | 1 | yes |
| 18, second | 5.598 | 138 | 1 | yes |

The first quality switch resumed at its existing position; video time alone
was not treated as proof of decoding. The table includes real frame counts
and the adapter's `final_first_frame`/HTML5 route state.

## Measured PSS

| Snapshot | Go/core KiB | Java host KiB | Renderer KiB | Three-process PSS sum KiB |
| --- | ---: | ---: | ---: | ---: |
| Official 0.2.173, unable to play | 51,123 | 180,623 | 73,242 | 304,988 |
| Native preview, first 1080P playback | 23,348 | 304,014 | 96,500 | 423,862 |
| Native preview, after six samples, snapshot A | 24,961 | 202,605 | 103,882 | 331,448 |
| Native preview, after six samples, snapshot B | 23,705 | 299,784 | 106,121 | 429,610 |
| Standalone WASM diagnostic, after six samples | 206,832 | not sampled | not sampled | unavailable |

Thus actual native preview playback used about **23–25 MiB in the Go process**,
compared with about **202 MiB in the WASM diagnostic Go process**. The complete
native preview's measured app/renderer PSS ranged about 324–420 MiB, with
graphics/host memory varying between snapshots. This is not all attributable
to address resolution. Shared system media/GPU services are not included.
Do not add process RSS values as if shared mappings were unique physical RAM.

These are not precise measurements of the incremental cost of enabling WASM
in a production APK: the official APK did not play, the preview uses fresh
guest data, Go toolchains differ, the UI/media paths differ (production Range
versus the WASM diagnostic's complete-file preparation), and the six sample
sequences differ. No forced GC was used. The evidence supports keeping the
current interpreter-based module experimental; it does not establish a leak,
a universal device limit, or an exact future production memory increase.

Safe measurement and decoded-frame records are in
[the evidence JSON](evidence/resolver-production-memory-20261120.json).
