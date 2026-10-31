(function () {
  'use strict';
  function t(key, fallback, params) {
    var i18n = window.HongguoI18n;
    return i18n && i18n.t ? i18n.t(key, params, fallback) : fallback;
  }

  // WebView HTML video is the default on every supported Android version.
  // Media3 is kept as a bounded fallback for devices whose WebView cannot
  // load the media. The Android version alone does not prove which decoder or
  // surface path is stable on a vendor TV build.
  var domVideo = document.getElementById('hero-video');
  var bridge = window.HongguoNativePlayer;
  var nativeEnabled = false;
  var usingNative = false;
  var nativeAttempted = false;
  var nativeRequested = false;
  var fallbackTimer = null;
  var pendingDomResume = null;
  // Starting thresholds for device validation; tune from local diagnostics, not version assumptions.
  var FALLBACK_POLICY = { zeroProgressMs: 1800, firstFrameMs: 3000, preferenceTtlMs: 30 * 24 * 60 * 60 * 1000 };
  var PREFERENCE_KEY = 'hongguo.native-player.preference.v1';
  var fixedNative = false;
  try { nativeEnabled = !!(bridge && bridge.isAvailable && bridge.isAvailable()); } catch (ignored) {}
  try { fixedNative = !!(nativeEnabled && bridge.engine && bridge.engine() === 'mpv'); } catch (ignoredEngine) {}
  if (!domVideo || !nativeEnabled) {
    window.HongguoNativePlaybackAdapter = { enabled: false, video: function () { return domVideo; } };
    return;
  }

  var listeners = {};
  var sequence = 0;
  var loadId = 'hongguo-' + (++sequence);
  // Diagnostic identity is independent of callback IDs, which restart when
  // the page reloads. Never match a persisted snapshot from an earlier page.
  var diagnosticPage = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  var nativeDiagnosticId = '';
  var state = { source: '', currentTime: 0, startPosition: 0, duration: NaN, paused: true, ended: false, seeking: false,
    readyState: 0, videoWidth: 0, videoHeight: 0, seekPending: false, playbackRate: 1, volume: 1, muted: true, started: false };
  function now() { return Date.now(); }
  function browserVersion() {
    var match = /(?:Chrome|Chromium)\/([\d.]+)/.exec(typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');
    return match ? match[1] : '';
  }
  var webviewVersion = browserVersion();
  function preferenceBridge() {
    var preferences = window.HongguoTVPreferences;
    return !fixedNative && preferences && typeof preferences.readMedia3Preference === 'function' &&
      typeof preferences.writeMedia3Preference === 'function' && typeof preferences.clearMedia3Preference === 'function' ? preferences : null;
  }
  function readMedia3Preference() {
    if (fixedNative || !webviewVersion) return false;
    var preferences = preferenceBridge();
    if (preferences) {
      try { return preferences.readMedia3Preference(webviewVersion) === 'media3'; } catch (ignoredNativePreference) { return false; }
    }
    try {
      var storage = window.localStorage;
      var raw = storage && storage.getItem(PREFERENCE_KEY);
      if (!raw) return false;
      var value = JSON.parse(raw);
      if (value && value.engine === 'media3' && value.webview === webviewVersion && value.expires_at > now()) return true;
      storage.removeItem(PREFERENCE_KEY);
    } catch (ignoredStorage) {}
    return false;
  }
  function writeMedia3Preference() {
    if (fixedNative || !webviewVersion) return false;
    var preferences = preferenceBridge();
    var expiresAt = now() + FALLBACK_POLICY.preferenceTtlMs;
    if (preferences) {
      try { return preferences.writeMedia3Preference(webviewVersion, expiresAt) === true; } catch (ignoredNativePreference) { return false; }
    }
    try {
      var storage = window.localStorage;
      if (!storage) return false;
      storage.setItem(PREFERENCE_KEY, JSON.stringify({ engine: 'media3', webview: webviewVersion,
        expires_at: expiresAt }));
      return true;
    } catch (ignoredStorage) { return false; }
  }
  function clearMedia3Preference() {
    var preferences = preferenceBridge();
    if (preferences) {
      try { preferences.clearMedia3Preference(); } catch (ignoredNativePreference) {}
      return;
    }
    try { if (window.localStorage) window.localStorage.removeItem(PREFERENCE_KEY); } catch (ignoredStorage) {}
  }
  function newAttempt() {
    return { webview_version: webviewVersion, preferred_path: readMedia3Preference() ? 'Media3' : 'HTML5',
      active_path: fixedNative ? 'MPV' : 'HTML5', started_at: 0, metadata_ms: null, zero_progress_ms: null,
      switch_ms: null, switch_reason: '', switched: false, first_frame_ms: null, final_first_frame: false,
      final_path: '', outcome: 'idle', last_progress_at: 0, last_ready_state: 0, last_buffered_end: 0,
      last_time: 0, playing_at: 0, phase_has_metadata: false, first_frame_deadline: 0, frame_callback_requested: false,
      first_frame_wait_started_at: 0, switch_started_at: 0, media3_first_frame_ms: null,
      cache_eligible: false, cache_written: false, dom_retry: false, started: false };
  }
  var attempt = newAttempt();
  if (fixedNative) { usingNative = true; document.documentElement.classList.add('native-playback'); }

  function isNative() { return nativeEnabled && usingNative; }
  function domHasFrame() {
    return Number(domVideo.videoWidth) > 0 && Number(domVideo.videoHeight) > 0 && Number(domVideo.readyState) >= 2;
  }
  function clearFallbackTimer() {
    if (fallbackTimer !== null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  }
  function bufferedEnd() {
    try {
      var end = 0;
      for (var i = 0; i < domVideo.buffered.length; i++) end = Math.max(end, Number(domVideo.buffered.end(i)) || 0);
      return end;
    } catch (ignored) { return 0; }
  }
  function beginAttempt() {
    if (attempt.started) return;
    attempt.started = true;
    attempt.started_at = now();
    attempt.last_progress_at = attempt.started_at;
    attempt.last_ready_state = Number(domVideo.readyState) || 0;
    attempt.phase_has_metadata = attempt.last_ready_state >= 1;
    if (attempt.phase_has_metadata && attempt.metadata_ms === null) attempt.metadata_ms = 0;
    attempt.last_buffered_end = bufferedEnd();
    attempt.last_time = Number(domVideo.currentTime) || 0;
    attempt.active_path = 'HTML5';
    attempt.outcome = 'preparing';
  }
  function armZeroProgressWatchdog() {
    if (fixedNative || !nativeEnabled || usingNative || !state.source || state.paused || attempt.playing_at || attempt.final_first_frame || nativeAttempted && !attempt.dom_retry) return;
    clearFallbackTimer();
    var observed = attempt;
    var remaining = Math.max(1, FALLBACK_POLICY.zeroProgressMs - Math.max(0, now() - observed.last_progress_at));
    fallbackTimer = setTimeout(function () {
      fallbackTimer = null;
      if (attempt !== observed || usingNative || !state.source || state.paused || observed.playing_at || observed.final_first_frame || nativeAttempted && !observed.dom_retry) return;
      var idle = Math.max(0, now() - observed.last_progress_at);
      if (idle >= FALLBACK_POLICY.zeroProgressMs) {
        observed.zero_progress_ms = idle;
        if (nativeAttempted) failDomRetry('zero_progress_timeout');
        else startNativeFallback(false, 'zero_progress_timeout');
      } else armZeroProgressWatchdog();
    }, remaining);
  }
  function armFirstFrameWatchdog() {
    if (fixedNative || !nativeEnabled || usingNative || !state.source || state.paused || attempt.final_first_frame || attempt.first_frame_deadline || nativeAttempted && !attempt.dom_retry) return;
    attempt.first_frame_wait_started_at = now();
    attempt.first_frame_deadline = now() + FALLBACK_POLICY.firstFrameMs;
    clearFallbackTimer();
    var observed = attempt;
    fallbackTimer = setTimeout(function () {
      fallbackTimer = null;
      if (attempt !== observed || usingNative || !state.source || state.paused || observed.final_first_frame || nativeAttempted && !observed.dom_retry) return;
      observed.first_frame_wait_ms = Math.max(0, now() - observed.first_frame_wait_started_at);
      if (nativeAttempted) failDomRetry('first_frame_timeout');
      else startNativeFallback(false, 'first_frame_timeout');
    }, FALLBACK_POLICY.firstFrameMs);
  }
  function confirmHtmlFrame() {
    if (isNative() || !attempt.started || attempt.final_first_frame || !domHasFrame()) return;
    attempt.final_first_frame = true;
    attempt.final_path = 'HTML5';
    attempt.active_path = 'HTML5';
    attempt.first_frame_ms = Math.max(0, now() - attempt.started_at);
    attempt.outcome = 'first_frame';
    attempt.first_frame_wait_ms = attempt.first_frame_wait_started_at ? Math.max(0, now() - attempt.first_frame_wait_started_at) : null;
    clearFallbackTimer();
  }
  function watchHtmlFrame() {
    if (typeof domVideo.requestVideoFrameCallback !== 'function' || attempt.frame_callback_requested) return;
    attempt.frame_callback_requested = true;
    var observed = attempt;
    try {
      domVideo.requestVideoFrameCallback(function () {
        if (attempt === observed && !isNative() && !state.paused && domHasFrame()) confirmHtmlFrame();
      });
    } catch (ignoredFrameCallback) {}
  }
  function observeHtmlProgress(kind) {
    if (isNative() || !attempt.started || attempt.final_first_frame) return;
    var ready = Number(domVideo.readyState) || 0;
    var end = bufferedEnd();
    var position = Number(domVideo.currentTime) || 0;
    var advanced = position > attempt.last_time + 0.01;
    var firstMetadata = !attempt.phase_has_metadata && (kind === 'loadedmetadata' || ready >= 1);
    var changed = firstMetadata || ready > attempt.last_ready_state ||
      end > attempt.last_buffered_end + 0.01 || advanced;
    if (firstMetadata) {
      attempt.phase_has_metadata = true;
      if (attempt.metadata_ms === null) attempt.metadata_ms = Math.max(0, now() - attempt.started_at);
    }
    if (changed) {
      attempt.last_progress_at = now();
      attempt.last_ready_state = Math.max(attempt.last_ready_state, ready);
      attempt.last_buffered_end = Math.max(attempt.last_buffered_end, end);
      attempt.last_time = position;
    }
    if (attempt.playing_at) armFirstFrameWatchdog();
    else armZeroProgressWatchdog();
    if (advanced && attempt.playing_at && domHasFrame()) confirmHtmlFrame();
  }
  function failDomRetry(reason) {
    if (!attempt.dom_retry || attempt.final_first_frame || state.paused || usingNative) return;
    clearFallbackTimer();
    attempt.outcome = 'html5_retry_' + reason;
    proxy.error = { code: 2, message: 'html5_retry_timeout' };
    state.paused = true;
    notifyPlaybackActive(false);
    try { domVideo.pause(); } catch (ignoredPause) {}
    dispatch('error', { type: 'error', target: proxy, timeout: reason });
  }
  function isPlayPolicyRejection(error) {
    return !!(error && error.name === 'NotAllowedError');
  }
  function handleDomPlayFailure(error, observedAttempt, observedSource) {
    if (attempt !== observedAttempt || state.source !== observedSource || isNative()) return Promise.reject(error);
    clearFallbackTimer();
    if (isPlayPolicyRejection(error) || error && error.name === 'AbortError') {
      state.paused = true;
      notifyPlaybackActive(false);
      attempt.outcome = error.name === 'AbortError' ? 'html5_play_cancelled' : 'html5_play_policy_rejected';
      return Promise.reject(error);
    }
    if (error && error.name === 'NotSupportedError') attempt.cache_eligible = true;
    attempt.switch_reason = error && error.name === 'NotSupportedError' ? 'unsupported_play_rejection' : 'play_rejected';
    if (!nativeAttempted && startNativeFallback(true, attempt.switch_reason)) return Promise.resolve();
    state.paused = true;
    notifyPlaybackActive(false);
    attempt.outcome = 'html5_play_failed';
    return Promise.reject(error);
  }
  function notifyPlaybackActive(active) {
    try {
      if (window.HongguoTVInput && typeof window.HongguoTVInput.setPlaybackActive === 'function') {
        window.HongguoTVInput.setPlaybackActive(active);
      }
    } catch (ignored) {}
  }
  function dispatch(name, detail) {
    var list = (listeners[name] || []).slice();
    list.forEach(function (listener) { try { listener.call(proxy, detail || { type: name, target: proxy }); } catch (ignored) {} });
  }
  function setClass(name, value) { domVideo.classList.toggle(name, !!value); }
  function syncBounds() {
    try {
      var node = document.querySelector('.hero-media') || domVideo;
      var rect = node.getBoundingClientRect();
      var width = window.innerWidth || document.documentElement.clientWidth || 1;
      var height = window.innerHeight || document.documentElement.clientHeight || 1;
      if (rect.width > 1 && rect.height > 1 && bridge.bounds) {
        bridge.bounds(rect.left / width, rect.top / height, rect.width / width, rect.height / height);
      }
    } catch (ignored) {}
  }
  function localSource(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return (window.location.origin || '') + path;
  }
  function invokePlay() {
    if (!state.source) return;
    syncBounds();
    nativeDiagnosticId = diagnosticPage + '-' + loadId;
    var payload = JSON.stringify({ source: localSource(state.source), start_position: state.currentTime || 0,
      paused: false, speed: state.playbackRate || 1, diagnostic_id: nativeDiagnosticId });
    try { nativeRequested = true; bridge.play(loadId, payload); } catch (error) { nativeRequested = false; dispatch('error', error); }
  }
  function startNativeFallback(force, reason) {
    if (!nativeEnabled || usingNative || nativeAttempted || !state.source || !force && state.paused) return false;
    nativeAttempted = true;
    clearFallbackTimer();
    var source = state.source || domVideo.currentSrc || domVideo.src;
    var position = Number(domVideo.currentTime);
    if ((!isFinite(position) || position <= 0) && !state.started && state.startPosition > 0) position = state.startPosition;
    if (!isFinite(position) || position < 0) position = 0;
    var paused = !!state.paused;
    state.source = source || state.source;
    state.currentTime = position;
    state.duration = Number(domVideo.duration) > 0 ? Number(domVideo.duration) : NaN;
    state.paused = paused;
    state.playbackRate = Number(domVideo.playbackRate) || 1;
    state.volume = Number(domVideo.volume);
    state.muted = !!domVideo.muted;
    state.ended = false; state.seeking = false; state.readyState = 0;
    state.videoWidth = 0; state.videoHeight = 0; state.seekPending = false; state.started = false;
    attempt.switched = true;
    attempt.active_path = 'Media3';
    attempt.switch_reason = reason || 'manual';
    attempt.switch_ms = attempt.started ? Math.max(0, now() - attempt.started_at) : 0;
    attempt.switch_started_at = now();
    attempt.outcome = 'switching';
    try { domVideo.pause(); } catch (ignoredPause) {}
    usingNative = true;
    document.documentElement.classList.add('native-playback');
    dispatch('nativefallbackstart');
    loadId = 'hongguo-' + (++sequence);
    nativeRequested = false;
    try { bridge.begin(loadId); } catch (ignoredBegin) {}
    try { if (bridge.setVolume) bridge.setVolume(state.volume, state.muted); } catch (ignoredVolume) {}
    dispatch('emptied');
    if (!paused) { state.paused = false; dispatch('waiting'); invokePlay(); }
    return true;
  }
  function fallbackToDom() {
    if (fixedNative) return;
    if (!isNative()) return;
    clearFallbackTimer();
    try { if (bridge.stop) bridge.stop(); } catch (ignoredStop) {}
    clearMedia3Preference();
    var source = state.source;
    var position = Number(state.currentTime) || 0;
    var paused = !!state.paused;
    usingNative = false;
    nativeRequested = false;
    attempt.active_path = 'HTML5';
    attempt.outcome = 'media3_failed_html5_retry';
    attempt.final_first_frame = false;
    attempt.final_path = '';
    attempt.dom_retry = true;
    attempt.phase_has_metadata = false;
    attempt.first_frame_deadline = 0;
    attempt.first_frame_wait_started_at = 0;
    attempt.last_progress_at = now();
    attempt.last_ready_state = 0;
    attempt.last_buffered_end = 0;
    attempt.last_time = position;
    pendingDomResume = position > 0 ? position : null;
    loadId = 'hongguo-' + (++sequence);
    document.documentElement.classList.remove('native-playback');
    dispatch('nativefallbackend');
    try {
      state.source = source;
      state.currentTime = position; state.duration = NaN; state.readyState = 0;
      state.videoWidth = 0; state.videoHeight = 0; state.ended = false; state.seeking = false; state.started = false;
      domVideo.src = source;
      domVideo.playbackRate = state.playbackRate;
      domVideo.volume = state.volume;
      domVideo.muted = state.muted;
      domVideo.load();
      try { if (pendingDomResume !== null) { domVideo.currentTime = position; pendingDomResume = null; } } catch (ignoredSeek) {}
      state.paused = paused;
      if (!paused) {
        var observedAttempt = attempt, observedSource = state.source, playResult;
        try { playResult = domVideo.play(); }
        catch (error) { handleDomPlayFailure(error, observedAttempt, observedSource).catch(function () {}); return; }
        Promise.resolve(playResult).catch(function (error) { return handleDomPlayFailure(error, observedAttempt, observedSource); }).catch(function () {});
        if (!attempt.started) beginAttempt();
        attempt.active_path = 'HTML5';
        attempt.outcome = 'html5_retry';
        if (attempt.playing_at) armFirstFrameWatchdog(); else armZeroProgressWatchdog();
      }
    } catch (ignored) {}
  }
  function resetToDomSource(next) {
    clearFallbackTimer();
    pendingDomResume = null;
    notifyPlaybackActive(false);
    nativeRequested = false;
    nativeDiagnosticId = '';
    loadId = 'hongguo-' + (++sequence);
    if (isNative()) {
      clearFallbackTimer();
      try {
        if (fixedNative && next && bridge.begin) bridge.begin(loadId);
        else if (bridge.stop) bridge.stop();
      } catch (ignoredStop) {}
      usingNative = fixedNative;
      if (!fixedNative) document.documentElement.classList.remove('native-playback');
    }
    attempt = newAttempt();
    nativeAttempted = false;
    state.source = next;
    state.currentTime = 0; state.startPosition = 0; state.duration = NaN; state.paused = true; state.ended = false;
    state.seeking = false; state.readyState = 0; state.videoWidth = 0; state.videoHeight = 0;
    state.seekPending = false; state.started = false;
    // The MPV edition never loads media into WebView, including between episodes.
    if (!fixedNative) domVideo.src = next;
    else {
      proxy.error = null;
      proxy.networkState = next ? 2 : 0;
      dispatch('emptied');
    }
  }

  function add(name, listener) {
    if (!listeners[name]) listeners[name] = [];
    listeners[name].push(listener);
  }
  function remove(name, listener) {
    var list = listeners[name] || [], index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  var proxy = {
    getAttribute: function (name) { return name === 'src' ? (state.source || null) : domVideo.getAttribute(name); },
    setAttribute: function (name, value) { if (name === 'src') proxy.src = value; else domVideo.setAttribute(name, value); },
    removeAttribute: function (name) { if (name === 'src') proxy.src = ''; else domVideo.removeAttribute(name); },
    addEventListener: add,
    removeEventListener: remove,
    dispatchEvent: function (event) { if (event && event.type) dispatch(event.type, event); return true; },
    load: function () {
      if (!isNative()) { clearFallbackTimer(); domVideo.load(); return; }
      loadId = 'hongguo-' + (++sequence);
      nativeRequested = false;
      nativeDiagnosticId = '';
      proxy.error = null;
      state.currentTime = state.startPosition; state.duration = NaN; state.paused = true; state.ended = false; state.seeking = false;
      state.readyState = 0; state.videoWidth = 0; state.videoHeight = 0; state.seekPending = false; state.started = false;
      try { bridge.begin(loadId); } catch (ignored) {}
      dispatch('emptied');
    },
    play: function () {
      if (!isNative()) {
        state.paused = false; state.ended = false;
        beginAttempt();
        if (!attempt.final_first_frame) attempt.last_progress_at = now();
        if (!nativeAttempted && attempt.preferred_path === 'Media3' && startNativeFallback(true, 'cached_media3')) return Promise.resolve();
        var observedAttempt = attempt, observedSource = state.source;
        var result;
        try { result = domVideo.play(); } catch (error) {
          return handleDomPlayFailure(error, observedAttempt, observedSource);
        }
        if (attempt.playing_at) armFirstFrameWatchdog(); else armZeroProgressWatchdog();
        return Promise.resolve(result).catch(function (error) {
          return handleDomPlayFailure(error, observedAttempt, observedSource);
        });
      }
      if (!state.source) return Promise.reject(new Error(t('content.noMediaUrl', '没有播放地址')));
      state.paused = false; state.ended = false;
      if (nativeRequested && bridge.resume) { try { bridge.resume(); } catch (ignored) {} }
      else invokePlay();
      return Promise.resolve();
    },
    pause: function () { if (!isNative()) { state.paused = true; notifyPlaybackActive(false); clearFallbackTimer(); attempt.first_frame_deadline = 0; attempt.first_frame_wait_started_at = 0; attempt.playing_at = 0; domVideo.pause(); return; } state.paused = true; notifyPlaybackActive(false); if (bridge.pause) try { bridge.pause(); } catch (ignored) {} dispatch('pause'); },
    classList: domVideo.classList,
    style: domVideo.style,
    error: null,
    networkState: 0,
    buffered: { length: 0, start: function () { return 0; }, end: function () { return 0; } }
  };
  Object.defineProperties(proxy, {
    src: { get: function () { return isNative() ? state.source : domVideo.src; }, set: function (value) {
      var next = value == null ? '' : String(value);
      if (!isNative()) {
        resetToDomSource(next); return;
      }
      if (next !== state.source) { resetToDomSource(next); return; }
      state.source = next; proxy.networkState = state.source ? 2 : 0; if (!state.source) setClass('has-source', false);
    } },
    currentTime: { get: function () { return isNative() ? state.currentTime : domVideo.currentTime; }, set: function (value) { if (!isNative()) { domVideo.currentTime = value; return; } var next = Number(value); if (!isFinite(next)) return; state.seeking = true; state.seekPending = true; state.currentTime = Math.max(0, next); dispatch('seeking'); if (bridge.seekTo) try { bridge.seekTo(state.currentTime); } catch (ignored) {} } },
    duration: { get: function () { return isNative() ? state.duration : domVideo.duration; } },
    paused: { get: function () { return isNative() ? state.paused : domVideo.paused; } },
    ended: { get: function () { return isNative() ? state.ended : domVideo.ended; } },
    seeking: { get: function () { return isNative() ? state.seeking : domVideo.seeking; } },
    readyState: { get: function () { return isNative() ? state.readyState : domVideo.readyState; } },
    videoWidth: { get: function () { return isNative() ? state.videoWidth : domVideo.videoWidth; } },
    videoHeight: { get: function () { return isNative() ? state.videoHeight : domVideo.videoHeight; } },
    playbackRate: { get: function () { return isNative() ? state.playbackRate : domVideo.playbackRate; }, set: function (value) { if (!isNative()) { domVideo.playbackRate = value; return; } var next = Number(value); if (!isFinite(next) || next <= 0) return; state.playbackRate = next; if (bridge.setSpeed) try { bridge.setSpeed(next); } catch (ignored) {} } },
    defaultPlaybackRate: { get: function () { return isNative() ? state.playbackRate : domVideo.defaultPlaybackRate; }, set: function (value) { proxy.playbackRate = value; } },
    volume: { get: function () { return isNative() ? state.volume : domVideo.volume; }, set: function (value) { if (!isNative()) { domVideo.volume = value; return; } var next = Math.max(0, Math.min(1, Number(value))); if (!isFinite(next)) return; state.volume = next; state.muted = next === 0; if (bridge.setVolume) try { bridge.setVolume(next, state.muted); } catch (ignored) {} dispatch('volumechange'); } },
    muted: { get: function () { return isNative() ? state.muted : domVideo.muted; }, set: function (value) { if (!isNative()) { domVideo.muted = value; return; } state.muted = !!value; if (bridge.setVolume) try { bridge.setVolume(state.volume, state.muted); } catch (ignored) {} dispatch('volumechange'); } }
  });

  window.HongguoNativePlayback = {
    event: function (id, name, detail) {
      if (!isNative() || id !== loadId) return;
      detail = detail || {};
      if (name === 'buffering' || name === 'waiting') { state.readyState = 1; state.seeking = false; dispatch('waiting', detail); return; }
      if (name === 'outputstate') { dispatch('nativeoutputstate', { type: 'nativeoutputstate', coreIdle: detail.core_idle }); return; }
      if (name === 'frame') {
        state.readyState = 3; state.videoWidth = Number(detail.width) || 0; state.videoHeight = Number(detail.height) || 0;
        if (!fixedNative && attempt.switched) {
          attempt.final_first_frame = true;
          attempt.final_path = 'Media3';
          attempt.active_path = 'Media3';
          attempt.first_frame_ms = attempt.started ? Math.max(0, now() - attempt.started_at) : null;
          attempt.media3_first_frame_ms = attempt.switch_started_at ? Math.max(0, now() - attempt.switch_started_at) : null;
          attempt.outcome = 'first_frame';
          if (attempt.cache_eligible) attempt.cache_written = writeMedia3Preference();
          clearFallbackTimer();
        }
        // Keep the rendered-frame signal separate from `playing`. Some
        // Android 9 WebViews receive this callback first; app.js can reveal
        // the real native surface without treating the episode as started
        // for history/progress purposes.
        dispatch('nativeframe', { type: 'nativeframe', nativeFrame: true, width: state.videoWidth, height: state.videoHeight, coreIdle: detail.core_idle });
        dispatch('loadedmetadata'); dispatch('loadeddata'); dispatch('canplay'); return;
      }
      if (name === 'playing') { state.started = true; state.paused = false; state.ended = false; state.seeking = false; state.readyState = Math.max(3, state.readyState); notifyPlaybackActive(true); dispatch('playing', detail); return; }
      if (name === 'paused') { state.paused = true; notifyPlaybackActive(false); dispatch('pause', detail); return; }
      if (name === 'ended') { state.ended = true; state.paused = true; state.seeking = false; notifyPlaybackActive(false); dispatch('ended', detail); return; }
      if (name === 'error') {
        notifyPlaybackActive(false);
        if (fixedNative) {
          state.paused = true; state.started = false; state.readyState = 0;
          nativeRequested = false;
          loadId = 'hongguo-' + (++sequence);
          proxy.error = { code: 3, message: detail.kind || t('content.mpvFailed', 'MPV 播放失败') };
          dispatch('error', { type: 'error', target: proxy, detail: detail });
        } else fallbackToDom();
      }
    },
    progress: function (id, position, duration) {
      if (!isNative() || id !== loadId) return;
      // PlayerBridge reports both values in milliseconds. Keep the adapter's
      // HTMLMediaElement-compatible state in seconds; leaving position in ms
      // makes the timeline clamp to 100% almost immediately on native playback.
      var positionMs = Number(position);
      var durationMs = Number(duration);
      state.currentTime = isFinite(positionMs) && positionMs >= 0 ? positionMs / 1000 : 0;
      state.duration = isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : NaN;
      if (isFinite(state.duration) && state.currentTime > state.duration) state.currentTime = state.duration;
      if (state.seekPending) { state.seekPending = false; state.seeking = false; dispatch('seeked'); } else state.seeking = false; dispatch('timeupdate');
    }
  };
  ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'pause', 'ended', 'timeupdate', 'progress', 'waiting', 'seeking', 'seeked', 'ratechange', 'volumechange', 'emptied', 'error'].forEach(function (name) {
    domVideo.addEventListener(name, function (event) {
      if (isNative()) return;
      if (name === 'loadedmetadata' && pendingDomResume !== null) {
        try { domVideo.currentTime = pendingDomResume; pendingDomResume = null; } catch (ignoredResume) {}
      }
      if (name === 'playing') {
        state.started = true; state.paused = false;
        notifyPlaybackActive(true);
        if (attempt.final_first_frame) clearFallbackTimer();
      }
      else if (name === 'pause') { state.paused = true; notifyPlaybackActive(false); clearFallbackTimer(); attempt.first_frame_deadline = 0; attempt.first_frame_wait_started_at = 0; }
      else if (name === 'ended') { state.ended = true; state.paused = true; notifyPlaybackActive(false); clearFallbackTimer(); }
      else if (name === 'error') {
        notifyPlaybackActive(false);
        clearFallbackTimer();
        var mediaErrorCode = domVideo.error && Number(domVideo.error.code) || 0;
        attempt.cache_eligible = mediaErrorCode === 3 || mediaErrorCode === 4;
        attempt.switch_reason = mediaErrorCode === 3 ? 'decode_error' : mediaErrorCode === 4 ? 'unsupported_error' : mediaErrorCode === 2 ? 'network_error' : 'media_error';
        attempt.outcome = 'html5_error_' + attempt.switch_reason;
        if (startNativeFallback(true, attempt.switch_reason)) return;
      }
      if (name === 'playing') {
        attempt.playing_at = now();
        attempt.last_time = Number(domVideo.currentTime) || 0;
        observeHtmlProgress(name);
        armFirstFrameWatchdog();
        watchHtmlFrame();
      } else if (name === 'loadedmetadata' || name === 'loadeddata' || name === 'canplay' || name === 'progress' || name === 'timeupdate') {
        observeHtmlProgress(name);
      }
      dispatch(name, event);
    });
  });
  window.HongguoNativePlaybackAdapter = {
    enabled: true,
    engine: fixedNative ? 'mpv' : 'webview_media3',
    video: function () { return proxy; },
    isNative: isNative,
    nativeDiagnostics: function () {
      if (!isNative() || !state.source || !nativeDiagnosticId) return {};
      try {
        var value = JSON.parse(bridge.diagnostics());
        return value && value.diagnostic_id === nativeDiagnosticId ? value : {};
      } catch (ignoredDiagnostic) { return {}; }
    },
    diagnostics: function () {
      if (fixedNative) return null;
      var value = attempt;
      if (value.outcome === 'idle') return null;
      var waitingForFrame = value.started && !value.final_first_frame;
      return {
        webview_version: value.webview_version || '', preferred_path: value.preferred_path || 'HTML5',
        active_path: value.active_path || 'HTML5', final_path: value.final_path || '',
        switched: !!value.switched, switch_reason: value.switch_reason || '', outcome: value.outcome || 'idle',
        metadata_ms: value.metadata_ms, zero_progress_ms: value.zero_progress_ms, switch_ms: value.switch_ms,
        html5_elapsed_ms: value.started ? Math.max(0, now() - value.started_at) : null,
        zero_progress_wait_ms: value.started && !value.playing_at && waitingForFrame ? Math.max(0, now() - value.last_progress_at) : null,
        first_frame_ms: value.first_frame_ms,
        first_frame_wait_ms: value.first_frame_wait_ms !== null && value.first_frame_wait_ms !== undefined ? value.first_frame_wait_ms : value.first_frame_wait_started_at && waitingForFrame ? Math.max(0, now() - value.first_frame_wait_started_at) : null,
        media3_first_frame_ms: value.media3_first_frame_ms,
        media3_wait_ms: value.switched && !value.final_first_frame && value.switch_started_at ? Math.max(0, now() - value.switch_started_at) : null,
        final_first_frame: !!value.final_first_frame,
        cache_written: !!value.cache_written
      };
    },
    setStartPosition: function (seconds) {
      var value = Number(seconds);
      state.startPosition = isFinite(value) && value > 0 ? Math.min(value, 86400) : 0;
      if (isNative()) state.currentTime = state.startPosition;
    },
    syncBounds: syncBounds,
    enableNative: function () { return startNativeFallback(true); }
  };
  // app.js intentionally keeps its established DOM lookup contract. Redirect
  // only this media element so existing focus, history and test seams remain
  // unchanged while the native adapter supplies the media-like surface.
  var originalGetElementById = document.getElementById.bind(document);
  document.getElementById = function (id) { return id === 'hero-video' ? proxy : originalGetElementById(id); };
  window.addEventListener('resize', syncBounds);
  window.addEventListener('orientationchange', syncBounds);
}());
