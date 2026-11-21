'use strict';

var http = require('http');
var https = require('https');
var url = require('url');
var crypto = require('crypto');
var fs = require('fs');
var audioCancel = require('./audio-cancel');
var headCache = require('./range-head-cache')(fetchMediaUncached);

var PROBE_BYTES = 64 * 1024;
var MAX_MOOV_BYTES = 16 * 1024 * 1024;
var MAX_SAMPLES = 250000;
var MAX_MEDIA_BYTES = 512 * 1024 * 1024;
var MAX_SOURCE_METADATA_BYTES = 24 * 1024 * 1024;
var CHUNK_BYTES = 512 * 1024;
var MAX_REDIRECTS = 5;
var REQUEST_TIMEOUT = 12000;
// Keep the first media read short so a failed transition reaches the existing
// complete-file fallback instead of waiting through three 12-second attempts.
var STARTUP_REQUEST_TIMEOUT = 5000;
var STARTUP_RETRIES = 1;
var RANGE_RETRIES = 2;
var USER_AGENT = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';

function fail(message, code) {
  var error = new Error(message);
  error.code = code || 'RANGE_UNAVAILABLE';
  return error;
}

function strongETag(value) {
  value = String(value || '').trim();
  return value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"' && value.slice(0, 2).toLowerCase() !== 'w/';
}

function parseContentRange(value) {
  var match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim());
  if (!match) return null;
  var start = Number(match[1]);
  var end = Number(match[2]);
  var total = Number(match[3]);
  if (!isFinite(start) || !isFinite(end) || !isFinite(total) || end < start || total <= end) return null;
  return { start: start, end: end, total: total };
}

function requestRange(target, start, end, etag, redirects, timeout, signal, deadline) {
  timeout = Number(timeout) > 0 ? Number(timeout) : REQUEST_TIMEOUT;
  deadline = deadline || Date.now() + timeout;
  if (Date.now() >= deadline) return Promise.reject(fail('媒体 Range 请求超时', 'RANGE_TIMEOUT'));
  redirects = redirects || 0;
  if (redirects > MAX_REDIRECTS) return Promise.reject(fail('媒体源重定向次数过多'));
  var parsed = url.parse(target);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return Promise.reject(fail('媒体源协议无效'));
  var transport = parsed.protocol === 'http:' ? http : https;
  var headers = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Referer: 'https://novel.snssdk.com/',
    Origin: 'https://novel.snssdk.com',
    Range: 'bytes=' + start + '-' + end
  };
  if (etag) headers['If-Range'] = etag;
  return new Promise(function (resolvePromise, rejectPromise) {
    var request, timer;
    var finished = false;
    function finish(error, result) {
      if (finished) return; finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', aborted);
      if (error) rejectPromise(error); else resolvePromise(result);
    }
    function resolve(value) { finish(null, value); }
    function reject(error) { finish(error); }
    function aborted() { var error = audioCancel.error(signal); reject(error); if (request) request.destroy(error); }
    if (signal && signal.aborted) { aborted(); return; }
    var activeResponse = null;
    var responseChunks = [];
    var responseBytes = 0;
    function rejectRequest(error) {
      if (activeResponse && responseBytes && error.code !== 'RANGE_RESPONSE_TOO_LARGE') {
        error.rangeResponse = {
          status: activeResponse.statusCode,
          headers: activeResponse.headers,
          body: Buffer.concat(responseChunks)
        };
      }
      reject(error);
    }
    try {
      request = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.path || '/',
        method: 'GET', headers: headers, timeout: Number(timeout) > 0 ? Number(timeout) : REQUEST_TIMEOUT
      });
    } catch (error) { reject(error); return; }
    if (signal) signal.addEventListener('abort', aborted);
    timer = setTimeout(function () { rejectRequest(fail('媒体 Range 请求超时', 'RANGE_TIMEOUT')); request.destroy(); }, Math.max(1, deadline - Date.now()));
    request.on('timeout', function () { request.destroy(fail('媒体 Range 请求超时', 'RANGE_TIMEOUT')); });
    request.on('error', rejectRequest);
    request.on('response', function (response) {
      activeResponse = response;
      var location = response.headers.location;
      if ([301, 302, 303, 307, 308].indexOf(response.statusCode) >= 0 && location) {
        response.resume();
        var redirected = url.resolve(target, location);
        var next = url.parse(redirected);
        if (parsed.protocol === 'https:' && next.protocol !== 'https:') {
          reject(fail('媒体源重定向试图降级到 HTTP'));
          return;
        }
        requestRange(redirected, start, end, etag, redirects + 1, timeout, signal, deadline).then(resolve, reject);
        return;
      }
      response.on('data', function (chunk) {
        responseBytes += chunk.length;
        if (responseBytes > MAX_MOOV_BYTES) {
          request.destroy(fail('媒体 Range 响应超过限制', 'RANGE_RESPONSE_TOO_LARGE'));
          return;
        }
        responseChunks.push(chunk);
      });
      response.on('error', rejectRequest);
      response.on('aborted', function () { rejectRequest(fail('媒体 Range 响应中断', 'RANGE_INTERRUPTED')); });
      response.on('end', function () {
        var body = Buffer.concat(responseChunks);
        var contentRange = parseContentRange(response.headers['content-range']);
        if (response.statusCode === 206 && contentRange && body.length < contentRange.end - contentRange.start + 1) {
          var truncated = fail('媒体 Range 响应长度不足', 'RANGE_INTERRUPTED');
          truncated.rangeResponse = { status: response.statusCode, headers: response.headers, body: body };
          reject(truncated);
          return;
        }
        resolve({ status: response.statusCode, headers: response.headers, body: body, url: target });
      });
    });
    request.end();
  });
}

function readBox(buffer, offset, limit) {
  if (offset < 0 || offset + 8 > limit) return null;
  var size = buffer.readUInt32BE(offset);
  var header = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    var high = buffer.readUInt32BE(offset + 8);
    var low = buffer.readUInt32BE(offset + 12);
    size = high * 4294967296 + low;
    header = 16;
  } else if (size === 0) size = limit - offset;
  if (!isFinite(size) || size < header || offset + size > limit) return null;
  return { start: offset, size: size, header: header, type: buffer.toString('ascii', offset + 4, offset + 8), payload: offset + header, end: offset + size };
}

function readBoxes(buffer, start, end) {
  var result = [];
  for (var offset = start; offset < end;) {
    var item = readBox(buffer, offset, end);
    if (!item) throw fail('MP4 box 结构无效');
    result.push(item);
    offset += item.size;
  }
  if (start !== end && !result.length) throw fail('MP4 box 表为空');
  return result;
}

function findChild(buffer, parent, type) {
  var children = readBoxes(buffer, parent.payload, parent.end);
  for (var i = 0; i < children.length; i++) if (children[i].type === type) return children[i];
  return null;
}

function findPath(buffer, parent, names) {
  var current = parent;
  for (var i = 0; i < names.length; i++) {
    current = findChild(buffer, current, names[i]);
    if (!current) return null;
  }
  return current;
}

function findMoovEnd(prefix, total) {
  for (var offset = 0; offset + 8 <= prefix.length;) {
    var size32 = prefix.readUInt32BE(offset);
    var header = 8;
    var size = size32;
    if (size32 === 1) {
      if (offset + 16 > prefix.length) return { end: 0, complete: false };
      size = prefix.readUInt32BE(offset + 8) * 4294967296 + prefix.readUInt32BE(offset + 12);
      header = 16;
    } else if (size32 === 0) size = total - offset;
    if (!isFinite(size) || size < header || offset + size > total) throw fail('MP4 顶层 box 无效');
    var type = prefix.toString('ascii', offset + 4, offset + 8);
    if (type === 'moov') {
      if (size > MAX_MOOV_BYTES) throw fail('MP4 moov 超过支持上限');
      return { end: offset + size, complete: offset + size <= prefix.length };
    }
    if (type === 'mdat') throw fail('MP4 moov 位于媒体数据之后');
    if (offset + size > prefix.length) return { end: 0, complete: false };
    offset += size;
  }
  if (prefix.length >= total) throw fail('MP4 缺少 moov');
  return { end: 0, complete: false };
}

function parseSampleTable(buffer, stbl, senc) {
  var stsc = findChild(buffer, stbl, 'stsc');
  var stsz = findChild(buffer, stbl, 'stsz');
  var offsetsBox = findChild(buffer, stbl, 'stco') || findChild(buffer, stbl, 'co64');
  if (!stsc || !stsz || !offsetsBox) throw fail('CENC MP4 缺少样本表');

  var p = offsetsBox.payload + 4;
  if (p + 4 > offsetsBox.end) throw fail('MP4 chunk offset 表无效');
  var chunkCount = buffer.readUInt32BE(p); p += 4;
  if (chunkCount > MAX_SAMPLES) throw fail('MP4 chunk 表过大');
  var offsets = [];
  for (var i = 0; i < chunkCount; i++) {
    var offset;
    if (offsetsBox.type === 'co64') {
      if (p + 8 > offsetsBox.end) throw fail('MP4 co64 表截断');
      offset = buffer.readUInt32BE(p) * 4294967296 + buffer.readUInt32BE(p + 4);
      p += 8;
    } else {
      if (p + 4 > offsetsBox.end) throw fail('MP4 stco 表截断');
      offset = buffer.readUInt32BE(p); p += 4;
    }
    if (!isFinite(offset) || offset > MAX_MEDIA_BYTES) throw fail('MP4 chunk offset 超出限制');
    offsets.push(offset);
  }

  p = stsz.payload + 4;
  if (p + 8 > stsz.end) throw fail('MP4 stsz 表无效');
  var constantSize = buffer.readUInt32BE(p);
  var sampleCount = buffer.readUInt32BE(p + 4); p += 8;
  if (!sampleCount || sampleCount > MAX_SAMPLES) throw fail('MP4 样本数量无效');
  var sizes = [];
  for (i = 0; i < sampleCount; i++) {
    if (constantSize) sizes.push(constantSize);
    else {
      if (p + 4 > stsz.end) throw fail('MP4 stsz 表截断');
      sizes.push(buffer.readUInt32BE(p)); p += 4;
    }
  }

  p = stsc.payload + 4;
  if (p + 4 > stsc.end) throw fail('MP4 stsc 表无效');
  var entryCount = buffer.readUInt32BE(p); p += 4;
  if (!entryCount || entryCount > MAX_SAMPLES) throw fail('MP4 stsc 表数量无效');
  var entries = [];
  for (i = 0; i < entryCount; i++) {
    if (p + 12 > stsc.end) throw fail('MP4 stsc 表截断');
    var firstChunk = buffer.readUInt32BE(p);
    var perChunk = buffer.readUInt32BE(p + 4);
    if (firstChunk < 1 || perChunk < 1 || (i && firstChunk <= entries[i - 1].first)) throw fail('MP4 stsc 顺序无效');
    entries.push({ first: firstChunk, perChunk: perChunk }); p += 12;
  }

  var samples = [];
  var sample = 0;
  for (var chunk = 1; chunk <= offsets.length && sample < sizes.length; chunk++) {
    var entry = null;
    for (i = 0; i < entries.length; i++) if (entries[i].first <= chunk) entry = entries[i];
    if (!entry) throw fail('MP4 stsc 缺少 chunk 映射');
    var at = offsets[chunk - 1];
    for (var n = 0; n < entry.perChunk && sample < sizes.length; n++) {
      samples.push({ offset: at, size: sizes[sample], iv: null });
      at += sizes[sample++];
    }
  }
  if (sample !== sizes.length) throw fail('MP4 stsc 样本数量不一致');

  p = senc.payload;
  if (p + 8 > senc.end) throw fail('MP4 senc 表无效');
  var flags = buffer.readUInt32BE(p) & 0xffffff;
  var sencCount = buffer.readUInt32BE(p + 4); p += 8;
  if (sencCount !== sampleCount) throw fail('MP4 senc IV 数量不一致');
  var ivSize = sencCount && senc.end - p === sencCount * 16 ? 16 : 8;
  for (i = 0; i < samples.length; i++) {
    if (p + ivSize > senc.end) throw fail('MP4 senc IV 截断');
    samples[i].iv = Buffer.from(buffer.slice(p, p + ivSize));
    p += ivSize;
    if (flags & 2) throw fail('暂不支持带 subsample 的 CENC MP4');
  }
  if (p !== senc.end) throw fail('MP4 senc 表长度无效');
  return samples;
}

function patchSampleEntries(buffer, stbl) {
  var stsd = findChild(buffer, stbl, 'stsd');
  if (!stsd || stsd.payload + 8 > stsd.end) throw fail('加密轨道缺少 stsd');
  var count = buffer.readUInt32BE(stsd.payload + 4);
  var offset = stsd.payload + 8;
  for (var i = 0; i < count; i++) {
    var entry = readBox(buffer, offset, stsd.end);
    if (!entry) throw fail('stsd sample entry 无效');
    if (entry.type === 'encv' || entry.type === 'enca') {
      var headerSize = entry.type === 'encv' ? 78 : 28;
      var childrenStart = entry.payload + headerSize;
      var children = childrenStart <= entry.end ? readBoxes(buffer, childrenStart, entry.end) : [];
      var format = entry.type === 'encv' ? 'hvc1' : 'mp4a';
      for (var j = 0; j < children.length; j++) {
        if (children[j].type !== 'sinf') continue;
        if (entry.type === 'encv') {
          var frma = findChild(buffer, children[j], 'frma');
          if (frma && frma.payload + 4 <= frma.end) {
            var original = buffer.toString('ascii', frma.payload, frma.payload + 4);
            if (['avc1', 'hvc1', 'hev1'].indexOf(original) >= 0) format = original;
          }
        }
        buffer.write('free', children[j].start + 4, 4, 'ascii');
        buffer.fill(0, children[j].payload, children[j].end);
      }
      buffer.write(format, entry.start + 4, 4, 'ascii');
    }
    offset += entry.size;
  }
  if (offset !== stsd.end) throw fail('stsd sample entries 长度不匹配');
}

function indexMP4(prefix, key, total) {
  var roots = readBoxes(prefix, 0, prefix.length);
  var moov = null;
  for (var i = 0; i < roots.length; i++) if (roots[i].type === 'moov') { moov = roots[i]; break; }
  if (!moov) throw fail('MP4 缺少 moov');
  var tracks = readBoxes(prefix, moov.payload, moov.end);
  var samples = [];
  var encryptedTracks = 0;
  for (i = 0; i < tracks.length; i++) {
    if (tracks[i].type !== 'trak') continue;
    var stbl = findPath(prefix, tracks[i], ['mdia', 'minf', 'stbl']);
    if (!stbl) continue;
    var senc = findChild(prefix, stbl, 'senc');
    if (!senc) continue;
    if (!key || key.length !== 16) throw fail('加密轨道缺少 16 字节 CENC key');
    var track = parseSampleTable(prefix, stbl, senc);
    for (var j = 0; j < track.length; j++) {
      if (track[j].offset < 0 || track[j].size <= 0 || track[j].offset + track[j].size > total) throw fail('MP4 样本超出文件范围');
      if (samples.length >= MAX_SAMPLES) throw fail('MP4 样本索引超过上限');
      samples.push(track[j]);
    }
    patchSampleEntries(prefix, stbl);
    encryptedTracks++;
  }
  if (!encryptedTracks) throw fail('MP4 没有受支持的 senc 加密轨道');
  samples.sort(function (a, b) { return a.offset - b.offset; });
  return samples;
}

function open(target, key, metadata, options) {
  metadata = metadata || {};
  options = options || {};
  var deadline = Date.now() + (options.totalTimeoutMs || 8000);
  function read(target, start, end, etag) {
    return requestRange(target, start, end, etag, 0, options.timeout || 5000, options.signal, deadline);
  }
  var firstEnd = PROBE_BYTES - 1;
  return read(target, 0, firstEnd, '').then(function (response) {
    if (response.status !== 206) throw fail('上游未支持 Range (HTTP ' + response.status + ')');
    var etag = String(response.headers.etag || '').trim();
    if (!strongETag(etag)) throw fail('上游没有稳定的强 ETag');
    var range = parseContentRange(response.headers['content-range']);
    if (!range || range.start !== 0 || range.end < 0 || range.total <= range.end || range.end > firstEnd || response.body.length !== range.end + 1 || range.total > MAX_MEDIA_BYTES) throw fail('上游初始 Content-Range 无效');
    var found = findMoovEnd(response.body, range.total);
    var prefixPromise;
    if (found.complete) prefixPromise = Promise.resolve(response.body.slice(0, found.end));
    else if (found.end > 0) {
      if (found.end > MAX_MOOV_BYTES) throw fail('MP4 moov 超过支持上限');
      prefixPromise = read(response.url, 0, found.end - 1, etag).then(function (initial) {
        var nextRange = parseContentRange(initial.headers['content-range']);
        if (initial.status !== 206 || String(initial.headers.etag || '').trim() !== etag || !nextRange || nextRange.start !== 0 || nextRange.end !== found.end - 1 || nextRange.total !== range.total || initial.body.length !== found.end) throw fail('上游 MP4 初始化区不稳定');
        return initial.body;
      });
    } else throw fail('MP4 moov 初始化区未能定位');
    return prefixPromise.then(function (prefix) {
      var samples = indexMP4(prefix, key, range.total);
      var metadataBytes = prefix.length + samples.length * 128 + key.length;
      if (metadataBytes > MAX_SOURCE_METADATA_BYTES) throw fail('MP4 Range 索引超过内存限制');
      return { url: response.url, etag: etag, length: range.total, prefix: prefix, samples: samples, key: Buffer.from(key), vid: String(metadata.vid || ''), quality: String(metadata.quality || ''), firstMediaRead: true };
    });
  });
}

function parseByteRange(value, length) {
  if (!value) return { start: 0, end: length - 1, partial: false };
  if (!isFinite(length) || length <= 0 || String(value).indexOf(',') >= 0) return null;
  var match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    var suffix = Number(match[2]);
    if (!isFinite(suffix) || suffix <= 0) return null;
    suffix = Math.min(suffix, length);
    return { start: length - suffix, end: length - 1, partial: true };
  }
  var start = Number(match[1]);
  var end = match[2] ? Number(match[2]) : length - 1;
  if (!isFinite(start) || !isFinite(end) || Math.floor(start) !== start || Math.floor(end) !== end || start < 0 || start >= length || end < start) return null;
  return { start: start, end: Math.min(end, length - 1), partial: true };
}

function incrementCounter(counter, blocks) {
  for (var i = counter.length - 1; i >= 0 && blocks > 0; i--) {
    var value = counter[i] + (blocks % 256);
    counter[i] = value & 255;
    blocks = Math.floor(blocks / 256) + Math.floor(value / 256);
  }
  if (blocks > 0) throw fail('CENC counter 溢出');
  return counter;
}

function decryptFragment(data, sample, key, from) {
  var offset = from - sample.offset;
  if (offset < 0) throw fail('CENC sample 偏移无效');
  var iv = Buffer.alloc(16);
  sample.iv.copy(iv, 0, 0, Math.min(16, sample.iv.length));
  incrementCounter(iv, Math.floor(offset / 16));
  var skip = offset % 16;
  var input = Buffer.alloc(skip + data.length);
  data.copy(input, skip);
  var decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
  decipher.setAutoPadding(false);
  var plain = Buffer.concat([decipher.update(input), decipher.final()]);
  plain.copy(data, 0, skip);
}

function refreshSource(source, failedTarget) {
  if (source.refreshing) return source.refreshing;
  if (typeof source.refresh !== 'function') return Promise.reject(fail('媒体源已失效且无法刷新', 'MEDIA_URL_EXPIRED'));
  source.refreshing = Promise.resolve().then(function () { return source.refresh(); }).then(function (candidate) {
    if (!candidate || !candidate.url || !Buffer.isBuffer(candidate.key) || !candidate.key.equals(source.key)) throw fail('刷新后的媒体身份不匹配');
    return requestRange(candidate.url, 0, 0, '', 0).then(function (probe) {
      var range = parseContentRange(probe.headers['content-range']);
      var etag = String(probe.headers.etag || '').trim();
      if (probe.status !== 206 || !range || range.start !== 0 || range.end !== 0 || range.total !== source.length || etag !== source.etag || probe.body.length !== 1) throw fail('刷新后的媒体与当前视频不一致');
      if (source.url === failedTarget) source.url = probe.url;
      return source.url;
    });
  }).then(function (value) {
    source.refreshing = null;
    return value;
  }, function (error) {
    source.refreshing = null;
    throw error;
  });
  return source.refreshing;
}

function waitRetry(attempt) {
  return new Promise(function (resolve) { setTimeout(resolve, attempt === 1 ? 250 : 600); });
}

function fetchExact(source, start, end, options) {
  options = options || {};
  var timeout = Number(options.timeout) > 0 ? Number(options.timeout) : REQUEST_TIMEOUT;
  var maxFailures = Number.isFinite(options.maxFailures) ? Math.max(0, Number(options.maxFailures)) : RANGE_RETRIES;
  var output = Buffer.alloc(end - start + 1);
  var cursor = start;
  var refreshed = false;
  function acceptResponse(response, failures) {
    if (response.status !== 206) {
      var statusError = fail('上游媒体 Range HTTP ' + response.status);
      statusError.status = response.status;
      if ((response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) && failures < maxFailures) {
        return waitRetry(failures + 1).then(function () { return requestFrom(failures + 1); });
      }
      throw statusError;
    }
    var range = parseContentRange(response.headers['content-range']);
    if (!range || range.start !== cursor || range.end < cursor || range.end > end || range.total !== source.length || String(response.headers.etag || '').trim() !== source.etag || response.body.length > range.end - range.start + 1) throw fail('上游媒体 Range 校验失败');
    response.body.copy(output, cursor - start);
    cursor += response.body.length;
    if (cursor > end) return output;
    if (cursor === range.end + 1) return requestFrom(0);
    throw fail('上游媒体 Range 响应长度不足', 'RANGE_INTERRUPTED');
  }
  function retryInterrupted(error, failures) {
    if (options.signal && options.signal.aborted) return Promise.reject(audioCancel.error(options.signal));
    if (error && error.name === 'AbortError') return Promise.reject(error);
    if (error && error.code === 'RANGE_RESPONSE_TOO_LARGE') return Promise.reject(error);
    var partial = error && error.rangeResponse;
    if (partial && partial.status === 206) {
      var range = parseContentRange(partial.headers['content-range']);
      if (!range || range.start !== cursor || range.end < cursor || range.end > end || range.total !== source.length || String(partial.headers.etag || '').trim() !== source.etag || partial.body.length > range.end - range.start + 1) throw fail('上游媒体 Range 校验失败');
      partial.body.copy(output, cursor - start);
      cursor += partial.body.length;
      if (cursor > end) return Promise.resolve(output);
    }
    if (failures >= maxFailures) return Promise.reject(error);
    return waitRetry(failures + 1).then(function () { return requestFrom(failures + 1); });
  }
  function requestFrom(failures) {
    if (options.signal && options.signal.aborted) return Promise.reject(audioCancel.error(options.signal));
    var target = source.url;
    return requestRange(target, cursor, end, source.etag, 0, timeout, options.signal).then(function (response) {
      if ([401, 403, 404, 410].indexOf(response.status) >= 0 && !refreshed && typeof source.refresh === 'function') {
        refreshed = true;
        return refreshSource(source, target).then(function () { return requestFrom(0); });
      }
      return acceptResponse(response, failures);
    }, function (error) {
      if (error && error.status) return Promise.reject(error);
      return retryInterrupted(error, failures);
    });
  }
  return requestFrom(0);
}

function fetchMediaUncached(source, start, end, options) {
  if (options && options.signal && options.signal.aborted) return Promise.reject(audioCancel.error(options.signal));
  source.lastUsedAt = Date.now();
  var result = Buffer.alloc(end - start + 1);
  var cursor = Math.max(start, source.prefix.length);
  var tasks = [];
  while (cursor <= end) {
    var chunkEnd = Math.min(end, cursor + CHUNK_BYTES - 1);
    tasks.push({ start: cursor, end: chunkEnd, targetOffset: cursor - start });
    cursor = chunkEnd + 1;
  }
  var startup = source.firstMediaRead !== false && tasks.length > 0;
  var requestOptions = startup ? { timeout: STARTUP_REQUEST_TIMEOUT, maxFailures: STARTUP_RETRIES } : null;
  if (options) requestOptions = Object.assign({}, requestOptions || {}, { signal: options.signal },
    options.speculative ? { timeout: STARTUP_REQUEST_TIMEOUT, maxFailures: 0 } : {});
  var chain = Promise.resolve();
  tasks.forEach(function (task) {
    chain = chain.then(function () {
      return fetchExact(source, task.start, task.end, requestOptions).then(function (buffer) { buffer.copy(result, task.targetOffset); });
    });
  });
  return chain.then(function () {
    var prefixEnd = source.prefix.length - 1;
    if (prefixEnd >= start) {
      var copyEnd = Math.min(end, prefixEnd);
      source.prefix.copy(result, 0, start, copyEnd + 1);
    }
    var low = 0;
    var high = source.samples.length;
    while (low < high) {
      var middle = low + Math.floor((high - low) / 2);
      if (source.samples[middle].offset + source.samples[middle].size <= start) low = middle + 1;
      else high = middle;
    }
    var left = low;
    for (var i = left; i < source.samples.length; i++) {
      var sample = source.samples[i];
      if (sample.offset > end) break;
      var from = Math.max(start, sample.offset);
      var to = Math.min(end + 1, sample.offset + sample.size);
      if (from < to) {
        var fragment = result.slice(from - start, to - start);
        decryptFragment(fragment, sample, source.key, from);
        fragment.copy(result, from - start);
      }
    }
    if (startup) source.firstMediaRead = false;
    return result;
  });
}

function fetchMedia(source, start, end, signal) { return headCache.read(source, start, end, signal); }

function prefetchHead(source, signal) {
  var cancel = audioCancel.create();
  function aborted() { cancel.abort(); }
  if (signal) { signal.addEventListener('abort', aborted); if (signal.aborted) aborted(); }
  // A speculative read has one total budget, including all four blocks.
  var timer = setTimeout(aborted, 5000);
  function finish() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', aborted); }
  return headCache.warm(source, cancel.signal).then(function (bytes) { finish(); return bytes; }, function (error) { finish(); throw error; });
}

function serve(req, res, source, onStatus) {
  function setStatus(status) { if (typeof onStatus === 'function') onStatus(status); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    setStatus(405); res.statusCode = 405; res.setHeader('Allow', 'GET, HEAD'); return res.end();
  }
  var range = parseByteRange(req.headers.range, source.length);
  if (!range) {
    setStatus(416);
    res.statusCode = 416; res.setHeader('Content-Range', 'bytes */' + source.length); return res.end();
  }
  if (range.partial && req.headers['if-range'] && String(req.headers['if-range']).trim() !== source.etag) range = { start: 0, end: source.length - 1, partial: false };
  var start = range.start;
  var end = range.end;
  setStatus(range.partial ? 206 : 200);
  res.statusCode = range.partial ? 206 : 200;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=900');
  res.setHeader('ETag', source.etag);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Content-Length', String(end - start + 1));
  if (range.partial) res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + source.length);
  if (req.method === 'HEAD') return res.end();
  var consumer = audioCancel.create();
  function disconnected() { consumer.abort(); }
  res.once('close', disconnected);
  res.once('finish', function () { res.removeListener('close', disconnected); });
  function writeChunk(cursor) {
    if (res.destroyed || consumer.signal.aborted) return;
    // Content-Length completes the client's body parser, but Node still needs
    // end() to release this response and send the next one on a reused socket.
    if (cursor > end) return res.end();
    var chunkEnd = Math.min(end, cursor + CHUNK_BYTES - 1);
    fetchMedia(source, cursor, chunkEnd, consumer.signal).then(function (buffer) {
      if (res.destroyed || consumer.signal.aborted) return;
      if (res.write(buffer)) writeChunk(chunkEnd + 1);
      else res.once('drain', function () { writeChunk(chunkEnd + 1); });
    }, function (error) {
      if (res.destroyed || consumer.signal.aborted) return;
      if (res.headersSent) { if (typeof res.destroy === 'function') res.destroy(error); return; }
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Range');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      setStatus(502);
      res.statusCode = 502;
      var body = Buffer.from(JSON.stringify({ ok: false, error: error.code || 'UPSTREAM_RANGE', message: error.message }), 'utf8');
      res.setHeader('Content-Length', body.length);
      res.end(body);
    });
  }
  writeChunk(start);
}

function downloadFile(target, destination, headers, maxBytes, beforeWrite, options) {
  headers = headers || {};
  maxBytes = maxBytes || MAX_MEDIA_BYTES;
  options = options || {};
  var signal = options.signal, deadline = Date.now() + (options.totalTimeoutMs || 30000);
  function attempt(current, redirects) {
    if (redirects > MAX_REDIRECTS) return Promise.reject(fail('媒体源重定向次数过多'));
    var parsed = url.parse(current);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return Promise.reject(fail('媒体源协议无效'));
    var transport = parsed.protocol === 'http:' ? http : https;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var request, output, responseStream, timer;
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      }
      var failure;
      function stop(error) {
        if (settled || failure) return;
        failure = error;
        if (request) request.destroy();
        if (responseStream) responseStream.destroy();
        // Do not release the cache lease until the file descriptor is closed.
        if (output) output.destroy(); else finish(error);
      }
      function aborted() { stop(audioCancel.error(signal)); }
      if (signal && signal.aborted) { aborted(); return; }
      if (signal) signal.addEventListener('abort', aborted);
      timer = setTimeout(function () { stop(fail('媒体下载超时', 'MEDIA_DOWNLOAD_TIMEOUT')); }, Math.max(1, deadline - Date.now()));
      try {
        request = transport.get({ protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443), path: parsed.path || '/', headers: requestHeaders, timeout: options.idleTimeoutMs || 12000 }, function (response) {
          responseStream = response;
          if (settled || failure) { response.destroy(); return; }
          var location = response.headers.location;
          if ([301, 302, 303, 307, 308].indexOf(response.statusCode) >= 0 && location) {
            response.resume();
            var redirected = url.resolve(current, location);
            var next = url.parse(redirected);
            if (parsed.protocol === 'https:' && next.protocol !== 'https:') { finish(fail('媒体源重定向试图降级到 HTTP')); return; }
            attempt(redirected, redirects + 1).then(function () { finish(); }, finish);
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume(); finish(fail('媒体源 HTTP ' + response.statusCode)); return;
          }
          try { output = fs.createWriteStream(destination, { mode: 384 }); } catch (error) { response.resume(); finish(error); return; }
          var total = 0;
          response.on('data', function (chunk) {
            total += chunk.length;
            try {
              if (total > maxBytes) throw fail('媒体超过大小限制');
              if (beforeWrite) beforeWrite(total);
            } catch (error) {
              stop(error);
            }
          });
          response.on('error', stop);
          response.on('aborted', function () { stop(fail('媒体下载中断', 'MEDIA_DOWNLOAD_INTERRUPTED')); });
          output.on('error', stop);
          output.on('close', function () { finish(failure); });
          response.pipe(output);
        });
      } catch (error) { finish(error); return; }
      request.on('error', stop);
      request.on('timeout', function () { stop(fail('媒体下载超时', 'MEDIA_DOWNLOAD_TIMEOUT')); });
    });
  }
  var requestHeaders = Object.assign({
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Referer: 'https://novel.snssdk.com/',
    Origin: 'https://novel.snssdk.com'
  }, headers);
  return attempt(target, 0);
}

module.exports = {
  open: open,
  serve: serve,
  downloadFile: downloadFile,
  parseByteRange: parseByteRange,
  parseContentRange: parseContentRange,
  strongETag: strongETag,
  decryptFragment: decryptFragment,
  _indexMP4: indexMP4,
  _fetchMedia: fetchMedia,
  prefetchHead: prefetchHead,
  headDiagnostics: headCache.diagnostics,
  clearHeadCache: headCache.clear
};
