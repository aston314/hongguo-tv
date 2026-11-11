# Windows optional software decoder

The existing WebView2 `<video>` path remains the default. Only a Windows build
with the bundled decoder exposes Settings → Playback decoding → CPU (WASM).
Preferences apply to the next source, not the playing episode. Android, macOS,
Linux and webOS do not install this adapter.

FFmpeg n8.0.1 (`894da5ca7d742e4429ffb2af534fcda0103ef593`) is compiled from
source with Emscripten 4.0.19. It includes the MOV demuxer, HEVC/H.264/AAC
decoders, swscale and swresample. No copied decoder binary is distributed.
ByteVC2/VVC is not supported by this path. Native HEVC extensions are not used
for software video decoding. Web Audio plays decoded stereo PCM; WebGL renders
YUV420P video against the audio clock. Speed currently changes the audio pitch,
as with Web Audio BufferSource, rather than applying a time-stretch filter.

`windows-wasm-worker.js` performs bounded 1 MiB Range reads on the existing
loopback clear-media route, with at most eight queued frames and approximately
one second of decode-ahead. Generation IDs discard stale messages. Replacement,
seek and leaving the page terminate the old Worker, close its AudioContext and
release its WebGL resources. No account identity or upstream URL is passed into
the worker and raw codec logs are disabled.

Run `scripts/build_windows_wasm.sh` in GitHub Actions to produce desktop-only
runtime assets and an LGPL source/relink bundle. The matching source archive,
wrapper source/object, FFmpeg libraries and license travel with Windows packages.
The isolated workflow `windows-wasm-validation.yml` uploads private draft test
packages only; it does not update public manifests or publish an app release.

`--windows-wasm-self-test` is an explicit CI-only test mode requiring isolated
media, script and output paths. It launches the actual packaged Wails/WebView2
window. Synthetic 720P/1080P 30fps HEVC/AAC fixtures cover first frames,
nonblack pixels, pause/resume, seek, speed, volume, natural end, rapid
replacement, cleanup and restoration of the default H.264 path. The test
allows autoplay via a test-only browser argument and does not perform subjective
listening or establish performance on every Windows PC.
