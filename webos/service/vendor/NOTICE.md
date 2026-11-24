# Pinned webOS rule host dependencies

Packages came from their versioned npm registry distributions and were checked
against the published integrity before vendoring. No runtime module downloads.

| Package | Version | License | Original entrypoint SHA256 |
| --- | --- | --- | --- |
| tweetnacl | 1.0.3 | Unlicense | 6bcd37a3b20dce913f82d4b23e4e2b661058b4b953df8a3f8c45d56ac4f72447 |
| buffer | 4.9.2 | MIT | 7f0d63efb99aead3f4afa360f5cc5274b032f5a129b759b3eebcec776fdbf2aa |
| base64-js | 1.5.1 | MIT | 829eadd8a1a441d25be0cb93b00e16a0d0c20fd294db95d8f2ed87e6954b7182 |
| ieee754 | 1.2.1 | BSD-3-Clause | fe3e2b20c1ebb57c3b390c8f685ad1e04e6f493517fa7e432f4351bb77a1a4d0 |

TweetNaCl and byte codec sources are unchanged. Only buffer require paths point
to vendored siblings, and its isarray import uses native Array.isArray. Full
licenses are stored next to each module. The byte adapter is worker-only and
does not replace the main service Buffer prototype.
