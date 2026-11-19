# Independent local resolver: 2026-11-20

The playback-only module runs real registration, signatures, model parsing,
content-key decoding and compatible-codec fallback on Shield. It is substantially
smaller than the full-command prototype. This establishes an experimental local
module, not acceptance of production automatic updates or low-memory TVs.

## Split and build

`core/cmd/playbackresolver` imports only the independent `playbackresolver` and
`resolverwire` packages plus the Go standard library. The guest excludes the
application command, account state, UI, player, HTTP/TLS client, media
download/decryption and wazero runtime. The host retains those responsibilities.
Crypto/device/parser helpers are generated from an explicit declaration
allow-list, with a drift check. The dependency gate also rejects application
packages outside the three allowed guest packages. The callback reuses one
bounded response buffer rather than allocating 2 MiB per HTTP request.

- GitHub build: https://github.com/aston314/hongguo-tv/actions/runs/44558998106
- Build source: `8c23f5e8bbd54bc50c7c404c3fc88c2c199edd43`.
- Guest compiler: Go 1.25.5; host: Go 1.27.1; wazero interpreter 1.9.0.
- Module: 4,825,075 bytes, SHA256
  `81a9825bc03667a3ec5fa34ddbba5ac33fbeca4851cf9766e23c642be4e36a60`.
- APK: SHA256 `f0809a24b2b420a411db3c33881180d887ee7ee394847ffda4f59d33cec34ffb`.
- Test package: `rocks.aston.hongguoresolverdiag`, Shield/darcy, Android 11,
  arm64, WebView 120.0.6099.230. Production app/data were not replaced.
- Four independent Kotlin signing vectors pass inside this exact guest.
- HTTP remains bounded by the host; no native signing or resolver fallback was
  enabled during acceptance. No registration delay was added to the guest.

## Physical playback

All six samples downloaded/decrypted and actually decoded in the Shield WebView.
The first three exercise episode switches; the remaining samples switch sources.
The page was operated through WebView debugging, not a production remote-focus
test. The media is a complete file; these timings are not production Range-mode
switching latency.

| VID | Codec | Resolve ms | Media bytes | Actual video | Seconds | Frames | Drops |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |
| 7706514645208534041 | bytevc1 | 2609 | 22013835 | 1080×1920 | 5.001 | 129 | 10 |
| 7706514815799282713 | bytevc1 | 1430 | 7258839 | 1080×1920 | 5.113 | 132 | 0 |
| 7706514627462433817 | bytevc1 | 1340 | 3875487 | 1080×1920 | 5.122 | 132 | 0 |
| 7702841946812714008 | h265 | 2730 | 27320959 | 1920×1080 | 5.236 | 161 | 0 |
| 7702841953875938328 | h265 | 2611 | 7522899 | 1920×1080 | 5.053 | 126 | 0 |
| 7703473857562151961 | h265 | 2566 | 16120440 | 1920×1080 | 5.091 | 157 | 0 |

The first request returned HTTP 200 with an empty body; the existing guest
identity-refresh path registered again and obtained a model. Horizontal sources
used the guest codec fallback, including `codec_type=4` then `codec_type=1`.
`bytevc1` is HEVC. The host downloaded/decrypted the selected compatible source;
there was no native resolver fallback. Raw safe reports are retained in
[the evidence JSON](evidence/resolver-split-shield-20261120.json).

Without reinstalling that APK, a different locally built 4,824,888-byte guest
was selected through the diagnostic's private-file override (SHA256
`fb3c493543aee59dfd7ef8167e905358a21f73259dbaf66ce23d484290d5ad15`).
It passed the four vectors, obtained compatible HEVC for
`7702841946812714008`, downloaded/decrypted 27,320,959 bytes and played
1920×1080 for 5.225 seconds (161 frames, zero drops). The installed APK hash
remained the one above. This validates the independent guest's unchanged ABI
and local module replacement; it does not exercise a signed network update.
After Back destroyed the test Activity, its native child exited. The cached
Java process was then force-stopped and test media/candidate files removed.
The temporary draft release was removed after verified local downloads;
the installed test APK and recorded hashes remain available for reproduction.

## Memory

| Measurement | Full-command prototype | Independent guest |
| --- | ---: | ---: |
| WASM bytes | 16,494,596 | 4,825,075 |
| Startup RSS, KiB | 365,364 | 143,128 |
| After six samples: PSS, KiB | 457,837 | 206,832 |
| After six samples: RSS, KiB | 459,312 | 208,216 |
| Observed peak RSS, KiB | not recorded | 209,148 |

The module is 71% smaller; the measured native process PSS after the same six
samples is 55% lower (about 447 to 202 MiB). These are separate runs on the same
device, and whole diagnostic Go-process figures excluding Java/WebView, not
additional production memory or an isolated guest-heap measurement.
The installed official APK and actual native-app comparison is recorded in
[playback-resolver-production-memory.md](playback-resolver-production-memory.md);
the 202 MiB diagnostic value must not be compared to total app memory.
The guest linear memory was 8 MiB before requests and 12.25 MiB afterward;
most process memory remains in the host/runtime. There was no forced GC before
the snapshots. Six short clips cannot establish absence of a memory leak or
long-running stability. About 202 MiB is still material on a low-memory box.

## Remaining acceptance boundaries

The exact GitHub guest also passed six real model/download/decrypt/8-second
audio/video-decode checks on Mac. A separate alternating diagnostic with ten
fresh identities per engine obtained models in 7/10 native trials and 8/10 WASM
trials; failures on both sides were `VIDEO_MODEL_EMPTY`. Native trials shared
their process signer state; WASM trials instantiated a new guest each time.
These small counts are not comparable success-rate estimates or proof of the
failure's cause. They disprove treating a successful build or one clean batch
as stable upstream acceptance. No compiler/engine change, arbitrary wait or
extra retry is justified by those observations alone.

All Go tests, focused resolver race tests, generated-source checks and the guest
dependency gate pass. Production enablement still needs signed online
manifest/download/activation/rollback acceptance, memory/lifecycle integration
with the real app, and platform/device coverage. This work remains on the
experimental branch and does not change the production release.
