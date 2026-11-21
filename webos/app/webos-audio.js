(function (root) {
  'use strict';
  function install(window, document) {
    if (!window.HongguoWebOS || !window.HongguoWebOSAudioController) return null;
    var video = document.querySelector('#hero-video'), prototype = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (!video || !prototype) return null;
    var rawRate = Object.getOwnPropertyDescriptor(prototype, 'playbackRate'), rawDefault = Object.getOwnPropertyDescriptor(prototype, 'defaultPlaybackRate'), rawMuted = Object.getOwnPropertyDescriptor(prototype, 'muted');
    var Context = window.AudioContext || window.webkitAudioContext, Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var supported = !!(Context && Offline && window.Worker && rawRate && rawRate.set && rawDefault && rawDefault.set && rawMuted && rawMuted.set);
    var controller = null, context = null, observer = null, decoderBusy = false, previous = {}, installed = [], stateKey = '';
    var warmEntry = null, warmDecode = null, decodePending = null, sourcePath = '', warmHits = 0, warmStatus = 'idle';
    var PCM_LIMIT = 64 * 1024 * 1024, WARM_LIMIT = 32 * 1024 * 1024;
    var later = window.setTimeout || setTimeout, clear = window.clearTimeout || clearTimeout;
    var key = 'hongguo-webos-audible-speed';
    function event(name, detail) { var e = document.createEvent('CustomEvent'); e.initCustomEvent(name, false, false, detail || {}); video.dispatchEvent(e); }
    function fail(code) { var e = new Error(code); e.code = code; return e; }
    function abortController() {
      var callbacks = [], signal = { aborted: false,
        addEventListener: function (_, fn) { callbacks.push(fn); },
        removeEventListener: function (_, fn) { var i = callbacks.indexOf(fn); if (i >= 0) callbacks.splice(i, 1); }
      };
      return { signal: signal, abort: function () { if (signal.aborted) return; signal.aborted = true; var all = callbacks.slice(); callbacks = []; all.forEach(function (fn) { fn(); }); } };
    }
    function requestAudio(media, signal) {
      return new Promise(function (resolve, reject) {
        var xhr = new window.XMLHttpRequest(), settled = false;
        function finish(error, result) { if (settled) return; settled = true; if (signal) signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(result); }
        function abort() { xhr.abort(); finish(fail('WEBOS_AUDIO_CANCELLED')); }
        function limit() { if (Number(xhr.getResponseHeader('Content-Length')) > 10 * 1024 * 1024) { finish(fail('AUDIO_MEMORY_LIMIT')); xhr.abort(); } }
        xhr.open('GET', '/api/v1/player/audio?media=' + encodeURIComponent(media), true);
        xhr.responseType = 'arraybuffer'; xhr.timeout = 20000;
        xhr.onreadystatechange = function () { if (xhr.readyState === 2) limit(); };
        xhr.onprogress = function (e) { if (e.loaded > 10 * 1024 * 1024) { finish(fail('AUDIO_MEMORY_LIMIT')); xhr.abort(); } };
        xhr.onload = function () {
          if (xhr.status !== 200) {
            var code = 'WEBOS_AUDIO_SOURCE';
            try {
              if (xhr.response && xhr.response.byteLength <= 16384) {
                var bytes = new Uint8Array(xhr.response), text = '';
                for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
                var payload = JSON.parse(text);
                if (/^[A-Z0-9_]{1,40}$/.test(payload.error || '')) code = payload.error;
              }
            } catch (ignored) {}
            finish(fail(code)); return;
          }
          limit();
          finish(null, { data: xhr.response, duration: Number(xhr.getResponseHeader('X-Hongguo-Audio-Duration')), channels: Number(xhr.getResponseHeader('X-Hongguo-Audio-Channels')) });
        };
        xhr.onerror = function () { finish(fail('WEBOS_AUDIO_NETWORK')); };
        xhr.ontimeout = function () { finish(fail('WEBOS_AUDIO_TIMEOUT')); };
        xhr.onabort = function () { finish(fail('WEBOS_AUDIO_CANCELLED')); };
        if (signal) { signal.addEventListener('abort', abort); if (signal.aborted) { abort(); return; } }
        xhr.send();
      });
    }
    function waitFor(promise, signal) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error, value) {
          if (settled) return; settled = true;
          if (signal) signal.removeEventListener('abort', aborted);
          if (error) reject(error); else resolve(value);
        }
        function aborted() { finish(fail('WEBOS_AUDIO_CANCELLED')); }
        if (signal) { signal.addEventListener('abort', aborted); if (signal.aborted) { aborted(); return; } }
        promise.then(function (value) { finish(null, value); }, function (error) { finish(error); });
      });
    }
    function decode(data, isCurrent, limit) {
      if (!isCurrent()) return Promise.resolve(null);
      // Platform decodeAudioData cannot be cancelled. Do not accumulate a
      // queue of full PCM/encoded tracks behind a slow or hung decoder.
      if (decoderBusy) return Promise.reject(fail('WEB_AUDIO_DECODER_BUSY'));
      decoderBusy = true;
      var task = new Promise(function (resolve, reject) {
        var settled = false;
        function success(buffer) {
          if (settled) return; settled = true; decoderBusy = false;
          if (!isCurrent()) { resolve(null); return; }
          if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2 || !buffer.length || buffer.length * buffer.numberOfChannels * 4 > (limit || PCM_LIMIT)) { reject(fail('AUDIO_MEMORY_LIMIT')); return; }
          var channels = [];
          for (var i = 0; i < buffer.numberOfChannels; i++) channels.push(new Float32Array(buffer.getChannelData(i)));
          resolve({ channels: channels, sampleRate: buffer.sampleRate });
        }
        function failed() { if (settled) return; settled = true; decoderBusy = false; reject(fail('WEB_AUDIO_DECODE')); }
        try { var decoder = new Offline(2, 1, 24000), result = decoder.decodeAudioData(data, success, failed); if (result && result.then) result.then(success, failed); } catch (e) { failed(); }
      });
      decodePending = task.then(function () {}, function () {});
      return task;
    }
    function releaseWarm(entry) {
      clear(entry.timer);
      if (entry.signal) entry.signal.removeEventListener('abort', entry.abort);
    }
    function cancelWarm() {
      var entry = warmEntry; warmEntry = null;
      if (entry) { releaseWarm(entry); entry.cancel.abort(); warmStatus = 'cancelled'; }
    }
    function warmBudget() {
      var used = controller ? Number(controller.diagnostics().pcm_bytes) || 0 : PCM_LIMIT;
      // Include both the platform AudioBuffer and its transferable PCM copy.
      return Math.max(0, Math.min(WARM_LIMIT, Math.floor((PCM_LIMIT - used) / 2)));
    }
    function warm(media, signal) {
      var local = window.HongguoWebOSLocalAudio;
      var path = window.HongguoWebOS.mediaPath(media || '');
      var state = controller && controller.diagnostics();
      if (!local || !controller || document.hidden || video.paused || video.ended || controller.getRate() === 1 ||
          !state.worker_ready || !/^\/minireel-proxy\/media\/[a-f0-9]{24}\.mp4$/.test(path) || signal && signal.aborted) return;
      if (warmEntry && warmEntry.path === path) return;
      cancelWarm();
      if (decoderBusy) return;
      var entry = { path: path, signal: signal, cancel: abortController(), value: null };
      entry.abort = function () { if (warmEntry === entry) cancelWarm(); };
      if (signal) signal.addEventListener('abort', entry.abort);
      warmEntry = entry; warmStatus = 'extracting';
      entry.timer = later(function () { if (warmEntry === entry) cancelWarm(); }, 120000);
      function current() { return !entry.cancel.signal.aborted && !!controller; }
      entry.promise = Promise.resolve().then(function () {
        if (!current()) return null;
        return local.extract(path, entry.cancel.signal, { maxPCMBytes: warmBudget(), maxReadBytes: 16 * 1024 * 1024 });
      }).then(function (audio) {
        if (!audio || !current()) return null;
        // Assume stereo even for a mono core (HE-AACv2 PS). Preflight before
        // allocating native decoded data, then verify the actual result too.
        var estimate = Number(audio.duration) * 2 * 24000 * 4, budget = warmBudget();
        if (!audio.data || !audio.data.byteLength || audio.data.byteLength > 10 * 1024 * 1024 ||
            !isFinite(estimate) || estimate <= 0 || estimate > budget) throw fail('AUDIO_MEMORY_LIMIT');
        warmDecode = entry; warmStatus = 'decoding';
        return decode(audio.data, current, budget).then(function (decoded) {
          if (warmDecode === entry) warmDecode = null;
          if (!decoded || !current()) return null;
          entry.value = { decoded: decoded, duration: audio.duration, channels: decoded.channels.length, local: true, prewarmed: true };
          warmStatus = 'ready';
          return entry.value;
        }, function (error) { if (warmDecode === entry) warmDecode = null; throw error; });
      }).catch(function () { if (warmEntry === entry) { cancelWarm(); warmStatus = 'skipped'; } return null; });
    }
    function readAudio(media, signal) {
      var local = window.HongguoWebOSLocalAudio;
      if (!local) return requestAudio(media, signal);
      return local.extract(media, signal).then(function (audio) { audio.local = true; return audio; }).catch(function (error) {
        if (signal && signal.aborted || error && error.code === 'WEBOS_AUDIO_CANCELLED') throw fail('WEBOS_AUDIO_CANCELLED');
        return requestAudio(media, signal);
      });
    }
    function foregroundAudio(media, signal) {
      var entry = warmEntry;
      if (entry && entry.path === media) {
        warmEntry = null; releaseWarm(entry);
        function abort() { entry.cancel.abort(); }
        if (signal) { signal.addEventListener('abort', abort); if (signal.aborted) abort(); }
        return waitFor(entry.promise, signal).then(function (audio) {
          if (signal) signal.removeEventListener('abort', abort);
          if (audio) { warmHits++; warmStatus = 'used'; return audio; }
          return readAudio(media, signal);
        }, function (error) { if (signal) signal.removeEventListener('abort', abort); throw error; });
      }
      cancelWarm();
      // A cancelled speculative decode cannot be interrupted by WebAudio.
      // Wait without fetching another track or starting a second decoder.
      return waitFor(warmDecode ? decodePending : Promise.resolve(), signal).then(function () { return readAudio(media, signal); });
    }
    function sourceChanged() {
      var path = window.HongguoWebOS.mediaPath(video.getAttribute('src') || '');
      // Episode replacement temporarily clears src before attaching the target.
      // The prefetch owner's signal still cancels an abandoned navigation.
      if (path !== sourcePath) { sourcePath = path; if (path && warmEntry && warmEntry.path !== path) cancelWarm(); }
      if (controller) controller.sourceChanged(path);
    }
    function disable() {
      cancelWarm();
      if (observer) observer.disconnect(); observer = null;
      if (controller) controller.destroy(); controller = null; context = null; stateKey = '';
      installed.forEach(function (name) { if (previous[name]) Object.defineProperty(video, name, previous[name]); else delete video[name]; }); installed = [];
    }
    function enable() {
      if (controller) return true;
      if (!supported) return false;
      var speed = rawRate.get.call(video);
      controller = window.HongguoWebOSAudioController.create({
        video: video, initialMuted: rawMuted.get.call(video), decodeRate: 24000,
        createContext: function () { if (!context) context = new Context(); return context; },
        createWorker: function () { return new window.Worker('./webos-audio-worker.js'); },
        createAbort: abortController, decoderBusy: function () { return decoderBusy && !warmDecode; },
        readNativeRate: function () { return rawRate.get.call(video); },
        setNativeRate: function (value) { if (rawRate.get.call(video) !== value) rawRate.set.call(video, value); if (rawDefault.get.call(video) !== value) rawDefault.set.call(video, value); },
        setNativeMuted: function (value) { if (rawMuted.get.call(video) !== value) rawMuted.set.call(video, value); },
        requestAudio: foregroundAudio, requestAudioFallback: requestAudio, decode: decode,
        onState: function (data) { if (data.requested_rate === 1) cancelWarm(); var next = data.phase + ':' + data.requested_rate + ':' + data.actual_video_rate; if (next !== stateKey) { stateKey = next; event('webosaudiostate', data); event('ratechange'); } },
        onFallback: function (code) { event('webosaudiofallback', { code: code }); event('ratechange'); }
      });
      try {
        [['playbackRate', controller.getRate, controller.setRate], ['defaultPlaybackRate', controller.getRate, controller.setRate], ['muted', controller.getMuted, controller.setMuted]].forEach(function (entry) {
          previous[entry[0]] = Object.getOwnPropertyDescriptor(video, entry[0]);
          Object.defineProperty(video, entry[0], { configurable: true, get: entry[1], set: entry[2] }); installed.push(entry[0]);
        });
        if (window.MutationObserver) { observer = new window.MutationObserver(sourceChanged); observer.observe(video, { attributes: true, attributeFilter: ['src'] }); }
        controller.foregroundChanged(!document.hidden); sourceChanged(); controller.setRate(speed); return true;
      } catch (e) { disable(); return false; }
    }
    var api = { supported: supported, isEnabled: function () { return !!controller; },
      warm: warm, cancelWarm: cancelWarm,
      chooseSpeed: function (value) { if (!controller) return false; if (Number(value) === 1) cancelWarm(); controller.setRate(value, true); return true; },
      diagnostics: function () { var d = controller ? controller.diagnostics() : { phase: 'disabled' }; d.enabled = !!controller; d.prewarm_state = warmStatus; d.prewarm_hits = warmHits; return d; },
      choose: function (enabled) {
        enabled = enabled === true;
        if (enabled && !supported) return false;
        var before;
        try { before = window.localStorage.getItem(key); window.localStorage.setItem(key, enabled ? '1' : '0'); if (window.localStorage.getItem(key) !== (enabled ? '1' : '0')) throw new Error('Storage'); }
        catch (e) { try { window.localStorage.setItem(key, before || '0'); } catch (ignored) {} return false; }
        if (enabled && !enable()) { try { window.localStorage.setItem(key, before || '0'); } catch (ignored) {} return false; }
        if (!enabled) disable();
        event('webosaudioenabledchange', { enabled: enabled }); return true;
      }
    };
    window.HongguoWebOSAudio = api;
    ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'error', 'emptied', 'volumechange'].forEach(function (name) {
      video.addEventListener(name, function () { if (!controller) return; if (name === 'play') sourceChanged(); controller.event(name); });
    });
    video.addEventListener('loadedmetadata', sourceChanged);
    document.addEventListener('visibilitychange', function () { if (document.hidden) cancelWarm(); if (controller) controller.foregroundChanged(!document.hidden); });
    window.addEventListener('pagehide', function () { cancelWarm(); if (controller) controller.foregroundChanged(false); });
    window.addEventListener('pageshow', function () { if (controller) controller.foregroundChanged(!document.hidden); });
    window.addEventListener('unload', disable);
    try { if (supported && window.localStorage.getItem(key) === '1') enable(); } catch (ignored) {}
    return api;
  }
  if (typeof module === 'object' && module.exports) module.exports = { install: install };
  if (root && root.document) install(root, root.document);
}(typeof window !== 'undefined' ? window : null));
