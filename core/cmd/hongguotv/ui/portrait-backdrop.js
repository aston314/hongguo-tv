(function (root) {
  'use strict';
  function normalize(value) { return value === 'blur' ? 'blur' : 'black'; }

  // Blur only a tiny image. No full-resolution pixel readback, CSS filters,
  // second video element, source request or extra decoder is needed.
  function blur(data, width, height) {
    var scratch = new Uint8ClampedArray(data.length), radius = 4, span = radius * 2 + 1;
    function pass(input, output, horizontal) {
      var major = horizontal ? height : width, minor = horizontal ? width : height;
      for (var a = 0; a < major; a++) {
        for (var c = 0; c < 3; c++) {
          var sum = 0, base = (horizontal ? a * width : a) * 4 + c, stride = horizontal ? 4 : width * 4;
          for (var k = -radius; k <= radius; k++) sum += input[base + Math.max(0, Math.min(minor - 1, k)) * stride];
          for (var b = 0; b < minor; b++) {
            output[base + b * stride] = sum / span;
            sum += input[base + Math.min(minor - 1, b + radius + 1) * stride] - input[base + Math.max(0, b - radius) * stride];
          }
        }
      }
    }
    for (var n = 0; n < 2; n++) { pass(data, scratch, true); pass(scratch, data, false); }
    for (var i = 0; i < data.length; i += 4) {
      data[i] *= .62; data[i + 1] *= .62; data[i + 2] *= .62; data[i + 3] = 255;
    }
    return data;
  }

  function create(options) {
    var canvas = options.canvas, media = options.media;
    var now = options.now || Date.now, later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    var mode = 'black', key = '', serial = 0, sequence = 0, timer = null, deadline = null, pending = null;
    var work = null, image = null, stopped = false, failures = 0, slowFrames = 0, blocked = false, interval = 1000;
    var frames = 0, lastCost = 0, disabledReason = '', layoutWidth = 0, layoutHeight = 0;
    function snapshot() { return options.snapshot() || {}; }
    function portrait(s) { return s.width > 0 && s.height > s.width; }
    function visible(s) { return mode === 'blur' && !stopped && s.visible && s.key && portrait(s); }
    function clear() {
      canvas.classList.remove('is-visible');
      if (canvas.width || canvas.height) { canvas.width = 0; canvas.height = 0; }
    }
    function cancelPending() {
      if (timer !== null) cancel(timer); timer = null;
      if (deadline !== null) cancel(deadline); deadline = null;
      pending = null;
      if (image) { image.onload = image.onerror = null; image = null; }
    }
    function reset() {
      serial++; cancelPending(); clear(); work = null;
    }
    function newSource(nextKey) {
      reset(); key = nextKey; blocked = false; failures = 0; slowFrames = 0;
      interval = 1000; disabledReason = ''; layoutWidth = 0; layoutHeight = 0;
    }
    function valid(ticket, s) {
      return pending === ticket && ticket.serial === serial && ticket.key === s.key && ticket.native === !!s.native && (!ticket.native || ticket.id === s.nativeId) && visible(s) && !s.paused && !s.seeking;
    }
    function schedule() {
      var s = snapshot();
      if (timer !== null || pending || blocked || !visible(s) || s.paused || s.seeking) return;
      timer = later(function () { timer = null; capture(); }, interval);
    }
    function failed(ticket, reason) {
      if (pending !== ticket) return;
      cancelPending(); failures++;
      if (failures >= 3) { blocked = true; disabledReason = reason; clear(); work = null; }
      else schedule();
    }
    function paint(source, ticket) {
      var s = snapshot();
      if (!valid(ticket, s)) { if (pending === ticket) cancelPending(); return; }
      var started = now();
      try {
        var rect = canvas.parentNode.getBoundingClientRect();
        if (!(rect.width > 1 && rect.height > 1) || rect.width <= rect.height * s.width / s.height + 2) {
          cancelPending(); clear(); return;
        }
        if (!work) work = options.createCanvas();
        var w = 128, h = Math.max(24, Math.min(128, Math.round(w * rect.height / rect.width)));
        if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
        var ctx = work.getContext('2d');
        if (!ctx) throw new Error('canvas');
        var sw = Number(source.videoWidth || source.naturalWidth || source.width), sh = Number(source.videoHeight || source.naturalHeight || source.height);
        if (!(sw > 0 && sh > 0)) throw new Error('dimensions');
        var scale = Math.max(w / sw, h / sh);
        ctx.drawImage(source, (sw - w / scale) / 2, (sh - h / scale) / 2, w / scale, h / scale, 0, 0, w, h);
        var pixels = ctx.getImageData(0, 0, w, h);
        blur(pixels.data, w, h); ctx.putImageData(pixels, 0, 0);
        // One output bitmap capped at 1280x720; central pixels are transparent.
        var outScale = Math.min(1, 1280 / rect.width, 720 / rect.height);
        var ow = Math.max(1, Math.round(rect.width * outScale)), oh = Math.max(1, Math.round(rect.height * outScale));
        if (canvas.width !== ow || canvas.height !== oh) { canvas.width = ow; canvas.height = oh; }
        var output = canvas.getContext('2d');
        if (!output) throw new Error('canvas');
        output.globalCompositeOperation = 'source-over'; output.clearRect(0, 0, ow, oh);
        output.drawImage(work, 0, 0, ow, oh);
        var aspect = ticket.aspect || s.width / s.height;
        var column = Math.min(ow, oh * aspect), left = (ow - column) / 2, right = left + column;
        var feather = Math.min(12 * outScale, column / 4), overlap = Math.max(1, outScale);
        output.globalCompositeOperation = 'destination-out';
        output.fillStyle = '#000'; output.fillRect(left + feather, 0, Math.max(0, column - feather * 2), oh);
        var gradient = output.createLinearGradient(left - overlap, 0, left + feather, 0);
        gradient.addColorStop(0, 'rgba(0,0,0,0)'); gradient.addColorStop(1, '#000');
        output.fillStyle = gradient; output.fillRect(left - overlap, 0, feather + overlap, oh);
        gradient = output.createLinearGradient(right - feather, 0, right + overlap, 0);
        gradient.addColorStop(0, '#000'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
        output.fillStyle = gradient; output.fillRect(right - feather, 0, feather + overlap, oh);
        output.globalCompositeOperation = 'source-over';
        canvas.classList.add('is-visible'); frames++; failures = 0;
        lastCost = Math.max(0, now() - started);
        // These are conservative decoration budgets, not playback timeouts.
        if (lastCost > 80) { blocked = true; disabledReason = 'paint_budget'; clear(); work = null; }
        else if (lastCost > 24) {
          interval = 2000;
          if (++slowFrames >= 3) { blocked = true; disabledReason = 'paint_budget'; clear(); work = null; }
        } else slowFrames = 0;
        cancelPending(); schedule();
      } catch (ignored) { failed(ticket, 'capture_unavailable'); }
    }
    function capture() {
      var s = snapshot();
      if (s.key !== key) { update(); return; }
      if (!visible(s) || s.paused || s.seeking || blocked || pending) return;
      var ticket = { serial: serial, key: s.key, native: !!s.native, id: s.nativeId || '', ticket: String(++sequence) };
      pending = ticket;
      if (s.native) {
        deadline = later(function () { failed(ticket, 'capture_timeout'); }, 1500);
        try { if (!options.requestNative(ticket.id, ticket.ticket)) failed(ticket, 'capture_unavailable'); }
        catch (ignored) { failed(ticket, 'capture_unavailable'); }
      } else paint(options.video, ticket);
    }
    function receive(id, value, data, aspect) {
      var ticket = pending;
      if (!ticket || !ticket.native || ticket.received || ticket.id !== id || ticket.ticket !== value || !valid(ticket, snapshot())) return;
      if (typeof data !== 'string' || data.length > 160000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data)) {
        failed(ticket, 'capture_unavailable'); return;
      }
      ticket.aspect = typeof aspect === 'number' && isFinite(aspect) && aspect > 0 && aspect < 1 ? aspect : 0;
      ticket.received = true;
      try {
        image = options.createImage();
        var candidate = image;
        image.onload = function () {
          candidate.onload = candidate.onerror = null;
          if (image === candidate) image = null;
          paint(candidate, ticket);
        };
        image.onerror = function () { failed(ticket, 'image_unavailable'); };
        image.src = data;
      } catch (ignored) { failed(ticket, 'image_unavailable'); }
    }
    function update() {
      if (mode !== 'blur' || stopped) { cancelPending(); clear(); return; }
      var s = snapshot();
      if (s.key !== key) newSource(s.key || '');
      if (!visible(s)) { cancelPending(); clear(); return; }
      if (s.paused || s.seeking) { cancelPending(); return; }
      schedule();
    }
    var api = {
      setMode: function (value) { mode = normalize(value); newSource(''); update(); },
      reset: reset, update: update, receive: receive,
      layout: function () {
        if (mode !== 'blur' || stopped) return;
        var rect = canvas.parentNode.getBoundingClientRect();
        if (rect.width === layoutWidth && rect.height === layoutHeight) return;
        layoutWidth = rect.width; layoutHeight = rect.height; reset(); update();
      },
      destroy: function () {
        stopped = true; reset();
        updates.forEach(function (event) { media.removeEventListener(event, update); });
        resets.forEach(function (event) { media.removeEventListener(event, reset); });
      },
      diagnostics: function () { return { mode: mode, frames: frames, interval_ms: interval, paint_ms: lastCost, disabled: disabledReason }; }
    };
    var updates = ['playing', 'nativeframe', 'timeupdate', 'pause', 'waiting', 'seeked', 'loadedmetadata'];
    var resets = ['emptied', 'error', 'ended', 'seeking', 'nativefallbackstart', 'nativefallbackend'];
    updates.forEach(function (event) { media.addEventListener(event, update); });
    resets.forEach(function (event) { media.addEventListener(event, reset); });
    return api;
  }
  var api = { create: create, normalize: normalize, blur: blur };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoPortraitBackdrop = api;
}(this));
