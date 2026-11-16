# Third-party notices

## Playback-v5 signing port

The following files adapt the playback-v5 implementation in
[N3urda/hongguoTV](https://github.com/N3urda/hongguoTV), commit
`18c37c2afd0567520135abcae312352542f09083`:

- `core/cmd/hongguotv/playback_v5_sign.go`
- `core/cmd/hongguotv/playback_v5_carrier.go`
- `core/cmd/hongguotv/playback_v5_constants.go`
- `webos/service/playback-v5-sign.js`
- `webos/service/playback-v5-carrier.js`
- `webos/service/playback-v5-constants.json`

Upstream source files are `Signer.kt`, `AesV3.kt`, and `V5Constants.kt` under
`kotlin-tv/core/src/main/kotlin/com/hongguotv/core/`. Upstream attributes its v5
protocol to drpys commit `22261ad`. Copyright remains with the upstream authors.
These ports are licensed under **GPL-3.0-only**; the full license is in
[`licenses/GPL-3.0-only.txt`](licenses/GPL-3.0-only.txt). This notice does not
relicense unrelated project code or waive the GPL requirements applicable to a
combined distributed work. Preserve this notice and supply the corresponding
source and license when distributing covered binaries.

The three synthetic fixture files `signing-v5-{f13,carrier,wire}.json` in
`core/cmd/hongguotv/testdata/` were generated from upstream Kotlin tests using
synthetic input. They contain no registered production identity, account
credential, media address, or content key. The wire fixture fixes the process
clock at `1800000000000`, process nonce at `synthetic`, and random words at
`0x80000000`, covering all four timestamp-dependent carrier branches.
