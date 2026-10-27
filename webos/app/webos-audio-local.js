// webOS audible speed: extract the AAC track in the page from the local, already-decrypted media proxy
// (/minireel-proxy/media/*.mp4, the same URL <video> plays) with single-range requests, then wraps the AAC
// samples as ADTS for decodeAudioData. Tried first; the Service multipart audio route stays as the fallback.
(function (root) {
  'use strict';
  // Keep the browser-side reader within the same practical limits as the Service path.
  var MAX_MOOV_BYTES = 2 * 1024 * 1024, MAX_SAMPLES = 100000, MAX_AUDIO_BYTES = 8 * 1024 * 1024;
  var MAX_MEDIA_BYTES = 512 * 1024 * 1024, MAX_DURATION = 600;
  // Audio samples are interleaved with video; merge nearby samples into a few large single-range reads.
  var SPAN_MAX = 4 * 1024 * 1024, GAP_MAX = 1024 * 1024, CONCURRENCY = 3;
  function fail(code) { var e = new Error(code); e.code = code; return e; }
  function safeInteger(value) { return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && Math.abs(value) <= 9007199254740991; }
  function u32(d, o) { return d.getUint32(o); }
  function boxType(d, o) { return String.fromCharCode(d.getUint8(o + 4), d.getUint8(o + 5), d.getUint8(o + 6), d.getUint8(o + 7)); }

  function rangeFetch(path, start, end, state) {
    if (state.aborted) return Promise.reject(fail('WEBOS_AUDIO_CANCELLED'));
    if (!isFinite(start) || !isFinite(end) || start < 0 || end < start || end - start + 1 > MAX_MEDIA_BYTES) return Promise.reject(fail('LOCAL_RANGE_INVALID'));
    return new Promise(function (resolve, reject) {
      var xhr = new root.XMLHttpRequest(), settled = false;
      state.requests.push(xhr);
      function remove() { var at = state.requests.indexOf(xhr); if (at >= 0) state.requests.splice(at, 1); }
      function finish(error, value) {
        if (settled) return; settled = true; remove();
        if (state.signal) state.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      }
      function abort() { try { xhr.abort(); } catch (ignored) {} finish(fail('WEBOS_AUDIO_CANCELLED')); }
      function responseError(code) { finish(fail(code)); }
      xhr.open('GET', path, true);
      xhr.responseType = 'arraybuffer'; xhr.timeout = 20000;
      xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
      xhr.setRequestHeader('Cache-Control', 'no-cache');
      xhr.onload = function () {
        if (xhr.status !== 206) { responseError('LOCAL_RANGE_' + xhr.status); return; }
        var header = xhr.getResponseHeader('Content-Range') || '';
        var cr = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(header);
        var total = cr && Number(cr[3]), body = xhr.response;
        if (!cr || Number(cr[1]) !== start || Number(cr[2]) !== end || !isFinite(total) || total <= end || total > MAX_MEDIA_BYTES || !body || body.byteLength !== end - start + 1) {
          responseError('LOCAL_RANGE_MISMATCH'); return;
        }
        if (state.total && state.total !== total) { responseError('LOCAL_RANGE_TOTAL_CHANGED'); return; }
        state.total = total;
        finish(null, body);
      };
      xhr.onerror = function () { responseError('LOCAL_RANGE_NETWORK'); };
      xhr.ontimeout = function () { responseError('LOCAL_RANGE_TIMEOUT'); };
      xhr.onabort = function () { if (!settled) finish(fail(state.aborted ? 'WEBOS_AUDIO_CANCELLED' : 'LOCAL_RANGE_ABORTED')); };
      if (state.signal) {
        state.signal.addEventListener('abort', abort);
        if (state.signal.aborted) { abort(); return; }
      }
      try { xhr.send(); } catch (error) { finish(fail('LOCAL_RANGE_NETWORK')); }
    });
  }

  // Locate the top-level moov box (before or after mdat).
  function findMoov(path, state) {
    function walk(offset) {
      if (state.total && offset + 8 > state.total) throw fail('LOCAL_NO_MOOV');
      return rangeFetch(path, offset, offset + 15, state).then(function (buf) {
        var d = new DataView(buf), size = u32(d, 0), type = boxType(d, 0), head = 8;
        if (size === 1) { size = d.getUint32(8) * 4294967296 + d.getUint32(12); head = 16; }
        else if (size === 0) size = state.total - offset;
        if (size < 8) throw fail('LOCAL_BAD_BOX');
        if (type === 'moov') {
          if (size > MAX_MOOV_BYTES) throw fail('LOCAL_MOOV_TOO_BIG');
          return rangeFetch(path, offset, offset + size - 1, state).then(function (m) { return new DataView(m); });
        }
        return walk(offset + size);
      });
    }
    return walk(0);
  }

  function children(d, start, end, cb) {
    for (var o = start; o + 8 <= end;) {
      var size = u32(d, o), type = boxType(d, o), head = 8;
      if (size === 1) { if (o + 16 > end) throw fail('LOCAL_BAD_BOX'); size = d.getUint32(o + 8) * 4294967296 + d.getUint32(o + 12); head = 16; }
      else if (size === 0) size = end - o;
      if (size < 8 || o + size > end) throw fail('LOCAL_BAD_BOX');
      cb(type, o + head, o + size, o);
      o += size;
    }
  }
  function find(d, start, end, path) {
    var hit = null;
    children(d, start, end, function (type, s, e) { if (!hit && type === path[0]) hit = path.length === 1 ? { s: s, e: e } : find(d, s, e, path.slice(1)); });
    return hit;
  }

  function parseEsds(d, s, e) {
    function descriptor(from, to) {
      var o = from;
      while (o < to) {
        if (o + 2 > to) throw fail('LOCAL_ESDS_TRUNCATED');
        var tag = d.getUint8(o++), length = 0, bytes = 0, b;
        do {
          if (o >= to || bytes++ >= 4) throw fail('LOCAL_ESDS_LENGTH');
          b = d.getUint8(o++); length = (length << 7) | (b & 0x7f);
        } while (b & 0x80);
        var end = o + length;
        if (end > to) throw fail('LOCAL_ESDS_TRUNCATED');
        if (tag === 0x03) {
          if (length < 3) throw fail('LOCAL_ESDS_ES_DESCRIPTOR');
          var cursor = o + 2, flags = d.getUint8(cursor++);
          if (flags & 0x80) cursor += 2;
          if (flags & 0x40) { if (cursor >= end) throw fail('LOCAL_ESDS_URL'); cursor += d.getUint8(cursor) + 1; }
          if (flags & 0x20) cursor += 2;
          if (cursor > end) throw fail('LOCAL_ESDS_ES_DESCRIPTOR');
          var nested = descriptor(cursor, end); if (nested) return nested;
        } else if (tag === 0x05) {
          if (length < 2) throw fail('LOCAL_AAC_CONFIG_UNSUPPORTED');
          var b0 = d.getUint8(o), b1 = d.getUint8(o + 1), aot = b0 >> 3, fi = ((b0 & 7) << 1) | (b1 >> 7), ch = (b1 >> 3) & 15;
          if (aot < 1 || aot > 4 || fi > 12 || ch < 1 || ch > 2) throw fail('LOCAL_AAC_CONFIG_UNSUPPORTED');
          return { objectType: aot, freqIndex: fi, channels: ch };
        } else if (tag === 0x04) {
          if (length < 13) throw fail('LOCAL_ESDS_DECODER_CONFIG');
          var config = descriptor(o + 13, end); if (config) return config;
        }
        o = end;
      }
      return null;
    }
    var result = descriptor(s + 4, e);
    if (result) return result;
    throw fail('LOCAL_NO_ESDS');
  }

  function audioTrack(d, total) {
    var out = null;
    children(d, 8, d.byteLength, function (type, s, e) {
      if (out || type !== 'trak') return;
      var hdlr = find(d, s, e, ['mdia', 'hdlr']);
      if (!hdlr) return;
      var handler = String.fromCharCode(d.getUint8(hdlr.s + 8), d.getUint8(hdlr.s + 9), d.getUint8(hdlr.s + 10), d.getUint8(hdlr.s + 11));
      if (handler !== 'soun') return;
      var mdhd = find(d, s, e, ['mdia', 'mdhd']);
      if (!mdhd) throw fail('LOCAL_NO_MDHD');
      var v = d.getUint8(mdhd.s);
      var timescale = v === 1 ? u32(d, mdhd.s + 20) : u32(d, mdhd.s + 12);
      var duration = v === 1 ? d.getUint32(mdhd.s + 24) * 4294967296 + d.getUint32(mdhd.s + 28) : u32(d, mdhd.s + 16);
      if (!timescale || !isFinite(duration / timescale) || duration <= 0 || duration / timescale > MAX_DURATION) throw fail('LOCAL_AUDIO_DURATION');
      var stbl = find(d, s, e, ['mdia', 'minf', 'stbl']);
      if (!stbl) throw fail('LOCAL_NO_STBL');
      var stsd = find(d, stbl.s, stbl.e, ['stsd']);
      var stsz = find(d, stbl.s, stbl.e, ['stsz']), stsc = find(d, stbl.s, stbl.e, ['stsc']);
      var stco = find(d, stbl.s, stbl.e, ['stco']), co64 = find(d, stbl.s, stbl.e, ['co64']);
      if (!stsd || !stsz || !stsc || !stco && !co64) throw fail('LOCAL_SAMPLE_TABLE');
      if (stsd.s + 8 > stsd.e || u32(d, stsd.s + 4) !== 1) throw fail('LOCAL_STSD');
      var entry = stsd.s + 8; // version/flags + entry_count
      if (entry + 8 > stsd.e) throw fail('LOCAL_STSD');
      if (boxType(d, entry) !== 'mp4a') throw fail('LOCAL_NOT_AAC');
      var entryEnd = entry + u32(d, entry);
      if (entryEnd > stsd.e || entryEnd < entry + 8 + 28) throw fail('LOCAL_STSD');
      var esds = find(d, entry + 8 + 28, entryEnd, ['esds']);
      if (!esds) throw fail('LOCAL_NO_ESDS');
      var cfg = parseEsds(d, esds.s, esds.e);
      if (stsz.s + 12 > stsz.e || stsc.s + 8 > stsc.e) throw fail('LOCAL_SAMPLE_TABLE');
      var fixed = u32(d, stsz.s + 4), count = u32(d, stsz.s + 8);
      if (!count || count > MAX_SAMPLES || !fixed && stsz.s + 12 + count * 4 > stsz.e) throw fail('LOCAL_SAMPLE_COUNT');
      var sizes = new Array(count), payloadBytes = 0;
      for (var i = 0; i < count; i++) sizes[i] = fixed || u32(d, stsz.s + 12 + i * 4);
      for (i = 0; i < count; i++) { if (!sizes[i] || !isFinite(sizes[i]) || (payloadBytes += sizes[i]) > MAX_AUDIO_BYTES) throw fail('LOCAL_AUDIO_LIMIT'); }
      var chunks = [];
      var n;
      if (stco) { if (stco.s + 8 > stco.e) throw fail('LOCAL_STCO'); n = u32(d, stco.s + 4); if (!n || n > MAX_SAMPLES || stco.s + 8 + n * 4 > stco.e) throw fail('LOCAL_STCO'); for (i = 0; i < n; i++) chunks.push(u32(d, stco.s + 8 + i * 4)); }
      else { if (co64.s + 8 > co64.e) throw fail('LOCAL_CO64'); n = u32(d, co64.s + 4); if (!n || n > MAX_SAMPLES || co64.s + 8 + n * 8 > co64.e) throw fail('LOCAL_CO64'); for (i = 0; i < n; i++) { var wide = d.getUint32(co64.s + 8 + i * 8) * 4294967296 + d.getUint32(co64.s + 12 + i * 8); if (!safeInteger(wide)) throw fail('LOCAL_CO64'); chunks.push(wide); } }
      var runs = [], rc = u32(d, stsc.s + 4);
      if (!rc || rc > MAX_SAMPLES || stsc.s + 8 + rc * 12 > stsc.e) throw fail('LOCAL_STSC');
      for (i = 0; i < rc; i++) {
        var runAt = stsc.s + 8 + i * 12, first = u32(d, runAt), per = u32(d, runAt + 4), description = u32(d, runAt + 8);
        if (!first || first > n || !per || description !== 1 || i && first <= runs[i - 1].first) throw fail('LOCAL_STSC');
        runs.push({ first: first, per: per });
      }
      var samples = [], k = 0;
      for (var c = 0; c < chunks.length && k < count; c++) {
        var per = 0; for (var r = 0; r < runs.length && runs[r].first <= c + 1; r++) per = runs[r].per;
        var off = chunks[c];
        for (var j = 0; j < per && k < count; j++, k++) { if (!safeInteger(off) || off < 0 || off + sizes[k] > total) throw fail('LOCAL_SAMPLE_RANGE'); samples.push({ off: off, size: sizes[k] }); off += sizes[k]; }
      }
      if (k !== count) throw fail('LOCAL_STSC_COUNT');
      out = { cfg: cfg, timescale: timescale, duration: duration / timescale, samples: samples };
    });
    if (!out) throw fail('LOCAL_NO_AUDIO_TRACK');
    return out;
  }

  function spansOf(samples) {
    var spans = [], cur = null;
    samples.forEach(function (s, i) {
      if (!s || !safeInteger(s.off) || !safeInteger(s.size) || s.off < 0 || s.size <= 0 || s.size > MAX_AUDIO_BYTES) throw fail('LOCAL_SAMPLE_RANGE');
      if (cur && s.off > cur.end && s.off - cur.end - 1 <= GAP_MAX && s.off + s.size - 1 - cur.start < SPAN_MAX) { cur.end = s.off + s.size - 1; cur.last = i; }
      else { cur = { start: s.off, end: s.off + s.size - 1, first: i, last: i }; spans.push(cur); }
    });
    if (!spans.length || spans.length > MAX_SAMPLES) throw fail('LOCAL_SAMPLE_SPANS');
    return spans;
  }

  function adts(cfg, frames, total) {
    var out = new Uint8Array(total + frames.length * 7), o = 0;
    frames.forEach(function (f) {
      var len = f.length + 7;
      out[o] = 0xFF; out[o + 1] = 0xF1;
      out[o + 2] = ((cfg.objectType - 1) << 6) | (cfg.freqIndex << 2) | (cfg.channels >> 2);
      out[o + 3] = ((cfg.channels & 3) << 6) | (len >> 11);
      out[o + 4] = (len >> 3) & 0xFF; out[o + 5] = ((len & 7) << 5) | 0x1F; out[o + 6] = 0xFC;
      out.set(f, o + 7); o += len;
    });
    return out.buffer;
  }

  function extract(path, signal) {
    var state = { aborted: false, total: 0 }, t0 = Date.now(), stats = { requests: 0 };
    state.signal = signal; state.requests = [];
    function abortAll() { state.aborted = true; state.requests.slice().forEach(function (xhr) { try { xhr.abort(); } catch (ignored) {} }); }
    function onAbort() { abortAll(); }
    if (signal) { if (signal.aborted) return Promise.reject(fail('WEBOS_AUDIO_CANCELLED')); signal.addEventListener('abort', onAbort); }
    return findMoov(path, state).then(function (moov) {
      var track = audioTrack(moov, state.total), spans = spansOf(track.samples), parts = new Array(spans.length), next = 0, bytes = 0;
      stats.spans = spans.length; stats.samples = track.samples.length; stats.moov_ms = Date.now() - t0;
      function worker() {
        if (next >= spans.length) return Promise.resolve();
        var i = next++, sp = spans[i]; stats.requests++;
        return rangeFetch(path, sp.start, sp.end, state).then(function (buf) { parts[i] = new Uint8Array(buf); bytes += buf.byteLength; return worker(); });
      }
      var pool = []; for (var w = 0; w < CONCURRENCY; w++) pool.push(worker());
      return Promise.all(pool).then(function () {
        var frames = [], total = 0;
        spans.forEach(function (sp, i) {
          var base = sp.start, buf = parts[i];
          if (!buf || buf.byteLength !== sp.end - sp.start + 1) throw fail('LOCAL_RANGE_MISMATCH');
          for (var k = sp.first; k <= sp.last; k++) { var s = track.samples[k], from = s.off - base, to = from + s.size; if (from < 0 || to > buf.byteLength) throw fail('LOCAL_SAMPLE_RANGE'); frames.push(buf.subarray(from, to)); total += s.size; }
        });
        if (!total || total > MAX_AUDIO_BYTES) throw fail('LOCAL_AUDIO_LIMIT');
        stats.bytes = bytes; stats.ms = Date.now() - t0;

        return { data: adts(track.cfg, frames, total), duration: track.duration, channels: track.cfg.channels || 2, stats: stats };
      });
    }).then(function (value) { if (signal) signal.removeEventListener('abort', onAbort); return value; }, function (error) { abortAll(); if (signal) signal.removeEventListener('abort', onAbort); throw error; });
  }
  root.HongguoWebOSLocalAudio = { extract: extract, _spansOf: spansOf, _adts: adts };
}(typeof window !== 'undefined' ? window : this));
