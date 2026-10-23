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
  var FALLBACK_DELAY = 15000;
  // Fork patch (optimize/m7642-native-first): legacy WebView builds
  // (Chromium < 100, e.g. the Chromium 66 that ships in many Android 9 TV
  // firmware images such as the MStar M7642) routinely fail to produce a
  // frame for these streams yet never raise an error, so every play and
  // every episode switch burned the full 15 s fallback wait before Media3
  // took over. On such WebViews arm the fallback almost immediately
  // instead: the timer callback still verifies that playback was requested
  // and that no DOM frame has appeared, so a legacy WebView that does
  // manage to play keeps the DOM path, and a native failure still falls
  // back to DOM via the existing error path. Modern WebViews keep the
  // upstream 15 s behaviour unchanged.
  var LEGACY_WEBVIEW = (function () {
    try {
      var match = /Chrome\/(\d+)/.exec(navigator.userAgent || '');
      return !!match && Number(match[1]) > 0 && Number(match[1]) < 100;
    } catch (ignored) { return false; }
  })();
  var EFFECTIVE_FALLBACK_DELAY = LEGACY_WEBVIEW ? 50 : FALLBACK_DELAY;
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
  var state = { source: '', currentTime: 0, startPosition: 0, duration: NaN, paused: true, ended: false, seeking: false,
    readyState: 0, videoWidth: 0, videoHeight: 0, seekPending: false, playbackRate: 1, volume: 1, muted: true, started: false };
  if (fixedNative) { usingNative = true; document.documentElement.classList.add('native-playback'); }

  function isNative() { return nativeEnabled && usingNative; }
  function domHasFrame() {
    return Number(domVideo.videoWidth) > 0 && Number(domVideo.videoHeight) > 0 && Number(domVideo.readyState) >= 2;
  }
  function clearFallbackTimer() {
    if (fallbackTimer !== null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  }
  function armNativeFallback() {
    if (fixedNative) return;
    if (!nativeEnabled || nativeAttempted || usingNative || !state.source || state.paused) return;
    clearFallbackTimer();
    fallbackTimer = setTimeout(function () {
      fallbackTimer = null;
      if (!usingNative && !nativeAttempted && state.source && !state.paused && (!state.started || !domHasFrame())) startNativeFallback(false);
    }, EFFECTIVE_FALLBACK_DELAY);
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
    var payload = JSON.stringify({ source: localSource(state.source), start_position: state.currentTime || 0,
      paused: false, speed: state.playbackRate || 1 });
    try { nativeRequested = true; bridge.play(loadId, payload); } catch (error) { nativeRequested = false; dispatch('error', error); }
  }
  function startNativeFallback(force) {
    if (!nativeEnabled || usingNative || nativeAttempted || !state.source || !force && state.paused) return false;
    nativeAttempted = true;
    clearFallbackTimer();
    var source = state.source || domVideo.currentSrc || domVideo.src;
    var position = Number(domVideo.currentTime);
    if ((!isFinite(position) || position <= 0) && state.startPosition > 0) position = state.startPosition;
    if (!isFinite(position) || position < 0) position = 0;
    var paused = !!domVideo.paused;
    state.source = source || state.source;
    state.currentTime = position;
    state.duration = Number(domVideo.duration) > 0 ? Number(domVideo.duration) : NaN;
    state.paused = paused;
    state.playbackRate = Number(domVideo.playbackRate) || 1;
    state.volume = Number(domVideo.volume);
    state.muted = !!domVideo.muted;
    state.ended = false; state.seeking = false; state.readyState = 0;
    state.videoWidth = 0; state.videoHeight = 0; state.seekPending = false; state.started = false;
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
    var source = state.source;
    var position = Number(state.currentTime) || 0;
    var paused = !!state.paused;
    usingNative = false;
    nativeRequested = false;
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
      state.paused = paused;
      if (!paused) { Promise.resolve(domVideo.play()).catch(function () {}); armNativeFallback(); }
    } catch (ignored) {}
  }
  function resetToDomSource(next) {
    clearFallbackTimer();
    notifyPlaybackActive(false);
    nativeRequested = false;
    loadId = 'hongguo-' + (++sequence);
    if (isNative()) {
      clearFallbackTimer();
      try { if (bridge.stop) bridge.stop(); } catch (ignoredStop) {}
      usingNative = fixedNative;
      if (!fixedNative) document.documentElement.classList.remove('native-playback');
    }
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
      proxy.error = null;
      state.currentTime = state.startPosition; state.duration = NaN; state.paused = true; state.ended = false; state.seeking = false;
      state.readyState = 0; state.videoWidth = 0; state.videoHeight = 0; state.seekPending = false; state.started = false;
      try { bridge.begin(loadId); } catch (ignored) {}
      dispatch('emptied');
    },
    play: function () {
      if (!isNative()) {
        state.paused = false; state.ended = false;
        var result;
        try { result = domVideo.play(); } catch (error) {
          if (startNativeFallback(true)) return Promise.resolve();
          throw error;
        }
        armNativeFallback();
        return Promise.resolve(result).catch(function (error) {
          if (startNativeFallback(true)) return Promise.resolve();
          throw error;
        });
      }
      if (!state.source) return Promise.reject(new Error(t('content.noMediaUrl', '没有播放地址')));
      state.paused = false; state.ended = false;
      if (nativeRequested && bridge.resume) { try { bridge.resume(); } catch (ignored) {} }
      else invokePlay();
      return Promise.resolve();
    },
    pause: function () { if (!isNative()) { state.paused = true; notifyPlaybackActive(false); clearFallbackTimer(); domVideo.pause(); return; } state.paused = true; notifyPlaybackActive(false); if (bridge.pause) try { bridge.pause(); } catch (ignored) {} dispatch('pause'); },
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
      if (name === 'frame') {
        state.readyState = 3; state.videoWidth = Number(detail.width) || 0; state.videoHeight = Number(detail.height) || 0;
        // Keep the rendered-frame signal separate from `playing`. Some
        // Android 9 WebViews receive this callback first; app.js can reveal
        // the real native surface without treating the episode as started
        // for history/progress purposes.
        dispatch('nativeframe', { type: 'nativeframe', nativeFrame: true, width: state.videoWidth, height: state.videoHeight });
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
  ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'pause', 'ended', 'timeupdate', 'waiting', 'seeking', 'seeked', 'ratechange', 'volumechange', 'emptied', 'error'].forEach(function (name) {
    domVideo.addEventListener(name, function (event) {
      if (isNative()) return;
      if (name === 'playing') {
        state.started = true; state.paused = false;
        notifyPlaybackActive(true);
        if (domHasFrame()) clearFallbackTimer(); else armNativeFallback();
      }
      else if (name === 'pause') { state.paused = true; notifyPlaybackActive(false); clearFallbackTimer(); }
      else if (name === 'ended') { state.ended = true; state.paused = true; notifyPlaybackActive(false); clearFallbackTimer(); }
      else if (name === 'error') {
        notifyPlaybackActive(false);
        clearFallbackTimer();
        if (startNativeFallback(true)) return;
      }
      dispatch(name, event);
    });
  });
  window.HongguoNativePlaybackAdapter = {
    enabled: true,
    engine: fixedNative ? 'mpv' : 'webview_media3',
    video: function () { return proxy; },
    isNative: isNative,
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
