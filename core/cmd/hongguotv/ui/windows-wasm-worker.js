/* Application-owned decoder worker. Never logs media URLs or raw codec errors. */
'use strict';
let decoder, opened = false, generation = 0, clock = 0, credits = 0, timer = null, paused = true, eof = false;
let source = '', length = 0, position = 0, block = null, blockStart = 0, latest = 0;
const BLOCK = 1024 * 1024;
function message(value, transfers) { self.postMessage(value, transfers || []); }
function fail(code) { paused = true; clearTimeout(timer); timer = null; message({ type: 'error', generation, code }); }
function request(start, size) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', source, false); xhr.responseType = 'arraybuffer';
  xhr.setRequestHeader('Range', 'bytes=' + start + '-' + (start + size - 1));
  xhr.send();
  if (xhr.status !== 206) throw Error('range');
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(xhr.getResponseHeader('Content-Range') || '');
  if (!match || Number(match[1]) !== start || Number(match[3]) > Number.MAX_SAFE_INTEGER || !xhr.response) throw Error('range');
  length = Number(match[3]);
  return new Uint8Array(xhr.response);
}
function read(ptr, size, heap) {
  if (position >= length) return 0;
  if (!block || position < blockStart || position >= blockStart + block.length) {
    blockStart = position; block = request(position, Math.min(BLOCK, length - position));
  }
  const count = Math.min(size, block.length - (position - blockStart), length - position);
  heap.set(block.subarray(position - blockStart, position - blockStart + count), ptr); position += count;
  return count;
}
function seek(offset, whence) {
  if (whence === 65536) return length;
  const mode = whence & 0xffff;
  const next = mode === 0 ? offset : mode === 1 ? position + offset : mode === 2 ? length + offset : -1;
  if (!Number.isSafeInteger(next) || next < 0 || next > length) return -1;
  position = next; return position;
}
function schedule() {
  if (timer !== null || !opened || !decoder || paused || eof) return;
  timer = setTimeout(pump, 0);
}
function pump() {
  timer = null;
  if (paused || eof) return;
  try {
    let count = 0;
    while (credits > 0 && count++ < 4) {
      if (latest > clock + 1.1) { timer = setTimeout(pump, 15); return; }
      const begin = performance.now(), kind = decoder._hg_step(), decodeMs = performance.now() - begin;
      if (kind < 0) { fail('decode'); return; }
      if (!kind) { eof = true; message({ type: 'end', generation }); return; }
      const pts = decoder._hg_pts(), ptr = decoder._hg_ptr(); latest = pts;
      if (kind === 1) {
        const w = decoder._hg_width(), h = decoder._hg_height();
        const bytes = w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2);
        const data = decoder.HEAPU8.slice(ptr, ptr + bytes).buffer;
        credits--;
        message({ type: 'video', generation, pts, width: w, height: h, colorspace: decoder._hg_colorspace(), fullrange: !!decoder._hg_fullrange(), data, decodeMs }, [data]);
      } else {
        const samples = decoder._hg_samples();
        if (samples > 0) {
          const data = decoder.HEAPU8.slice(ptr, ptr + samples * 8).buffer;
          message({ type: 'audio', generation, pts, samples, data }, [data]);
        }
      }
    }
    if (credits > 0) schedule();
  } catch (_) { fail('network'); }
}
self.onmessage = async function (event) {
  const value = event.data;
  if (value.type === 'open') {
    generation = value.generation; opened = false; paused = false; eof = false; credits = 8; clock = value.at || 0; latest = clock;
    clearTimeout(timer); timer = null; source = value.url; block = null; position = 0;
    try {
      const url = new URL(source);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/minireel-proxy\/media\/[a-zA-Z0-9_-]+\.mp4$/.test(url.pathname) || url.search || url.hash) throw Error('source');
      blockStart = 0; block = request(0, BLOCK);
      if (!decoder) {
        importScripts('/windows-wasm/decoder.js');
        decoder = await HongguoWasmDecoder({ locateFile: function (name) { return '/windows-wasm/' + name; }, print: function () {}, printErr: function () {} });
      }
      decoder.hgIO = { read, seek };
      const result = decoder._hg_open(clock);
      if (result < 0) { fail(result === -4 ? 'codec' : 'open'); return; }
      message({ type: 'meta', generation, width: decoder._hg_width(), height: decoder._hg_height(), duration: decoder._hg_duration(), audio: !!decoder._hg_audio() });
      opened = true; schedule();
    } catch (_) { fail('open'); }
  } else if (value.generation === generation) {
    if (value.type === 'clock') { clock = value.at; schedule(); }
    else if (value.type === 'credit') { credits = Math.min(8, credits + 1); schedule(); }
    else if (value.type === 'pause') { paused = true; clearTimeout(timer); timer = null; }
    else if (value.type === 'resume') { paused = false; schedule(); }
  }
};
