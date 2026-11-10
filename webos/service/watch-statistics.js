'use strict';

// Async, bounded daily aggregates. Separate from account progress/cloud sync.
var fs = require('fs'), path = require('path'), crypto = require('crypto');
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var date = new Date(value + 'T00:00:00Z');
  return isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function offset(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fail(message, status) { var e = new Error(message); e.status = status; return e; }
function empty() { return { version: 1, since: '', days: {}, batches: [] }; }
function prune(data, today) {
  var cutoff = offset(today, -365);
  Object.keys(data.days).forEach(function (day) { if (!validDate(day) || day < cutoff) delete data.days[day]; });
  if (data.since && data.since < cutoff) data.since = cutoff;
  data.batches = (data.batches || []).slice(-64);
}
function validate(batch, today) {
  if (!batch || typeof batch.owner_id !== 'string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(batch.id) || !Array.isArray(batch.items) || !batch.items.length || batch.items.length > 128) return false;
  if (Object.keys(batch).some(function (key) { return ['owner_id', 'id', 'items'].indexOf(key) < 0; })) return false;
  var total = 0;
  return batch.items.every(function (item) {
    if (!item || Object.keys(item).some(function (key) { return ['day', 'ms', 'type', 'genre'].indexOf(key) < 0; })) return false;
    if (!validDate(item.day) || item.day < offset(today, -7) || item.day > today || !Number.isInteger(item.ms) || item.ms < 1 || item.ms > 60000) return false;
    if (['real','comic','ai','unknown'].indexOf(item.type) < 0 || typeof item.genre !== 'string' || Array.from(item.genre).length > 40 || item.genre.trim() !== item.genre || ['__proto__','constructor','prototype'].indexOf(item.genre) >= 0 || /[\x00-\x1f\x7f-\x9f/\\<>:]/.test(item.genre)) return false;
    total += item.ms; return total <= 120000;
  });
}
module.exports = function create(options) {
  options = options || {};
  var dir = path.join(options.dataDir, 'watch-statistics'), queue = Promise.resolve(), now = options.now || Date.now;
  function file(owner) { return path.join(dir, crypto.createHash('sha256').update(owner).digest('hex').slice(0, 32) + '.json'); }
  function read(owner) {
    return new Promise(function (resolve, reject) {
      fs.stat(file(owner), function (error, stat) {
        if (error && error.code === 'ENOENT') return resolve(empty());
        if (error || stat.size > 1024 * 1024) return reject(fail('观看统计暂不可用', 503));
        fs.readFile(file(owner), 'utf8', function (error, text) {
          if (error) return reject(fail('观看统计暂不可用', 503));
          try { var value = JSON.parse(text); if (value.version !== 1 || !value.days || Array.isArray(value.days)) throw new Error('invalid'); resolve(value); }
          catch (error) { reject(fail('观看统计暂不可用', 503)); }
        });
      });
    });
  }
  function persist(owner, value) {
    return new Promise(function (resolve, reject) {
      fs.mkdir(dir, 448, function (error) {
        if (error && error.code !== 'EEXIST') return reject(fail('观看统计暂不可用', 503));
        var dest = file(owner), temp = dest + '.tmp';
        fs.writeFile(temp, JSON.stringify(value), { mode: 384 }, function (error) {
          if (error) return reject(fail('观看统计暂不可用', 503));
          fs.rename(temp, dest, function (error) { if (error) { fs.unlink(temp, function () {}); reject(fail('观看统计暂不可用', 503)); } else resolve(); });
        });
      });
    });
  }
  function serial(task) { var result = queue.then(task); queue = result.catch(function () {}); return result; }
  return {
    request: function (method, owner, today, batch) {
      var utc = new Date(now()).toISOString().slice(0, 10);
      if (!validDate(today) || today < offset(utc, -1) || today > offset(utc, 1)) return Promise.reject(fail('统计日期无效', 400));
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return Promise.reject(fail('method not allowed', 405));
      if (method === 'POST' && (!validate(batch, today) || batch.owner_id !== owner)) return Promise.reject(fail('统计请求无效', 400));
      return serial(function () { return read(owner).then(function (data) {
        if (method !== 'POST') { prune(data, today); delete data.batches; return data; }
        if ((data.batches || []).indexOf(batch.id) >= 0) return null;
        prune(data, today);
        batch.items.forEach(function (item) {
          var day = data.days[item.day];
          if (!day) day = data.days[item.day] = { ms: 0, types: {}, genres: {} };
          var ms = Math.min(item.ms, 86400000 - day.ms); if (ms < 1) return;
          day.ms += ms; day.types[item.type] = (day.types[item.type] || 0) + ms;
          var genre = item.genre || 'unknown';
          if (!Object.prototype.hasOwnProperty.call(day.genres, genre) && Object.keys(day.genres).length >= 15) genre = 'unknown';
          // Object dictionaries never inherit user-provided genre keys.
          Object.defineProperty(day.genres, genre, { value: (Object.prototype.hasOwnProperty.call(day.genres, genre) ? day.genres[genre] : 0) + ms, writable: true, configurable: true, enumerable: true });
          if (!data.since || item.day < data.since) data.since = item.day;
        });
        data.batches.push(batch.id); prune(data, today);
        return persist(owner, data).then(function () { return null; });
      }); });
    }
  };
};
module.exports.validate = validate;
