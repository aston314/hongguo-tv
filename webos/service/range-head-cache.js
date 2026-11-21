'use strict';

var cancel = require('./audio-cancel');

// Only the beginning of two sources is retained (4 MiB total by default).
// Values are already CENC-decrypted bytes, scoped to the exact indexed source.
module.exports = function (load, options) {
  options = options || {};
  var blockBytes = options.blockBytes || 512 * 1024;
  var headBytes = options.headBytes || 2 * 1024 * 1024;
  var now = options.now || Date.now, ttl = options.ttlMs || 120000;
  var entries = [];
  function busy(entry) { return entry.users > 0 || Object.keys(entry.blocks).some(function (key) { return entry.blocks[key].users > 0; }); }
  function prune() { entries = entries.filter(function (entry) { return busy(entry) || now() - entry.at < ttl; }); }
  function find(source, create) {
    prune();
    var entry = entries.filter(function (item) { return item.source === source; })[0];
    if (!entry && create) {
      if (entries.length >= 2) {
        var idle = entries.filter(function (item) { return !busy(item); }).sort(function (a, b) { return a.at - b.at; })[0];
        if (!idle) return null;
        entries.splice(entries.indexOf(idle), 1);
      }
      entry = { source: source, at: now(), blocks: {}, hits: 0, users: 0 };
      entries.push(entry);
    }
    if (entry) entry.at = now();
    return entry;
  }
  function block(entry, index, signal, speculative) {
    if (signal && signal.aborted) return Promise.reject(cancel.error(signal));
    var item = entry.blocks[index];
    if (item && item.data) { entry.hits++; return Promise.resolve(item.data); }
    if (item && item.cancel.signal.aborted) item = null;
    if (!item) {
      var start = index * blockBytes, end = Math.min(entry.source.length, headBytes, start + blockBytes) - 1;
      item = { users: 0, settled: false, speculative: speculative, cancel: cancel.create() };
      entry.blocks[index] = item;
      var work = item;
      item.promise = Promise.resolve().then(function () {
        cancel.check(work.cancel.signal);
        return load(entry.source, start, end, { signal: work.cancel.signal, speculative: speculative });
      }).then(function (data) {
        cancel.check(work.cancel.signal);
        if (!Buffer.isBuffer(data) || data.length !== end - start + 1) throw new Error('Range head length mismatch');
        work.settled = true; work.data = data; entry.at = now(); return data;
      }).catch(function (error) {
        work.settled = true;
        if (entry.blocks[index] === work) delete entry.blocks[index];
        throw error;
      });
    } else entry.hits++;
    item.users++;
    var shared = item;
    return new Promise(function (resolve, reject) {
      var done = false;
      function leave() {
        if (done) return false; done = true;
        if (signal) signal.removeEventListener('abort', aborted);
        if (--shared.users === 0 && !shared.settled) shared.cancel.abort();
        return true;
      }
      function aborted() { if (leave()) reject(cancel.error(signal)); }
      if (signal) { signal.addEventListener('abort', aborted); if (signal.aborted) { aborted(); return; } }
      shared.promise.then(function (data) { if (leave()) resolve(data); }, function (error) {
        if (!leave()) return;
        // Losing speculative work must not fail a foreground reader. Retry
        // this block with the ordinary read policy, once, on the same source.
        if (!speculative && shared.speculative) block(entry, index, signal, false).then(resolve, reject);
        else reject(error);
      });
    });
  }
  function warm(source, signal) {
    var entry = find(source, true);
    if (!entry) return Promise.resolve(0);
    entry.users++;
    var count = Math.ceil(Math.min(source.length, headBytes) / blockBytes), chain = Promise.resolve(0);
    for (var index = 0; index < count; index++) (function (i) {
      chain = chain.then(function (bytes) { return block(entry, i, signal, true).then(function (data) { return bytes + data.length; }); });
    })(index);
    return chain.then(function (bytes) { entry.users--; return bytes; }, function (error) { entry.users--; throw error; });
  }
  function read(source, start, end, signal) {
    if (signal && signal.aborted) return Promise.reject(cancel.error(signal));
    var entry = find(source, false);
    if (!entry || start >= headBytes) return load(source, start, end, signal ? { signal: signal } : undefined);
    entry.users++;
    var parts = [], chain = Promise.resolve(), cursor = start;
    while (cursor <= end) {
      var from = cursor, index = Math.floor(from / blockBytes);
      var to = from < headBytes ? Math.min(end, headBytes - 1, (index + 1) * blockBytes - 1) : end;
      (function (from, to, index) {
        chain = chain.then(function () {
          cancel.check(signal);
          return from >= headBytes ? load(source, from, to, signal ? { signal: signal } : undefined) : block(entry, index, signal, false).then(function (data) {
            return data.slice(from - index * blockBytes, to - index * blockBytes + 1);
          });
        }).then(function (data) { parts.push(data); });
      })(from, to, index);
      cursor = to + 1;
    }
    return chain.then(function () { entry.users--; return Buffer.concat(parts); }, function (error) { entry.users--; throw error; });
  }
  function diagnostics(source) {
    var entry = find(source, false), bytes = 0;
    if (entry) Object.keys(entry.blocks).forEach(function (key) { var data = entry.blocks[key].data; if (data) bytes += data.length; });
    return { media_head_cache_bytes: bytes, media_head_cache_hits: entry ? entry.hits : 0 };
  }
  function clear() {
    entries.forEach(function (entry) { Object.keys(entry.blocks).forEach(function (key) { entry.blocks[key].cancel.abort(); }); });
    entries = [];
  }
  return { warm: warm, read: read, diagnostics: diagnostics, clear: clear };
};
