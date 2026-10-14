# HEVC WebView diagnostic APK

This is a separate, temporary Android app for measuring the Android System WebView's ability to run the hongguo-player v1.2.0 HEVC WASM worker and render its frames. It has a different application ID from 红果短剧 and does not start the Go core or access account, history, playback, or update data.

The worker and decoder module were extracted from the privately analyzed hongguo-player v1.2.0 macOS package. Keep this module and its APK in the private source repository. Do not copy the diagnostic APK or decoder assets to the public download repository. Remove the temporary private draft release after the test APK has been downloaded for device testing.

The three bundled MP4 clips are synthetic 8-bit HEVC Main videos generated with FFmpeg `testsrc2`, with no audio. They test Worker/WASM startup, MP4 Range reads, frame decode, 2D Canvas/WebGL2 rendering, and throughput. They do not test CENC, the upstream Red Fruit API, audio synchronization, or real-episode complexity.

The diagnostic page is served by an app-owned HTTP server; worker `fetch()` and Range requests use real HTTP responses instead of `WebViewClient.shouldInterceptRequest` synthetic responses. The page is loaded over loopback. The server also exposes a read-only LAN endpoint at `http://<device-ip>:18998/api/results`; it returns device/WebView information, successful HTTP 206 Range count, the last request, and the page report. LAN clients cannot access the HTML, WASM, or sample media. This temporary diagnostic package enables cleartext HTTP; do not copy that setting into the production app.

The APK is built with `gradle -p android :wasm-diagnostic:assembleDebug`. It targets API 23+ and can be installed alongside both production editions. Device test results must be reported as diagnostics for that device and WebView version, not as universal playback support.