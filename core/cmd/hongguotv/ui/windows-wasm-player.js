(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.HongguoWindowsWasm = api; api.install(root); }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var KEY = 'hongguo.windows-decoder.v1';
  function supported(config) { return !!(config && config.platform === 'windows' && config.wasmDecoder === true); }
  function preference(storage) { try { return storage.getItem(KEY) === 'wasm' ? 'wasm' : 'default'; } catch (_) { return 'default'; } }
  function choose(storage, value) {
    if (value !== 'wasm' && value !== 'default') return false;
    try { storage.setItem(KEY, value); return preference(storage) === value; } catch (_) { return false; }
  }
  function renderer(canvas) {
    var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
    if (!gl) throw Error('render');
    function shader(type, source) { var s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error('render'); return s; }
    var program = gl.createProgram();
    var vertex = shader(gl.VERTEX_SHADER, 'attribute vec2 p;varying vec2 uv;void main(){gl_Position=vec4(p,0.,1.);uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);}');
    var fragment = shader(gl.FRAGMENT_SHADER, 'precision mediump float;varying vec2 uv;uniform sampler2D y;uniform sampler2D u;uniform sampler2D v;uniform vec4 coef;uniform vec2 range;void main(){float Y=(texture2D(y,uv).r-range.x)*range.y;float U=texture2D(u,uv).r-.5;float V=texture2D(v,uv).r-.5;gl_FragColor=vec4(Y+coef.x*V,Y-coef.y*U-coef.z*V,Y+coef.w*U,1.);}');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error('render');
    gl.useProgram(program);
    var buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    var point = gl.getAttribLocation(program, 'p'); gl.enableVertexAttribArray(point); gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
    var textures = [], names = ['y', 'u', 'v'];
    names.forEach(function (name, i) {
      var texture = gl.createTexture(); textures.push(texture); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), i);
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    return {
      draw: function (frame) {
        var w = frame.width, h = frame.height, cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
        gl.useProgram(program);
        var bytes = new Uint8Array(frame.data), sizes = [[w,h,0],[cw,ch,w*h],[cw,ch,w*h+cw*ch]];
        sizes.forEach(function (size, i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, textures[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, size[0], size[1], 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes.subarray(size[2], size[2] + size[0] * size[1])); });
        var scale = frame.fullrange ? 1 : 255 / 224;
        var coefficients = frame.colorspace === 1 ? [1.5748,.187324,.468124,1.8556] : [1.402,.344136,.714136,1.772];
        gl.uniform4fv(gl.getUniformLocation(program, 'coef'), coefficients.map(function (v) { return v * scale; }));
        gl.uniform2f(gl.getUniformLocation(program, 'range'), frame.fullrange ? 0 : 16 / 255, frame.fullrange ? 1 : 255 / 219);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      close: function () { textures.forEach(function (texture) { gl.deleteTexture(texture); }); gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment); }
    };
  }
  function install(win) {
    if (!supported(win.HongguoDesktop)) return null;
    var doc = win.document, originalLookup = doc.getElementById.bind(doc), dom = originalLookup('hero-video');
    if (!dom) return null;
    var listeners = {}, frames = [], audioQueue = [], sources = [], callbacks = {}, callbackID = 0;
    var worker = null, context = null, canvas = null, paint = null, mode = 'default', source = '', sourceCodec = '';
    var generation = 0, frameLoop = 0, clockTimer = 0, lastTimeEvent = 0, seekTarget = 0, first = true, inputEnd = false;
    var anchor = null, anchorPTS = 0, scheduledUntil = 0, requestedPlay = false;
    var state = { currentTime: 0, duration: NaN, paused: true, ended: false, seeking: false, readyState: 0, networkState: 0, videoWidth: 0, videoHeight: 0, volume: dom.volume, muted: dom.muted, playbackRate: dom.playbackRate || 1, error: null, audio: false };
    var stats = { decoded: 0, presented: 0, dropped: 0, decodeMs: 0, lastPTS: 0, avsync: 0 };
    function isWasm() { return mode === 'wasm'; }
    function text(key, fallback) { return win.HongguoI18n ? win.HongguoI18n.t(key, null, fallback) : fallback; }
    function emit(name) { (listeners[name] || []).slice().forEach(function (fn) { fn.call(proxy, new win.Event(name)); }); }
    function send(value) { if (worker) { value.generation = generation; worker.postMessage(value); } }
    function release(frame) { if (frame) send({ type: 'credit' }); }
    function stopAudio() {
      sources.forEach(function (node) { try { node.stop(); } catch (_) {} }); sources = [];
      audioQueue = []; scheduledUntil = 0; anchor = null;
    }
    function stop() {
      generation++; requestedPlay = false;
      if (worker) worker.terminate(); worker = null;
      if (frameLoop) win.cancelAnimationFrame(frameLoop); frameLoop = 0;
      if (clockTimer) win.clearInterval(clockTimer); clockTimer = 0;
      stopAudio(); frames = []; callbacks = {};
      if (context) { context.close().catch(function () {}); context = null; }
      if (paint) paint.close(); paint = null;
      if (canvas) canvas.remove(); canvas = null;
      dom.style.removeProperty('display');
    }
    function error(code) {
      requestedPlay = false; state.paused = true; state.networkState = 3;
      state.error = { code: code === 'network' ? 2 : code === 'codec' ? 4 : 3,
        message: text(code === 'codec' ? 'settings.windowsWasmUnsupported' : 'settings.windowsWasmFailed', code === 'codec' ? '此编码暂不支持 CPU 软解，请切回默认播放。' : 'CPU 软解未能播放，请重试或切回默认播放。') };
      if (worker) worker.terminate(); worker = null;
      stopAudio(); if (context) context.suspend().catch(function () {});
      emit('error');
    }
    function time() {
      if (anchor !== null && !state.paused) return Math.max(seekTarget, anchorPTS + (context.currentTime - anchor) * state.playbackRate);
      return state.currentTime;
    }
    function audioVolume() { if (context && context.hgGain) context.hgGain.gain.value = state.muted ? 0 : state.volume; }
    function scheduleAudio(chunk) {
      if (anchor === null || state.paused) { audioQueue.push(chunk); return; }
      var data = new Float32Array(chunk.data), skip = Math.max(0, Math.ceil((seekTarget - chunk.pts) * 48000));
      if (skip >= chunk.samples) return;
      var buffer = context.createBuffer(2, chunk.samples - skip, 48000);
      for (var channel = 0; channel < 2; channel++) { var out = buffer.getChannelData(channel); for (var i = skip; i < chunk.samples; i++) out[i - skip] = data[i * 2 + channel]; }
      var when = anchor + (chunk.pts + skip / 48000 - anchorPTS) / state.playbackRate;
      var offset = Math.max(0, (context.currentTime - when) * state.playbackRate);
      if (offset >= buffer.duration) return;
      var node = context.createBufferSource(); node.buffer = buffer; node.playbackRate.value = state.playbackRate; node.connect(context.hgGain);
      sources.push(node); node.onended = function () { var i = sources.indexOf(node); if (i >= 0) sources.splice(i, 1); };
      node.start(Math.max(context.currentTime, when), offset); scheduledUntil = Math.max(scheduledUntil, when + buffer.duration / state.playbackRate);
    }
    function startClock() {
      if (anchor !== null || state.paused || !frames.length || state.audio && !audioQueue.length) return;
      anchorPTS = seekTarget; anchor = context.currentTime + .10;
      var queue = audioQueue; audioQueue = []; queue.forEach(scheduleAudio);
    }
    function draw() {
      frameLoop = 0;
      if (!isWasm() || !worker && !inputEnd) return;
      startClock();
      var current = Math.max(seekTarget, time());
      if (!state.paused && anchor !== null) {
        var chosen = null;
        while (frames.length && frames[0].pts <= current + .025) { if (chosen) { stats.dropped++; release(chosen); } chosen = frames.shift(); }
        if (chosen) {
          try { paint.draw(chosen); } catch (_) { error('render'); return; }
          stats.presented++; stats.lastPTS = chosen.pts; stats.avsync = chosen.pts - current;
          state.currentTime = current; state.readyState = 4; state.networkState = 1;
          if (first || state.seeking) { first = false; state.seeking = false; emit('loadeddata'); emit('canplay'); emit('seeked'); emit('playing'); }
          Object.keys(callbacks).forEach(function (id) { var fn = callbacks[id]; delete callbacks[id]; fn(performance.now(), { mediaTime: chosen.pts, presentedFrames: stats.presented }); });
          release(chosen);
        }
        if (!frames.length && !inputEnd && current > stats.lastPTS + .25) {
          // Freeze the audio clock as well as video during an input/decode stall.
          state.currentTime = Math.max(seekTarget, stats.lastPTS); context.suspend().catch(function () {}); emit('waiting');
        }
        if (frames.length && context.state === 'suspended') context.resume().catch(function () {});
        state.currentTime = current;
        if (performance.now() - lastTimeEvent > 200) { lastTimeEvent = performance.now(); emit('timeupdate'); }
        if (inputEnd && !frames.length && (!state.audio || context.currentTime >= scheduledUntil)) {
          state.currentTime = Number.isFinite(state.duration) ? state.duration : current; state.ended = true; state.paused = true; requestedPlay = false;
          stopAudio(); context.suspend().catch(function () {}); emit('timeupdate'); emit('ended'); return;
        }
      } else if (state.paused && first && frames.length) {
        var preview = frames.shift(); paint.draw(preview); stats.presented++; stats.lastPTS = preview.pts; release(preview);
        state.readyState = 2; first = false; state.seeking = false; emit('loadeddata'); emit('canplay'); emit('seeked');
      }
      frameLoop = win.requestAnimationFrame(draw);
    }
    function open(at) {
      var playing = requestedPlay;
      stop(); requestedPlay = playing; mode = 'wasm';
      seekTarget = Math.max(0, Number(at) || 0); state.currentTime = seekTarget; state.error = null; state.ended = false; state.readyState = 0; state.networkState = 2; first = true; inputEnd = false;
      state.paused = !requestedPlay; anchor = null;
      stats = { decoded: 0, presented: 0, dropped: 0, decodeMs: 0, lastPTS: seekTarget, avsync: 0 };
      try {
        if (/^(bytevc2|bvc2)$/i.test(sourceCodec)) { error('codec'); return; }
        context = new (win.AudioContext || win.webkitAudioContext)({ sampleRate: 48000 });
        context.hgGain = context.createGain(); context.hgGain.connect(context.destination); audioVolume();
        if (state.paused) context.suspend().catch(function () {}); else context.resume().catch(function () {});
        canvas = doc.createElement('canvas'); canvas.className = dom.className + ' windows-wasm-picture'; canvas.setAttribute('aria-hidden', 'true');
        dom.parentNode.insertBefore(canvas, dom.nextSibling); dom.style.display = 'none'; paint = renderer(canvas);
        worker = new win.Worker('/windows-wasm-worker.js');
        var observed = generation;
        worker.onerror = function () { if (observed === generation) error('decode'); };
        worker.onmessage = function (event) {
          var value = event.data; if (observed !== generation || value.generation !== generation) return;
          if (value.type === 'meta') { state.videoWidth = value.width; state.videoHeight = value.height; state.duration = value.duration; state.audio = value.audio; state.readyState = 1; emit('loadedmetadata'); emit('durationchange'); }
          else if (value.type === 'video') { stats.decoded++; stats.decodeMs += value.decodeMs; if (value.pts < seekTarget - .04) release(value); else frames.push(value); }
          else if (value.type === 'audio') scheduleAudio(value);
          else if (value.type === 'end') inputEnd = true;
          else if (value.type === 'error') { error(value.code); return; }
          if (!frameLoop) frameLoop = win.requestAnimationFrame(draw);
        };
        send({ type: 'open', url: source, at: seekTarget });
        clockTimer = win.setInterval(function () { send({ type: 'clock', at: time() }); if (canvas) canvas.className = dom.className + ' windows-wasm-picture'; }, 50);
        emit('loadstart');
      } catch (_) { error('open'); }
    }
    var proxy = {
      classList: dom.classList, style: dom.style,
      getAttribute: function (name) { return name === 'src' && isWasm() ? source || null : dom.getAttribute(name); },
      setAttribute: function (name, value) { if (name === 'src') proxy.src = value; else dom.setAttribute(name, value); },
      removeAttribute: function (name) { if (name === 'src') { stop(); source = ''; sourceCodec = ''; state.paused = true; state.readyState = 0; state.videoWidth = state.videoHeight = 0; state.duration = NaN; state.error = null; dom.removeAttribute('src'); } else dom.removeAttribute(name); },
      addEventListener: function (name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); },
      removeEventListener: function (name, fn) { var list = listeners[name] || [], i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
      dispatchEvent: function (event) { emit(event.type); return true; },
      load: function () { if (!isWasm()) return dom.load(); if (source) { requestedPlay = false; open(seekTarget); } else emit('emptied'); },
      play: function () {
        if (!isWasm()) return dom.play();
        if (state.error) return Promise.reject(Error(state.error.message));
        requestedPlay = true; state.paused = false; state.ended = false;
        if (!worker) open(state.currentTime);
        if (!context) return Promise.reject(Error('WASM unavailable'));
        return context.resume().then(function () { send({ type: 'resume' }); emit('play'); if (!first && state.readyState >= 2) emit('playing'); if (!frameLoop) frameLoop = win.requestAnimationFrame(draw); });
      },
      pause: function () { if (!isWasm()) return dom.pause(); state.currentTime = time(); state.paused = true; requestedPlay = false; if (context) context.suspend().catch(function () {}); send({ type: 'pause' }); emit('pause'); },
      setSourceCodec: function (value) { sourceCodec = String(value || ''); if (isWasm() && /^(bytevc2|bvc2)$/i.test(sourceCodec)) error('codec'); },
      getVideoPlaybackQuality: function () { return isWasm() ? { totalVideoFrames: stats.decoded, droppedVideoFrames: stats.dropped } : dom.getVideoPlaybackQuality ? dom.getVideoPlaybackQuality() : {}; },
      requestVideoFrameCallback: function (fn) { if (!isWasm() && dom.requestVideoFrameCallback) return dom.requestVideoFrameCallback(fn); var id = ++callbackID; callbacks[id] = fn; return id; },
      cancelVideoFrameCallback: function (id) { if (!isWasm() && dom.cancelVideoFrameCallback) dom.cancelVideoFrameCallback(id); else delete callbacks[id]; }
    };
    Object.defineProperty(proxy, 'src', {
      get: function () { return isWasm() ? source : dom.src; },
      set: function (value) {
        stop(); dom.pause(); dom.removeAttribute('src'); dom.load();
        mode = preference(win.localStorage); source = String(value || ''); sourceCodec = ''; seekTarget = 0;
        state.volume = dom.volume; state.muted = dom.muted; state.playbackRate = dom.playbackRate || 1;
        state.paused = true; state.ended = false; state.seeking = false; state.currentTime = 0; state.duration = NaN; state.videoWidth = state.videoHeight = 0; state.readyState = 0; state.error = null;
        if (!isWasm()) dom.src = source;
      }
    });
    ['currentTime','duration','paused','ended','seeking','readyState','networkState','videoWidth','videoHeight','volume','muted','playbackRate','error','defaultPlaybackRate','buffered'].forEach(function (name) {
      Object.defineProperty(proxy, name, {
        get: function () {
          if (!isWasm()) return dom[name];
          if (name === 'currentTime') return time();
          if (name === 'defaultPlaybackRate') return state.playbackRate;
          if (name === 'buffered') return { length: frames.length ? 1 : 0, start: function () { return state.currentTime; }, end: function () { return frames.length ? frames[frames.length - 1].pts : state.currentTime; } };
          return state[name];
        },
        set: function (value) {
          if (!isWasm()) { dom[name] = value; return; }
          if (name === 'currentTime') { var next = Number(value); if (!Number.isFinite(next) || next < 0 || first && Math.abs(next - seekTarget) < .001) return; state.seeking = true; seekTarget = next; emit('seeking'); open(next); }
          else if (name === 'volume' || name === 'muted') { state[name] = name === 'volume' ? Math.max(0, Math.min(1, Number(value))) : !!value; dom[name] = state[name]; audioVolume(); emit('volumechange'); }
          else if (name === 'playbackRate' || name === 'defaultPlaybackRate') { var rate = Number(value); if (!Number.isFinite(rate) || rate <= 0 || rate === state.playbackRate) return; state.currentTime = time(); state.playbackRate = rate; dom.playbackRate = rate; if (worker) open(state.currentTime); emit('ratechange'); }
        }
      });
    });
    ['loadstart','loadedmetadata','durationchange','loadeddata','canplay','canplaythrough','play','playing','pause','waiting','stalled','progress','timeupdate','seeking','seeked','ended','error','emptied','volumechange','ratechange'].forEach(function (name) { dom.addEventListener(name, function () { if (!isWasm()) emit(name); }); });
    doc.getElementById = function (id) { return id === 'hero-video' ? proxy : originalLookup(id); };
    win.HongguoNativePlaybackAdapter = {
      enabled: true, engine: 'windows', startPositionApplied: function () { return isWasm(); }, video: function () { return proxy; }, domVideo: function () { return isWasm() && canvas ? canvas : dom; }, isNative: function () { return false; },
      setStartPosition: function (value) { if (isWasm()) seekTarget = Math.max(0, Number(value) || 0); },
      diagnostics: function () { return isWasm() ? { preferred_path: 'WASM', active_path: 'WASM', final_path: first ? '' : 'WASM', final_first_frame: !first, outcome: state.error ? 'failed' : first ? 'preparing' : 'playing' } : null; },
      nativeDiagnostics: function () { return isWasm() ? { engine: 'wasm', video_codec: sourceCodec, video_width: state.videoWidth, video_height: state.videoHeight, frame_drop_count: stats.dropped, avsync: stats.avsync } : {}; }
    };
    win.addEventListener('pagehide', stop);
    var settings = { mode: function () { return preference(win.localStorage); }, choose: function (value) { return choose(win.localStorage, value); }, current: function () { return mode; }, diagnostics: function () { return Object.assign({ mode: mode, audioContext: context && context.state, queuedVideo: frames.length, queuedAudio: audioQueue.length, workers: worker ? 1 : 0 }, stats); } };
    win.HongguoWindowsDecoder = settings;
    return settings;
  }
  return { supported: supported, preference: preference, choose: choose, install: install };
}));
