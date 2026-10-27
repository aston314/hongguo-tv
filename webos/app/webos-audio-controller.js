(function (root) {
  'use strict';
  function create(options) {
    var video = options.video, timeout = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
    var rate = 1, muted = !!options.initialMuted, path = '', failedPath = '', foreground = true, destroyed = false;
    var generation = 0, epoch = 0, requestID = 0, worker = null, workerReady = false, routeReady = false;
    var context = null, gain = null, request = null, preparing = false, armed = false, phase = 'idle', errorCode = '';
    var timer = null, watchdog = null, resumeGuard = null, handoff = null, outputGuard = null, activating = false, pending = null, nodes = [], waiting = false, realignments = 0;
    var timeline = null, scheduledAt = 0, pcmRate = 0, pcmBytes = 0, duration = 0, syncError = 0;
    // LG webOS reports video.currentTime in 0.2-0.4 s steps and briefly stalls (then steps back) when the
    // native rate changes. Measured on an OLED65C5 (webOS 25): a 0.12 s tolerance checked every 60 ms
    // misfires even when picture and sound are aligned. So: interpolate between steps, tolerate 0.25 s,
    // and let the first 2 s after a native rate change settle before re-anchoring once.
    var SYNC_TOLERANCE = .25, SETTLE_SECONDS = 2, REALIGN_LIMIT = 6, REALIGN_DECAY = 8;
    var clock = { last: -1, t: 0, wall: 0 }, settleUntil = 0, settlePending = false, lastRealignAt = 0;
    function wallSeconds() { return (root.performance && root.performance.now ? root.performance.now() : Date.now()) / 1000; }
    function videoTime() {
      var t = Number(video.currentTime), w = wallSeconds();
      if (t !== clock.last) { clock.last = t; clock.t = t; clock.wall = w; }
      if (video.paused || waiting || video.seeking) return t;
      return clock.t + Math.min(.6, w - clock.wall) * options.readNativeRate();
    }
    function startSettle() { if (context) { settleUntil = context.currentTime + SETTLE_SECONDS; settlePending = true; } }
    function current(id) { return !destroyed && foreground && id === generation && rate !== 1 && !!path; }
    function notify() { if (options.onState) options.onState({ phase: phase, requested_rate: rate, actual_video_rate: options.readNativeRate(), audio_active: routeReady }); }
    function playing() { return !video.paused && !video.ended && !video.seeking && video.readyState >= 2 && !waiting; }
    function nativeState() {
      var external = foreground && routeReady && rate !== 1;
      options.setNativeRate(external ? rate : 1);
      options.setNativeMuted(external || muted || !foreground);
    }
    function volume() {
      if (!gain || !context) return;
      var value = muted || !foreground || !routeReady ? 0 : Math.max(0, Math.min(1, Number(video.volume) || 0));
      gain.gain.setValueAtTime(value, context.currentTime);
    }
    function stopOutput() {
      epoch++; pending = null; timeline = null;
      if (timer !== null) clear(timer); timer = null;
      if (handoff !== null) clear(handoff); handoff = null;
      if (outputGuard !== null) clear(outputGuard); outputGuard = null;
      var old = nodes; nodes = [];
      old.forEach(function (node) { node.onended = null; try { node.stop(); } catch (ignoredStop) {} try { node.disconnect(); } catch (ignoredDisconnect) {} });
    }
    function cancel() {
      generation++; preparing = false; workerReady = false; routeReady = false; armed = false;
      stopOutput();
      if (watchdog !== null) clear(watchdog); watchdog = null;
      if (resumeGuard !== null) clear(resumeGuard); resumeGuard = null; activating = false;
      if (request) request.abort(); request = null;
      if (worker) worker.terminate(); worker = null; pcmBytes = 0; pcmRate = 0;
      nativeState(); volume();
    }
    function fallback(code) {
      failedPath = path; errorCode = code || 'WEBOS_AUDIO_FAILED'; rate = 1; cancel(); phase = 'failed'; notify();
      if (context && context.suspend) context.suspend().catch(function () {});
      if (options.onFallback) options.onFallback(errorCode);
    }
    function schedule() {
      if (timer !== null) clear(timer);
      timer = timeout(pump, 60);
    }
    function outputDelay() {
      if (!context) return 0;
      var delay = Number(context.outputLatency) || Number(context.baseLatency) || 0;
      try {
        var stamp = context.getOutputTimestamp && context.getOutputTimestamp();
        var measured = stamp && stamp.contextTime > 0 ? context.currentTime - stamp.contextTime : -1;
        if (measured >= 0 && measured <= 1) delay = measured;
      } catch (ignored) {}
      return isFinite(delay) && delay >= 0 && delay <= 1 ? delay : 0;
    }
    function resetTimeline() {
      stopOutput();
      if (!armed || !worker || !playing() || !foreground || !context || context.state !== 'running') return;
      scheduledAt = context.currentTime + .15;
      // Native video changes speed at handoff; the speaker hears this PCM
      // one output-latency later. Predict both intervals, not just queue time.
      timeline = { when: scheduledAt, position: videoTime() + .15 * options.readNativeRate() + outputDelay() * rate, rate: rate };
      worker.postMessage({ type: 'reset', epoch: epoch, position: timeline.position, rate: rate });
    }
    function realign() {
      if (context && context.currentTime - lastRealignAt > REALIGN_DECAY) realignments = 0;
      lastRealignAt = context ? context.currentTime : 0;
      if (++realignments > REALIGN_LIMIT) { fallback('WEB_AUDIO_TOO_SLOW'); return; }
      resetTimeline();
    }
    function pump() {
      if (timer !== null) clear(timer); timer = null;
      if (!armed || !foreground || !playing() || !context || context.state !== 'running') return;
      if (!timeline) resetTimeline();
      if (!timeline) return;
      var now = context.currentTime;
      var audible = Math.max(0, now - outputDelay());
      syncError = timeline.position + (audible - timeline.when) * timeline.rate - videoTime();
      if (settlePending && routeReady && now >= settleUntil) { settlePending = false; realignments = 0; resetTimeline(); schedule(); return; }
      if (routeReady && audible >= timeline.when && now >= settleUntil && Math.abs(syncError) > SYNC_TOLERANCE) realign();
      if (!timeline) return;
      if (routeReady && now > scheduledAt + .2) { fallback('WEB_AUDIO_UNDERRUN'); return; }
      if (!pending && scheduledAt < now + .35 && nodes.length < 4) {
        pending = { id: ++requestID, epoch: epoch, when: scheduledAt };
        outputGuard = timeout(function () { if (pending) fallback('WSOLA_WORKER_TIMEOUT'); }, 750);
        worker.postMessage({ type: 'render', id: pending.id, epoch: epoch, frames: 4096 });
      }
      schedule();
    }
    function receive(data, id) {
      if (!current(id)) return;
      if (data.type === 'error') { if (data.epoch !== undefined && data.epoch !== epoch) return; fallback(data.code || 'WSOLA_PROCESSING'); return; }
      if (data.type === 'ready') {
        if (data.sourceId !== id) return;
        workerReady = true; preparing = false;
        if (!playing() && watchdog !== null) { clear(watchdog); watchdog = null; }
        activate(id); return;
      }
      if (data.type !== 'pcm' || !pending || data.epoch !== epoch || data.id !== pending.id || !armed || !playing()) return;
      var planned = pending; pending = null;
      if (outputGuard !== null) clear(outputGuard); outputGuard = null;
      if (planned.when < context.currentTime + .005) { realign(); schedule(); return; }
      try {
        if (!data.channels || data.channels.length < 1 || data.channels.length > 2 || data.sampleRate !== pcmRate) throw new Error('PCM_FORMAT');
        var first = new Float32Array(data.channels[0]), frames = first.length;
        if (!frames || frames > pcmRate * 2) throw new Error('PCM_SIZE');
        var buffer = context.createBuffer(data.channels.length, frames, pcmRate);
        data.channels.forEach(function (channel, index) {
          var values = new Float32Array(channel); if (values.length !== frames) throw new Error('PCM_CHANNELS');
          buffer.getChannelData(index).set(values);
        });
        var node = context.createBufferSource(); node.buffer = buffer; node.connect(gain);
        node.onended = function () { var at = nodes.indexOf(node); if (at >= 0) nodes.splice(at, 1); try { node.disconnect(); } catch (ignored) {} };
        nodes.push(node);
        node.start(planned.when); scheduledAt = planned.when + frames / pcmRate;
        if (!routeReady && handoff === null) {
          var outputEpoch = epoch;
          handoff = timeout(function () {
            handoff = null;
            if (!current(id) || outputEpoch !== epoch || !playing()) return;
            if (context.currentTime - planned.when > .06) { realign(); pump(); return; }
            try {
              routeReady = true; phase = 'playing'; nativeState(); volume(); startSettle();
              if (watchdog !== null) clear(watchdog); watchdog = null;
              notify(); pump();
            } catch (error) { fallback('VIDEO_RATE_UNSUPPORTED'); }
          }, Math.max(0, (planned.when - context.currentTime) * 1000));
        }
        if (routeReady) phase = 'playing';
        schedule();
      } catch (error) { fallback('WEB_AUDIO_OUTPUT'); }
    }
    function activate(id) {
      if (!current(id) || !workerReady || activating) return;
      function ready() {
        if (!current(id)) return;
        if (context.state !== 'running') { fallback('AUDIO_CONTEXT_SUSPENDED'); return; }
        try { armed = true; phase = playing() ? 'aligning' : 'paused'; resetTimeline(); notify(); pump(); }
        catch (error) { fallback('VIDEO_RATE_UNSUPPORTED'); }
      }
      if (context.state === 'running') { ready(); return; }
      activating = true;
      var settled = false;
      resumeGuard = timeout(function () { if (!settled && current(id)) { settled = true; activating = false; fallback('AUDIO_CONTEXT_SUSPENDED'); } }, 2000);
      var resumed;
      try { resumed = context.resume(); }
      catch (error) { settled = true; clear(resumeGuard); resumeGuard = null; activating = false; fallback('AUDIO_CONTEXT_RESUME'); return; }
      Promise.resolve(resumed).then(function () { if (settled) return; settled = true; clear(resumeGuard); resumeGuard = null; activating = false; ready(); }, function () {
        if (!settled) { settled = true; clear(resumeGuard); resumeGuard = null; activating = false; if (current(id)) fallback('AUDIO_CONTEXT_RESUME'); }
      });
    }
    function prepare() {
      if (destroyed || !foreground || rate === 1 || !path || path === failedPath || preparing) return;
      if (video.paused) { phase = 'paused'; notify(); return; }
      if (workerReady) { activate(generation); return; }
      var id = generation; preparing = true; phase = 'preparing'; errorCode = ''; notify();
      try {
        if (options.decoderBusy && options.decoderBusy()) { fallback('WEB_AUDIO_DECODER_BUSY'); return; }
        if (!context) {
          context = options.createContext(); gain = context.createGain(); gain.connect(context.destination);
          context.onstatechange = function () {
            if (foreground && armed && context.state !== 'running') {
              routeReady = false; armed = false; stopOutput(); nativeState(); volume(); activate(generation);
            }
          };
        }
        // Run resume synchronously in the user's speed-button gesture.
        if (context.state !== 'running') Promise.resolve(context.resume()).catch(function () {});
        request = options.createAbort ? options.createAbort() : null;
        watchdog = timeout(function () { if (current(id)) fallback('WEBOS_AUDIO_TIMEOUT'); }, 20000);
        function decodeAudio(audio) {
          return options.decode(audio.data, function () { return current(id); }).catch(function (error) {
            // A local MP4 extraction can be structurally valid while a particular WebOS decoder
            // rejects the generated ADTS. Give the existing Service endpoint one chance before
            // falling back to audible 1x.
            if (!audio.local || !options.requestAudioFallback || !current(id)) throw error;
            return Promise.resolve(options.requestAudioFallback(path, request && request.signal)).then(function (fallbackAudio) {
              return options.decode(fallbackAudio.data, function () { return current(id); });
            });
          });
        }
        Promise.resolve(options.requestAudio(path, request && request.signal)).then(function (audio) {
          if (!current(id)) return null;
          var bytes = Number(audio.data && audio.data.byteLength), estimated = Number(audio.duration) * Number(audio.channels) * (options.decodeRate || 24000) * 4;
          if (!bytes || bytes > 10 * 1024 * 1024 || !isFinite(estimated) || estimated <= 0 || estimated > 64 * 1024 * 1024) throw new Error('AUDIO_MEMORY_LIMIT');
          duration = Number(audio.duration);
          return decodeAudio(audio);
        }).then(function (decoded) {
          if (!current(id) || !decoded) return;
          var channels = decoded.channels || [], total = channels.reduce(function (n, channel) { return n + channel.byteLength; }, 0);
          if (!channels.length || channels.length > 2 || !total || total > 64 * 1024 * 1024) throw new Error('AUDIO_MEMORY_LIMIT');
          pcmRate = decoded.sampleRate; pcmBytes = total;
          var buffers = channels.map(function (channel) { return channel.buffer; });
          worker = options.createWorker(); worker.onmessage = function (event) { receive(event.data || {}, id); };
          worker.onerror = function () { if (current(id)) fallback('WSOLA_WORKER'); };
          worker.postMessage({ type: 'load', sourceId: id, epoch: epoch, channels: buffers, sampleRate: pcmRate }, buffers);
        }).catch(function (error) {
          if (current(id)) fallback(error && error.message === 'AUDIO_MEMORY_LIMIT' ? 'AUDIO_MEMORY_LIMIT' : error && /^[A-Z0-9_]{1,40}$/.test(error.code || '') ? error.code : 'WEBOS_AUDIO_PREPARE');
        });
      } catch (error) { if (current(id)) fallback('WEB_AUDIO_UNAVAILABLE'); }
    }
    function setRate(value, explicit) {
      value = Number(value);
      if (!isFinite(value) || value < .5 || value > 2) throw new Error('Unsupported rate');
      if (explicit) failedPath = '';
      if (value !== 1 && path && path === failedPath) return;
      if (rate === value) { if (value !== 1) prepare(); return; }
      rate = value;
      if (value === 1) { cancel(); phase = 'idle'; if (context && context.suspend) context.suspend().catch(function () {}); notify(); return; }
      if (routeReady) { try { nativeState(); realignments = 0; startSettle(); resetTimeline(); notify(); pump(); } catch (error) { fallback('VIDEO_RATE_UNSUPPORTED'); } }
      else prepare();
    }
    function setMuted(value) { muted = !!value; nativeState(); volume(); }
    function sourceChanged(value) {
      value = /^\/minireel-proxy\/media\/[a-f0-9]{24}\.mp4$/.test(value || '') ? value : '';
      if (value === path) return;
      cancel(); path = value; failedPath = ''; waiting = false; duration = 0; realignments = 0; phase = 'idle'; prepare();
    }
    function foregroundChanged(value) {
      value = !!value; if (value === foreground) return;
      foreground = value;
      if (!value) { cancel(); phase = 'background'; if (context && context.suspend) context.suspend().catch(function () {}); }
      else prepare();
    }
    function event(name) {
      if (destroyed) return;
      if (name === 'volumechange') { volume(); return; }
      if (name === 'waiting' || name === 'seeking') { waiting = true; stopOutput(); return; }
      if (name === 'pause' || name === 'ended' || name === 'error' || name === 'emptied') {
        stopOutput(); phase = workerReady ? 'paused' : phase;
        if (workerReady && watchdog !== null) { clear(watchdog); watchdog = null; }
        return;
      }
      if (name === 'playing' || name === 'seeked') { waiting = false; realignments = 0; if (armed) { resetTimeline(); pump(); } else prepare(); }
    }
    function destroy() {
      rate = 1; cancel(); destroyed = true; phase = 'destroyed';
      if (gain) gain.disconnect();
      if (context && context.close) context.close().catch(function () {});
    }
    return { setRate: setRate, getRate: function () { return rate; }, setMuted: setMuted, getMuted: function () { return muted; },
      sourceChanged: sourceChanged, foregroundChanged: foregroundChanged, event: event, destroy: destroy,
      diagnostics: function () { return { phase: phase, requested_rate: rate, actual_video_rate: options.readNativeRate(), audio_active: routeReady,
        worker_ready: workerReady, pcm_bytes: pcmBytes, sample_rate: pcmRate, duration: duration, scheduled_nodes: nodes.length,
        sync_error_ms: Math.round(syncError * 1000), output_latency_ms: Math.round(outputDelay() * 1000), error_code: errorCode }; } };
  }
  root.HongguoWebOSAudioController = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = root.HongguoWebOSAudioController;
}(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this));
