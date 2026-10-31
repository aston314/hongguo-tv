const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/native-player.js'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const mpvBridgeSource = fs.readFileSync(require.resolve('../android/app/src/mpv/java/rocks/aston/hongguotv/MpvPlayerBridge.java'), 'utf8');
const mpvTransitionSource = fs.readFileSync(require.resolve('../android/app/src/mpv/java/rocks/aston/hongguotv/MpvTransitionState.java'), 'utf8');

function FakeClock() {
  this.time = 10000;
  this.sequence = 0;
  this.jobs = [];
}
FakeClock.prototype.now = function () { return this.time; };
FakeClock.prototype.setTimeout = function (callback, delay) {
  const id = ++this.sequence;
  this.jobs.push({id, at: this.time + Math.max(0, Number(delay) || 0), callback});
  return id;
};
FakeClock.prototype.clearTimeout = function (id) {
  this.jobs = this.jobs.filter(job => job.id !== id);
};
FakeClock.prototype.advance = function (duration) {
  const target = this.time + duration;
  let turns = 0, next;
  while ((next = this.jobs.filter(job => job.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0])) {
    if (++turns > 1000) throw new Error('fake timer runaway');
    this.jobs = this.jobs.filter(job => job.id !== next.id);
    this.time = next.at;
    next.callback();
  }
  this.time = target;
};

function fixture(engine = 'webview_media3', options = {}) {
  const listeners = {};
  const frameCallbacks = [];
  const classNames = new Set();
  const rootClassNames = new Set();
  const clock = new FakeClock();
  const values = Object.assign({}, options.storage || {});
  const storage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
    setItem(key, value) { values[key] = String(value); },
    removeItem(key) { delete values[key]; },
    values
  };
  const nativePreferences = options.nativePreferences || null;
  const preferenceBridge = nativePreferences ? {
    readMedia3Preference(version) {
      const current = nativePreferences.media3;
      if (!current || current.webview !== version || current.expires_at <= clock.now()) {
        delete nativePreferences.media3;
        return '';
      }
      return 'media3';
    },
    writeMedia3Preference(version, expiresAt) {
      nativePreferences.media3 = {engine: 'media3', webview: version, expires_at: expiresAt};
      return true;
    },
    clearMedia3Preference() { delete nativePreferences.media3; }
  } : null;
  const domVideo = {
    src: '', currentSrc: '', currentTime: 0, duration: 0, paused: true, playbackRate: 1, volume: 1, muted: true,
    readyState: 0, videoWidth: 0, videoHeight: 0, bufferedEnd: 0,
    buffered: { get length() { return domVideo.bufferedEnd > 0 ? 1 : 0; }, start() { return 0; }, end() { return domVideo.bufferedEnd; } },
    classList: {
      toggle(name, on) { if (on) classNames.add(name); else classNames.delete(name); },
      contains(name) { return classNames.has(name); }
    },
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    load() { this.readyState = 0; this.currentTime = 0; },
    requestVideoFrameCallback(callback) { frameCallbacks.push(callback); },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
  const document = {
    documentElement: { classList: {
      add(name) { rootClassNames.add(name); },
      remove(name) { rootClassNames.delete(name); },
      contains(name) { return rootClassNames.has(name); }
    } },
    getElementById(id) { return id === 'hero-video' ? domVideo : null; },
    querySelector() { return { getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; } }; }
  };
  const bridge = {
    isAvailable() { return true; },
    engine() { return engine; },
    diagnostics() { return JSON.stringify(this.diagnostic || {}); },
    bounds() {},
    begin() { this.begins++; },
    play(id, payload) { this.plays++; this.lastId = id; this.lastPayload = JSON.parse(payload); },
    plays: 0, resumes: 0, stops: 0, begins: 0, pauses: 0,
    resume() { this.resumes++; },
    pause() { this.pauses++; },
    stop() { this.stops++; },
    lastId: null,
    lastPayload: null,
    setVolume() {},
    seekTo() {}
  };
  const window = { HongguoNativePlayer: bridge, addEventListener() {}, location: { origin: options.origin || 'http://127.0.0.1' }, localStorage: storage };
  if (preferenceBridge) window.HongguoTVPreferences = preferenceBridge;
  const context = vm.createContext({
    document,
    window,
    navigator: { userAgent: options.userAgent || 'Mozilla/5.0 Chrome/122.0.6261.94' },
    isFinite,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    Date: { now: clock.now.bind(clock) },
    Promise
  });
  if (options.canPlayType) domVideo.canPlayType = options.canPlayType;
  vm.runInContext(source, context);
  return {
    context, document, domVideo, listeners, bridge, rootClassNames, clock, storage, frameCallbacks,
    emit(name, event = {type: name, target: domVideo}) { (listeners[name] || []).slice().forEach(listener => listener(event)); }
  };
}

function activateNative(f) {
  const proxy = f.document.getElementById('hero-video');
  proxy.src = '/media/test.mp4';
  proxy.play();
  if (!f.context.window.HongguoNativePlaybackAdapter.isNative()) {
    assert.equal(f.context.window.HongguoNativePlaybackAdapter.enableNative(), true);
  }
  return f.bridge.lastId;
}

test('current native diagnostics reject persisted and delayed snapshots across loads and page reloads', () => {
  for (const engine of ['webview_media3', 'mpv']) {
    const f = fixture(engine), adapter = f.context.window.HongguoNativePlaybackAdapter;
    const id = activateNative(f), diagnosticId = f.bridge.lastPayload.diagnostic_id;
    f.bridge.diagnostic = { diagnostic_id: 'previous-page', track_support: 'FORMAT_EXCEEDS_CAPABILITIES' };
    assert.equal(Object.keys(adapter.nativeDiagnostics()).length, 0);
    f.bridge.diagnostic = { diagnostic_id: diagnosticId, state: 'preparing', error_kind: 'decoder', error_code: 4003 };
    assert.equal(adapter.nativeDiagnostics().error_code, 4003, 'current native failures remain visible');
    const proxy = f.document.getElementById('hero-video');
    proxy.src = '/media/next.mp4';
    assert.equal(Object.keys(adapter.nativeDiagnostics()).length, 0, 'old snapshot is hidden before the new bridge play');
    if (engine !== 'mpv') assert.equal(adapter.diagnostics(), null, 'previous route is not reused while new playback is idle');
    proxy.play();
    if (engine !== 'mpv') adapter.enableNative();
    assert.notEqual(f.bridge.lastPayload.diagnostic_id, diagnosticId);
    assert.equal(Object.keys(adapter.nativeDiagnostics()).length, 0, 'late old snapshot is still hidden after bridge play');
    f.bridge.diagnostic = { diagnostic_id: f.bridge.lastPayload.diagnostic_id, state: 'playing' };
    assert.equal(adapter.nativeDiagnostics().state, 'playing');
    const reloaded = fixture(engine);
    assert.equal(activateNative(reloaded), id, 'callback sequence and clock restart on page reload');
    assert.notEqual(reloaded.bridge.lastPayload.diagnostic_id, diagnosticId, 'diagnostic identity survives callback ID collisions');
    reloaded.bridge.diagnostic = { diagnostic_id: diagnosticId, error_kind: 'decoder' };
    assert.equal(Object.keys(reloaded.context.window.HongguoNativePlaybackAdapter.nativeDiagnostics()).length, 0);
  }
});

test('Media3 diagnostics stop overriding HTML5 after native failure, while MPV keeps its current failure', () => {
  for (const engine of ['webview_media3', 'mpv']) {
    const f = fixture(engine), adapter = f.context.window.HongguoNativePlaybackAdapter;
    const id = activateNative(f);
    f.bridge.diagnostic = { diagnostic_id: f.bridge.lastPayload.diagnostic_id, error_kind: 'decoder', error_code: 4003 };
    f.context.window.HongguoNativePlayback.event(id, 'error', { kind: 'decoder' });
    if (engine === 'mpv') {
      assert.equal(adapter.nativeDiagnostics().error_code, 4003, 'MPV error remains inspectable after callback invalidation');
    } else {
      assert.equal(adapter.diagnostics().active_path, 'HTML5');
      assert.equal(Object.keys(adapter.nativeDiagnostics()).length, 0);
    }
    f.document.getElementById('hero-video').src = '';
    assert.equal(Object.keys(adapter.nativeDiagnostics()).length, 0);
    f.bridge.diagnostics = () => { throw Error('bridge unavailable'); };
    assert.doesNotThrow(() => adapter.nativeDiagnostics());
  }
});

test('WebView remains the default until native fallback is requested', () => {
  const f = fixture();
  const proxy = f.document.getElementById('hero-video');
  proxy.src = '/media/test.mp4';
  proxy.play();
  assert.equal(proxy.src, '/media/test.mp4');
  assert.equal(f.bridge.lastId, null);
  assert.equal(f.rootClassNames.has('native-playback'), false);
  proxy.pause();
});

test('WebView media error switches to Media3 once and keeps the playback position', () => {
  const f = fixture();
  const proxy = f.document.getElementById('hero-video');
  proxy.src = '/media/test.mp4';
  proxy.play();
  f.domVideo.currentTime = 12.5;
  f.listeners.error[0]({ type: 'error' });
  assert.ok(f.bridge.lastId);
  assert.equal(f.rootClassNames.has('native-playback'), true);
  assert.equal(f.bridge.lastPayload.start_position, 12.5);
  assert.equal(proxy.currentTime, 12.5);
  const nativeId = f.bridge.lastId;
  f.listeners.error[0]({ type: 'error' });
  assert.equal(f.bridge.lastId, nativeId);
});

test('Media3 fallback uses the staged resume position before WebView playback advances', () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  video.src = '/media/history.mp4';
  f.context.window.HongguoNativePlaybackAdapter.setStartPosition(42.5);
  video.load();
  video.play();
  f.listeners.error[0]({ type: 'error' });
  assert.equal(f.bridge.lastPayload.start_position, 42.5);
});

test('automatic fallback waits 1.8 seconds only while HTML5 has made no observable progress', async () => {
  const stalled = fixture(), stalledVideo = stalled.document.getElementById('hero-video');
  stalledVideo.src = '/media/stalled.mp4';
  await stalledVideo.play();
  stalled.clock.advance(1799);
  assert.equal(stalled.bridge.plays, 0);
  stalled.clock.advance(1);
  assert.equal(stalled.bridge.plays, 1);
  assert.equal(stalled.context.window.HongguoNativePlaybackAdapter.diagnostics().switch_reason, 'zero_progress_timeout');

  const progressing = fixture(), video = progressing.document.getElementById('hero-video');
  video.src = '/media/progressing.mp4';
  await video.play();
  progressing.clock.advance(1500);
  progressing.domVideo.bufferedEnd = 4;
  progressing.emit('progress');
  progressing.clock.advance(1799);
  assert.equal(progressing.bridge.plays, 0);
  progressing.clock.advance(1);
  assert.equal(progressing.bridge.plays, 1);
});

test('metadata switches the watchdog to a separate 3-second first-frame wait', async () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  video.src = '/media/metadata-only.mp4';
  await video.play();
  f.clock.advance(1200);
  f.domVideo.readyState = 1;
  f.emit('loadedmetadata');
  f.emit('playing');
  f.clock.advance(2999);
  assert.equal(f.bridge.plays, 0);
  f.clock.advance(1);
  assert.equal(f.bridge.plays, 1);
  assert.equal(f.context.window.HongguoNativePlaybackAdapter.diagnostics().switch_reason, 'first_frame_timeout');
});

test('metadata and continuing buffered growth keep waiting until progress stops', async () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  video.src = '/media/slow-but-progressing.mp4';
  await video.play();
  f.clock.advance(1200);
  f.domVideo.readyState = 1;
  f.emit('loadedmetadata');
  f.clock.advance(1500);
  f.domVideo.bufferedEnd = 2;
  f.emit('progress');
  f.clock.advance(1500);
  f.domVideo.bufferedEnd = 5;
  f.emit('progress');
  f.clock.advance(1799);
  assert.equal(f.bridge.plays, 0);
  f.clock.advance(1);
  assert.equal(f.bridge.plays, 1);
  assert.equal(f.context.window.HongguoNativePlaybackAdapter.diagnostics().metadata_ms, 1200);
});

test('HTML5 first frame requires a rendered-frame callback or advancing playback with dimensions', async () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  video.src = '/media/frame.mp4';
  f.domVideo.readyState = 2;
  f.domVideo.videoWidth = 640;
  f.domVideo.videoHeight = 360;
  await video.play();
  f.emit('playing');
  f.domVideo.currentTime = 0.2;
  f.emit('timeupdate');
  const route = f.context.window.HongguoNativePlaybackAdapter.diagnostics();
  assert.equal(route.final_path, 'HTML5');
  assert.equal(route.final_first_frame, true);
  f.clock.advance(5000);
  assert.equal(f.bridge.plays, 0);
});

test('NotAllowedError and AbortError do not trigger a player switch', async () => {
  for (const name of ['NotAllowedError', 'AbortError']) {
    const f = fixture(), video = f.document.getElementById('hero-video');
    video.src = '/media/rejected.mp4';
    f.domVideo.play = function () { return Promise.reject(Object.assign(new Error(name), {name})); };
    await assert.rejects(video.play(), {name});
    assert.equal(f.bridge.plays, 0);
  }
});

test('SecurityError is a non-policy play failure and tries Media3 without caching the route', async () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  video.src = '/media/security-error.mp4';
  f.domVideo.play = function () { return Promise.reject(Object.assign(new Error('blocked'), {name: 'SecurityError'})); };
  await video.play();
  assert.equal(f.bridge.plays, 1);
  assert.equal(f.context.window.HongguoNativePlaybackAdapter.diagnostics().switch_reason, 'play_rejected');
  assert.equal(f.storage.getItem('hongguo.native-player.preference.v1'), null);
});

test('unsupported play rejection switches immediately but stores preference only after a Media3 frame', async () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  video.src = '/media/unsupported.mp4';
  f.domVideo.play = function () { return Promise.reject(Object.assign(new Error('unsupported'), {name: 'NotSupportedError'})); };
  await video.play();
  assert.equal(f.bridge.plays, 1);
  const key = 'hongguo.native-player.preference.v1';
  assert.equal(f.storage.getItem(key), null);
  f.context.window.HongguoNativePlayback.event(f.bridge.lastId, 'frame', {width: 720, height: 1280});
  const saved = JSON.parse(f.storage.getItem(key));
  assert.equal(saved.engine, 'media3');
  assert.equal(saved.webview, '122.0.6261.94');
  assert.equal(saved.expires_at, f.clock.now() + 30 * 24 * 60 * 60 * 1000);
  assert.equal(f.context.window.HongguoNativePlaybackAdapter.diagnostics().cache_written, true);
});

test('a confirmed decode failure caches Media3 for the next source on this WebView installation', async () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  video.src = '/media/decode-failure.mp4';
  await video.play();
  f.domVideo.error = {code: 3};
  f.emit('error');
  assert.equal(f.bridge.plays, 1);
  assert.equal(f.storage.getItem('hongguo.native-player.preference.v1'), null);
  f.context.window.HongguoNativePlayback.event(f.bridge.lastId, 'frame', {width: 720, height: 1280});
  assert.ok(f.storage.getItem('hongguo.native-player.preference.v1'));
  video.src = '/media/next.mp4';
  await video.play();
  assert.equal(f.bridge.plays, 2);
  assert.equal(f.context.window.HongguoNativePlaybackAdapter.diagnostics().switch_reason, 'cached_media3');
});

test('Android native preference survives the changing loopback port and clears after Media3 failure', async () => {
  const nativePreferences = {};
  const first = fixture('webview_media3', {nativePreferences, origin: 'http://127.0.0.1:7655'});
  const firstVideo = first.document.getElementById('hero-video');
  firstVideo.src = '/media/decode-failure.mp4';
  await firstVideo.play();
  first.domVideo.error = {code: 3};
  first.emit('error');
  first.context.window.HongguoNativePlayback.event(first.bridge.lastId, 'frame', {width: 720, height: 1280});
  assert.equal(nativePreferences.media3.webview, '122.0.6261.94');
  assert.equal(first.storage.getItem('hongguo.native-player.preference.v1'), null);

  const restarted = fixture('webview_media3', {nativePreferences, origin: 'http://127.0.0.1:7841'});
  const restartedVideo = restarted.document.getElementById('hero-video');
  restartedVideo.src = '/media/next-process.mp4';
  await restartedVideo.play();
  assert.equal(restarted.bridge.plays, 1);
  assert.equal(restarted.context.window.HongguoNativePlaybackAdapter.diagnostics().switch_reason, 'cached_media3');
  restarted.context.window.HongguoNativePlayback.event(restarted.bridge.lastId, 'error', {kind: 'decoder'});
  assert.equal(nativePreferences.media3, undefined);
});

test('network errors and zero-progress fallback never write a Media3 preference', async () => {
  const errorCase = fixture(), errorVideo = errorCase.document.getElementById('hero-video');
  errorVideo.src = '/media/network-error.mp4';
  await errorVideo.play();
  errorCase.domVideo.error = {code: 2};
  errorCase.emit('error');
  errorCase.context.window.HongguoNativePlayback.event(errorCase.bridge.lastId, 'frame', {width: 640, height: 360});
  assert.equal(errorCase.storage.getItem('hongguo.native-player.preference.v1'), null);

  const timeoutCase = fixture(), timeoutVideo = timeoutCase.document.getElementById('hero-video');
  timeoutVideo.src = '/media/no-progress.mp4';
  await timeoutVideo.play();
  timeoutCase.clock.advance(1800);
  timeoutCase.context.window.HongguoNativePlayback.event(timeoutCase.bridge.lastId, 'frame', {width: 640, height: 360});
  assert.equal(timeoutCase.storage.getItem('hongguo.native-player.preference.v1'), null);
});

test('cached Media3 preference expires and is invalidated when the WebView version changes', async () => {
  const key = 'hongguo.native-player.preference.v1';
  const stale = fixture('webview_media3', {storage: {[key]: JSON.stringify({
    engine: 'media3', webview: '122.0.6261.94', expires_at: 9999
  })}});
  const staleVideo = stale.document.getElementById('hero-video');
  staleVideo.src = '/media/stale.mp4'; await staleVideo.play();
  assert.equal(stale.bridge.plays, 0);
  assert.equal(stale.storage.getItem(key), null);

  const changed = fixture('webview_media3', {userAgent: 'Mozilla/5.0 Chrome/123.0.6312.80', storage: {[key]: JSON.stringify({
    engine: 'media3', webview: '122.0.6261.94', expires_at: 50000
  })}});
  const changedVideo = changed.document.getElementById('hero-video');
  changedVideo.src = '/media/version-changed.mp4'; await changedVideo.play();
  assert.equal(changed.bridge.plays, 0);
  assert.equal(changed.storage.getItem(key), null);
});

test('Media3 failure returns to HTML5 at the native position without switching a second time', async () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  video.src = '/media/media3-fails.mp4';
  await video.play();
  f.domVideo.error = {code: 3};
  f.emit('error');
  const id = f.bridge.lastId;
  f.context.window.HongguoNativePlayback.progress(id, 24500, 90000);
  f.context.window.HongguoNativePlayback.event(id, 'error', {kind: 'decoder'});
  assert.equal(f.rootClassNames.has('native-playback'), false);
  assert.equal(f.domVideo.currentTime, 24.5);
  assert.equal(f.bridge.plays, 1);

  f.domVideo.error = {code: 3};
  f.emit('error');
  assert.equal(f.bridge.plays, 1);
  assert.equal(f.context.window.HongguoNativePlaybackAdapter.diagnostics().outcome, 'html5_error_decode_error');

  const timeout = fixture(), timeoutVideo = timeout.document.getElementById('hero-video');
  timeoutVideo.src = '/media/retry-times-out.mp4';
  await timeoutVideo.play();
  timeout.clock.advance(1800);
  const retryId = timeout.bridge.lastId;
  timeout.context.window.HongguoNativePlayback.event(retryId, 'error', {kind: 'decoder'});
  timeout.clock.advance(1800);
  assert.equal(timeout.bridge.plays, 1);
  assert.equal(timeout.context.window.HongguoNativePlaybackAdapter.diagnostics().outcome, 'html5_retry_zero_progress_timeout');
});

test('preference is not reused after its WebView version matches only partially', async () => {
  const key = 'hongguo.native-player.preference.v1';
  const f = fixture('webview_media3', {userAgent: 'Mozilla/5.0 Chrome/122.0.6261.94', storage: {[key]: JSON.stringify({
    engine: 'media3', webview: '122.0.6261', expires_at: 50000
  })}});
  const video = f.document.getElementById('hero-video');
  video.src = '/media/exact-version.mp4'; await video.play();
  assert.equal(f.bridge.plays, 0);
});

test('native playback failure restores the visible WebView video layer', () => {
  const f = fixture();
  const proxy = f.document.getElementById('hero-video');
  const events = [];
  proxy.addEventListener('nativefallbackstart', () => events.push('start'));
  proxy.addEventListener('nativefallbackend', () => events.push('end'));
  const nativeId = activateNative(f);
  assert.equal(f.rootClassNames.has('native-playback'), true);
  assert.deepEqual(events, ['start']);
  f.context.window.HongguoNativePlayback.event(nativeId, 'error');
  assert.equal(f.rootClassNames.has('native-playback'), false);
  assert.deepEqual(events, ['start', 'end']);
  assert.equal(proxy.src, '/media/test.mp4');
});

test('a new source leaves a previous native fallback and starts with WebView again', () => {
  const f = fixture();
  const proxy = f.document.getElementById('hero-video');
  activateNative(f);
  const nativeId = f.bridge.lastId;
  proxy.src = '/media/next.mp4';
  proxy.play();
  assert.equal(proxy.src, '/media/next.mp4');
  assert.equal(f.bridge.lastId, nativeId);
  proxy.pause();
});

test('native playback converts bridge millisecond position and duration to seconds', () => {
  const f = fixture();
  const proxy = f.document.getElementById('hero-video');
  const id = activateNative(f);
  f.context.window.HongguoNativePlayback.progress(id, 5000, 188000);
  assert.equal(proxy.currentTime, 5);
  assert.equal(proxy.duration, 188);
});

test('native playback clamps a position that exceeds the reported duration', () => {
  const f = fixture();
  const proxy = f.document.getElementById('hero-video');
  const id = activateNative(f);
  f.context.window.HongguoNativePlayback.progress(id, 250000, 188000);
  assert.equal(proxy.currentTime, 188);
  assert.equal(proxy.duration, 188);
});

test('MPV edition sends sources only to MPV and resumes without recreating before first frame', async () => {
  const f = fixture('mpv'), video = f.document.getElementById('hero-video');
  video.src = '/media/test.mp4'; video.load(); video.currentTime = 12.5;
  await video.play(); video.pause(); await video.play();
  assert.equal(f.domVideo.src, '');
  assert.equal(f.bridge.plays, 1);
  assert.equal(f.bridge.resumes, 1);
  assert.equal(f.bridge.lastPayload.start_position, 12.5);
  assert.equal(f.bridge.lastPayload.source, 'http://127.0.0.1/media/test.mp4');
});

test('native playback preserves a staged history position across source load', async () => {
  const f = fixture('mpv'), video = f.document.getElementById('hero-video');
  video.src = '/media/history.mp4';
  f.context.window.HongguoNativePlaybackAdapter.setStartPosition(12.5);
  video.load();
  await video.play();
  assert.equal(f.bridge.lastPayload.start_position, 12.5);
});

test('explicit zero position clears a previously staged native resume position', async () => {
  const f = fixture('mpv'), video = f.document.getElementById('hero-video');
  video.src = '/media/history.mp4';
  f.context.window.HongguoNativePlaybackAdapter.setStartPosition(12.5);
  video.load();
  video.src = '/media/selected.mp4';
  f.context.window.HongguoNativePlaybackAdapter.setStartPosition(0);
  video.load();
  await video.play();
  assert.equal(f.bridge.lastPayload.start_position, 0);
});

test('app stages playback position on source changes and leaves native initial seek to the bridge', () => {
  assert.equal((appSource.match(/stageNativePlaybackStartPosition\(/g) || []).length - 1, 3);
  assert.match(appSource, /nativeStartPosition[\s\S]*!nativeStartPosition && position > 0/);
  assert.match(appSource, /function stageNativePlaybackStartPosition\(position\)[\s\S]*adapter\.setStartPosition\(position\)/);
});

test('MPV source replacement ignores old frame, progress and ended callbacks', async () => {
  const f = fixture('mpv'), video = f.document.getElementById('hero-video');
  const playback = f.context.window.HongguoNativePlayback;
  let ends = 0, frames = 0;
  video.addEventListener('ended', () => ends++);
  video.addEventListener('nativeframe', () => frames++);
  video.src = '/media/one.mp4'; await video.play(); const old = f.bridge.lastId;
  video.src = '/media/two.mp4'; await video.play(); const current = f.bridge.lastId;
  playback.event(old, 'frame', {width: 1080, height: 1920});
  playback.progress(old, 100000, 100000); playback.event(old, 'ended');
  assert.equal(ends, 0); assert.equal(frames, 0); assert.equal(video.currentTime, 0);
  playback.event(current, 'frame', {width: 720, height: 1280});
  playback.event(current, 'playing'); playback.progress(current, 5000, 90000);
  assert.equal(frames, 1); assert.equal(video.videoHeight, 1280); assert.equal(video.currentTime, 5);
});

test('MPV source replacement retains the old session until the new play request', async () => {
  const f = fixture('mpv'), video = f.document.getElementById('hero-video');
  const order = [];
  const oldStop = f.bridge.stop;
  const oldBegin = f.bridge.begin;
  const oldPlay = f.bridge.play;
  f.bridge.stop = function () { order.push('stop'); oldStop.call(this); };
  f.bridge.begin = function (id) { order.push('begin'); oldBegin.call(this, id); };
  f.bridge.play = function (id, payload) { order.push('play'); oldPlay.call(this, id, payload); };
  video.src = '/media/one.mp4'; video.load(); await video.play();
  video.src = '/media/two.mp4'; video.load(); await video.play();
  assert.deepEqual(order, ['begin', 'begin', 'play', 'begin', 'begin', 'play']);
  assert.equal(f.bridge.plays, 2);
  assert.equal(f.bridge.stops, 0);
});

test('MPV source replacement keeps the JavaScript path connected to native in-place policy', () => {
  const reset = source.slice(source.indexOf('function resetToDomSource('), source.indexOf('\n  function add('));
  assert.match(reset, /fixedNative && next && bridge\.begin/);
  assert.match(reset, /else if \(bridge\.stop\) bridge\.stop\(\)/);
  assert.match(mpvBridgeSource, /@JavascriptInterface public void begin\(String id\)[\s\S]*if \(destroyed \|\| stopFence\.isActive\(\)\) return;[\s\S]*setPropertyBoolean\("pause", true\)/);
  assert.match(mpvBridgeSource, /old != null && !old\.source\.equals\(source\)[\s\S]*mayReplaceInPlace\(old, nextMode\)/);
});

test('MPV software source replacement is bounded to a healthy shared player and Surface', () => {
  const policy = fs.readFileSync(require.resolve('../android/app/src/mpv/java/rocks/aston/hongguotv/MpvSourceTransitionPolicy.java'), 'utf8');
  assert.match(policy, /currentMode == MpvDecodeMode\.SOFTWARE/);
  assert.match(policy, /nextMode == MpvDecodeMode\.SOFTWARE/);
  assert.match(policy, /currentSessionReady/);
  assert.match(policy, /samePlayerAndSurface/);
  assert.match(policy, /!stopFenceActive/);
  assert.match(policy, /!background/);
  assert.match(mpvBridgeSource, /target\.player\.command\(new String\[\]\{"loadfile", target\.source, "replace"\}\)/);
  assert.match(mpvBridgeSource, /target\.inPlaceReplacement/);
});

test('MPV bridge keeps source replacement serialized and isolates delayed native events', () => {
  const transition = mpvBridgeSource.slice(mpvBridgeSource.indexOf('private void requestStop('), mpvBridgeSource.indexOf('private void retire('));
  const start = mpvBridgeSource.slice(mpvBridgeSource.indexOf('private void start(Session target)'), mpvBridgeSource.indexOf('/** Create/configure the player client'));
  assert.match(transition, /stopFence\.begin\(requestId, expectEndFile\)[\s\S]*player\.commandAsync\(new String\[\]\{"stop"\}, requestId\)/);
  assert.match(mpvBridgeSource, /stopFence\.onCommandReply\(requestId, error\)/);
  assert.match(mpvBridgeSource, /stopFence\.onEndFile\(\)/);
  assert.match(mpvBridgeSource, /stopFence\.onEventsDrained\(\)/);
  assert.match(mpvBridgeSource, /handler\.postDelayed\(stopTimeout, 3000\)/);
  assert.match(start, /setPropertyBoolean\("pause", true\)[\s\S]*command\(new String\[\]\{"loadfile", target\.source, "replace"\}\)/);
  assert.match(mpvBridgeSource, /final Session observed = session/);
  assert.match(mpvBridgeSource, /final long observedGeneration = generation/);
  assert.match(mpvBridgeSource, /observed\.generation != observedGeneration/);
  assert.match(mpvBridgeSource, /session != observed/);
  assert.match(mpvBridgeSource, /observed\.player != active/);
  assert.match(mpvBridgeSource, /if \(!target\.output\.loaded \|\| target\.inPlaceReplacement\) return;/);
});

test('MPV bridge keeps the last rapid source request and carries pause intent across the fence', () => {
  const play = mpvBridgeSource.slice(mpvBridgeSource.indexOf('private void requestPlay('), mpvBridgeSource.indexOf('private void installSession('));
  const finish = mpvBridgeSource.slice(mpvBridgeSource.indexOf('private void finishStopBoundary('), mpvBridgeSource.indexOf('@Override public void onPause()'));
  assert.match(play, /if \(stopFence\.isActive\(\)\)[\s\S]*transition\.queue\(new Session/);
  assert.match(mpvBridgeSource, /if \(stopFence\.isActive\(\)\) \{ transition\.setPlayIntent\(false\); return; \}/);
  assert.match(mpvBridgeSource, /if \(stopFence\.isActive\(\)\) \{ transition\.setPlayIntent\(true\); return; \}/);
  assert.match(finish, /installPendingSessionIfReady\(\);/);
  assert.match(mpvTransitionSource, /T takePendingSessionWhenReady\(boolean ready\)[\s\S]*return ready \? takePendingSession\(\) : null;/);
  assert.match(mpvBridgeSource, /Boolean playIntent = transition\.takePlayIntent\(\);/);
});

test('MPV bridge waits for the stop fence before retiring a player whose Surface was lost', () => {
  const bridge = mpvBridgeSource;
  const surface = bridge.slice(bridge.indexOf('@Override public void surfaceDestroyed'), bridge.indexOf('private void dispose('));
  const stop = bridge.slice(bridge.indexOf('private void requestStop('), bridge.indexOf('private void retire('));
  const finish = bridge.slice(bridge.indexOf('private void finishStopBoundary('), bridge.indexOf('@Override public void onPause()'));
  assert.match(stop, /stopTimeout = \(\) -> \{[\s\S]*stopFence\.onTimeout\(\)[\s\S]*finishStopBoundary\(false\);/);
  assert.match(surface, /surfaceReady = false;\s*surfaceEpoch\+\+;[\s\S]*if \(action == MpvSurfaceLifecyclePolicy\.Action\.DEFER_STOPPING_SESSION\) \{[\s\S]*return;/);
  assert.doesNotMatch(surface, /DEFER_STOPPING_SESSION\) \{\s*finishStopBoundary/);
  assert.doesNotMatch(surface, /retire\(stoppingPlayer\)/);
  assert.match(surface, /MpvSurfaceLifecyclePolicy\.Action\.RECREATE_ACTIVE_SESSION\) guarded\(s/);
  assert.match(surface, /MpvSurfaceLifecyclePolicy\.Action\.RETIRE_ORPHAN/);
  assert.match(stop, /stopSurfaceEpoch = surfaceEpoch;[\s\S]*stopFence\.begin\(/);
  assert.match(finish, /boolean sameSurface = !hadFence \|\| stopSurfaceEpoch == surfaceEpoch;[\s\S]*canReuseStoppedPlayer\([\s\S]*if \(!canReuse\) retire\(stopped\);/);
  assert.match(bridge, /surfaceCreated\(SurfaceHolder surfaceHolder\)[\s\S]*installPendingSessionIfReady\(\)[\s\S]*start\(target\);/);
  assert.match(bridge, /surfaceChanged\(SurfaceHolder surfaceHolder, int format, int w, int h\)[\s\S]*installPendingSessionIfReady\(\)/);
  assert.match(bridge, /private boolean installPendingSessionIfReady\(\)[\s\S]*stopFence\.isActive\(\)[\s\S]*takePendingSessionWhenReady\(surfaceAvailable\(\)\)[\s\S]*installSession\(pending\)/);
  assert.match(bridge, /MpvStartPolicy\.mayStart\(current\(target\), target\.player != null,[\s\S]*getSurface\(\)\.isValid\(\)\)/);
});

test('MPV bridge defers holder resizes during source replacement and avoids redundant Surface layout changes', () => {
  const bounds = mpvBridgeSource.slice(mpvBridgeSource.indexOf('@JavascriptInterface public void bounds('), mpvBridgeSource.indexOf('@Override public void surfaceCreated'));
  const applyBounds = mpvBridgeSource.slice(mpvBridgeSource.indexOf('private boolean applyBounds('), mpvBridgeSource.indexOf('@Override public void surfaceCreated'));
  assert.match(bounds, /left = l; top = t; width = w; height = h;[\s\S]*applyBoundsWhenIdle\(\);/);
  assert.match(mpvBridgeSource, /addOnLayoutChangeListener\([\s\S]*applyBoundsWhenIdle\(\)/);
  assert.match(mpvBridgeSource, /private void applyBoundsWhenIdle\(\) \{\s*if \(!stopFence\.isActive\(\)\) applyBounds\(\);/);
  assert.match(applyBounds, /current\.width == w && current\.height == h[\s\S]*current\.leftMargin == l && current\.topMargin == t[\s\S]*return true;/);
});

test('MPV failure stays native, reports error and ignores late success until explicit retry', async () => {
  const f = fixture('mpv'), video = f.document.getElementById('hero-video');
  const playback = f.context.window.HongguoNativePlayback;
  let errors = 0;
  video.addEventListener('error', () => errors++);
  video.src = '/media/test.mp4'; await video.play(); const old = f.bridge.lastId;
  playback.event(old, 'error', {kind: 'first_frame_timeout'});
  playback.event(old, 'playing'); playback.progress(old, 5000, 90000);
  assert.equal(errors, 1); assert.equal(video.paused, true); assert.equal(video.currentTime, 0);
  assert.equal(f.rootClassNames.has('native-playback'), true); assert.equal(f.domVideo.src, '');
  await video.play(); assert.equal(f.bridge.plays, 2); assert.notEqual(f.bridge.lastId, old);
});

test('Media3 callback after returning to WebView cannot emit a stale ended or progress event', () => {
  const f = fixture(), video = f.document.getElementById('hero-video');
  const id = activateNative(f); let ends = 0, ticks = 0;
  video.addEventListener('ended', () => ends++); video.addEventListener('timeupdate', () => ticks++);
  f.context.window.HongguoNativePlayback.event(id, 'error');
  f.context.window.HongguoNativePlayback.event(id, 'ended');
  f.context.window.HongguoNativePlayback.progress(id, 30000, 90000);
  assert.equal(ends, 0); assert.equal(ticks, 0); video.pause();
});


test('explicitly unsupported HEVC bypasses HTML5 play before any watchdog and preserves resume position', async () => {
 const f=fixture('webview_media3',{canPlayType:type=>type.includes('avc1')?'probably':''});
 const video=f.document.getElementById('hero-video');let domPlays=0;f.domVideo.play=()=>{domPlays++;return Promise.resolve();};
 video.src='/media/hevc.mp4';video.setSourceCodec('bytevc1');f.context.window.HongguoNativePlaybackAdapter.setStartPosition(42.5);video.load();await video.play();
 assert.equal(domPlays,0);assert.equal(f.bridge.plays,1);assert.equal(f.bridge.lastPayload.start_position,42.5);
 assert.equal(f.context.window.HongguoNativePlaybackAdapter.diagnostics().switch_reason,'codec_unsupported');
 assert.equal(f.clock.now(),10000);
});

test('supported, uncertain and unavailable codec checks keep HTML5 first even on WebView 66', async () => {
 const cases=[
  {codec:'bytevc1',probe:()=> 'probably'},
  {codec:'bytevc1',probe:type=>type.includes('hev1')?'maybe':''},
  {codec:'h264',probe:()=> 'maybe'},
  {codec:'unknown',probe:()=> ''},
  {codec:'',probe:()=> ''},
  {codec:'bytevc1'},
  {codec:'bytevc1',probe:()=>{throw Error('codec API unavailable');}},
  {codec:'bytevc1',probe:()=> 'unexpected'}
 ];
 for(const c of cases){const f=fixture('webview_media3',{userAgent:'Chrome/66.0.3359.158',canPlayType:c.probe});const video=f.document.getElementById('hero-video');video.src='/media/test.mp4';video.setSourceCodec(c.codec);await video.play();assert.equal(f.bridge.plays,0,JSON.stringify(c));assert.equal(f.domVideo.paused,false);}
});

test('a negative codec check does not persist a browser-wide preference or leak into the next source', async () => {
 const f=fixture('webview_media3',{canPlayType:type=>type.includes('avc1')?'probably':''});const video=f.document.getElementById('hero-video');
 video.src='/media/hevc.mp4';video.setSourceCodec('hevc');await video.play();
 f.context.window.HongguoNativePlayback.event(f.bridge.lastId,'frame',{width:720,height:1280});
 assert.equal(f.context.window.HongguoNativePlaybackAdapter.diagnostics().final_first_frame,true);
 assert.equal(f.storage.getItem('hongguo.native-player.preference.v1'),null);
 video.src='/media/h264.mp4';video.setSourceCodec('h264');await video.play();assert.equal(f.bridge.plays,1);assert.equal(f.domVideo.paused,false);
 video.src='/media/unknown.mp4';await video.play();assert.equal(f.bridge.plays,1,'old source codec must be cleared');
});

test('negative AVC checks bypass HTML5 without affecting the fixed MPV edition', async () => {
 const f=fixture('webview_media3',{canPlayType:()=>''});const video=f.document.getElementById('hero-video');video.src='/media/avc.mp4';video.setSourceCodec('h264');await video.play();assert.equal(f.bridge.plays,1);
 const mpv=fixture('mpv',{canPlayType:()=>''});const v=mpv.document.getElementById('hero-video');v.src='/media/mpv.mp4';v.setSourceCodec('bytevc1');await v.play();assert.equal(mpv.bridge.plays,1);assert.equal(mpv.bridge.engine(),'mpv');
});
