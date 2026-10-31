// First-party webOS provider. This is a clean JavaScript port of the
// protocol already implemented in the Go core; it does not vendor the GPL
// provider from another webOS project.
(function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  var crypto = require('crypto');
  var http = require('http');
  var https = require('https');
  var url = require('url');
  var URLConstructor = typeof URL === 'function' ? URL : url.URL;
  var querystring = require('querystring');
  var createAccount = require('./account');
  var passportSign = require('./passport-sign');
  var rangeMedia = require('./range-media');
  var createMediaCache = require('./media-cache');
  var audioMedia = require('./audio-media');
  var audioRange = require('./audio-range'), audioCancel = require('./audio-cancel');

  var API_BASE = 'https://api5-normal-sinfonlineb.fqnovel.com';
  var WEB_BASE = 'https://hongguoduanju.com';
  var API_PATH = '/novel/player/multi_video_model/v1/';
  var APP_UA = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
  var PLAYBACK_UA = 'com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)';
  var FALLBACK_UA = 'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
  var MAX_JSON = 5 * 1024 * 1024;
  var MAX_MEDIA = 512 * 1024 * 1024;
  var jobs = Object.create(null);
  var fullDownloads = Object.create(null);
  var rangeSources = Object.create(null);
  var mediaStatus = Object.create(null);
  var audioJobs = Object.create(null), audioCache = [];
  var preparationReports = Object.create(null);
  var lastForegroundPreparation = null;
  var RANGE_PREPARATION_TTL = 120000;
  var cacheRoot = '';
  var mediaCache = null;
  var lastVideoModelDiagnostic = null;
  var playbackDevicePromise = null;

  function fail(message, status, code, stage) { var error = new Error(message); error.code = code || 'PROVIDER_ERROR'; if (status) error.status = status; if (stage) error.stage = stage; return error; }
  function preparationCancelled() {
    var error = fail('播放准备已取消', 499, 'PLAYBACK_PREPARATION_CANCELLED');
    error.name = 'AbortError'; return error;
  }
  function transientVideoModelError(error) {
    if (!error) return false;
    if (error.code === 'VIDEO_MODEL_HTTP') return [408, 425, 429, 500, 502, 503, 504].indexOf(Number(error.status)) >= 0;
    return ['VIDEO_MODEL_EMPTY', 'UPSTREAM_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET',
      'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'].indexOf(error.code) >= 0;
  }
  function recoveryDelay(signal, delay) {
    return new Promise(function (resolve, reject) {
      var timer;
      if (!signal) { timer = setTimeout(resolve, Number(delay) || 250); return; }
      function aborted() { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(preparationCancelled()); }
      if (signal.aborted) { reject(preparationCancelled()); return; }
      signal.addEventListener('abort', aborted);
      timer = setTimeout(function () { signal.removeEventListener('abort', aborted); resolve(); }, Number(delay) || 250);
    });
  }
  function parseExactJSON(text) {
    var out = '', inString = false, escaped = false, i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (inString) { out += ch; if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; i++; continue; }
      if (ch === '"') { inString = true; out += ch; i++; continue; }
      if (ch === '-' || ch >= '0' && ch <= '9') { var start = i; while (i < text.length && /[0-9eE+.-]/.test(text.charAt(i))) i++; var token = text.slice(start, i); out += /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token; continue; }
      out += ch; i++;
    }
    return JSON.parse(out);
  }
  function mkdirp(directory, mode) {
    try { fs.mkdirSync(directory, mode); }
    catch (error) {
      if (error.code === 'EEXIST') { if (!fs.statSync(directory).isDirectory()) throw error; return; }
      if (error.code !== 'ENOENT') throw error;
      var parent = path.dirname(directory); if (parent === directory) throw error;
      mkdirp(parent, mode); fs.mkdirSync(directory, mode);
    }
  }
  function trim(value) { return String(value == null ? '' : value).replace(/^\s+|\s+$/g, ''); }
  function validID(value) { return /^[0-9]{1,32}$/.test(trim(value)); }
  function first() { var i; for (i = 0; i < arguments.length; i++) { if (trim(arguments[i])) return trim(arguments[i]); } return ''; }
  function number(value) { var n = Number(value); return isFinite(n) ? n : 0; }
  function bool(value) { return value === true || value === 1 || value === '1' || value === 'true'; }
  function stringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function (item) {
      if (item && typeof item === 'object') item = first(item.name, item.title, item.content);
      return trim(item);
    }).filter(Boolean);
  }

  function requestBuffer(target, method, headers, body, limit, signal, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var finished = false;
      function finish(error, value) {
        if (finished) return; finished = true;
        if (signal) signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(value);
      }
      function aborted() {
        var error = preparationCancelled(); finish(error);
        if (request) request.destroy(error);
      }
      if (signal && signal.aborted) { finish(preparationCancelled()); return; }
      var parsed = url.parse(target);
      var transport = parsed.protocol === 'http:' ? http : https;
      var options = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.path,
        method: method || 'GET',
        headers: headers || {},
        timeout: Math.max(1000, Number(timeoutMs) || 90000)
      };
      var request;
      try { request = transport.request(options); } catch (error) { finish(error); return; }
      if (signal) signal.addEventListener('abort', aborted);
      request.on('timeout', function () { request.destroy(fail('上游请求超时', undefined, 'UPSTREAM_TIMEOUT')); });
      request.on('error', function (error) { finish(error); });
      request.on('response', function (response) {
        response.on('error', function (error) { finish(error); });
        response.on('aborted', function () { var error = fail('上游响应中断', 502, 'ECONNRESET'); finish(error); });
        var chunks = [];
        var total = 0;
        response.on('data', function (chunk) {
          if (finished) return;
          total += chunk.length;
          if (limit && total > limit) {
            request.destroy(fail('上游响应超过大小限制'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', function () {
          finish(null, { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
        });
      });
      if (body) request.write(body);
      request.end();
    });
  }

  function jsonRequest(target, method, body) {
    var raw = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    var headers = {
      'User-Agent': APP_UA,
      Accept: 'application/json',
      'Accept-Encoding': 'identity'
    };
    if (raw) { headers['Content-Type'] = 'application/json; charset=utf-8'; headers['Content-Length'] = raw.length; }
    return requestBuffer(target, method || 'GET', headers, raw, MAX_JSON).then(function (response) {
      if (response.status < 200 || response.status >= 300) throw fail('红果接口 HTTP ' + response.status);
      var text = response.body.toString('utf8');
      if (!trim(text)) throw fail('红果接口返回空响应');
      try { return parseExactJSON(text); } catch (error) { throw fail('红果接口响应不是有效 JSON'); }
    });
  }

  // Signed JSON calls shared by the public metadata endpoints.  The webOS
  // service has no account manager, but public catalogue/metadata APIs still
  // use the same Passport envelope as video_model.  Keep the device identity
  // one-shot for every request, matching the upstream anti-replay behavior.
  function signedJSON(pathName, method, values, body) {
    var raw = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
    var attempt = 0;
    function next() {
      attempt++;
      var device = freshDevice();
      var stamp = Date.now();
      var params = appQuery(device);
      Object.keys(values || {}).forEach(function (key) { params[key] = String(values[key]); });
      params._rticket = String(stamp);
      var signed = passportSign.sign(params, raw, stamp, device.deviceID);
      var headers = signed.headers;
      headers['User-Agent'] = APP_UA;
      headers.Accept = 'application/json';
      headers['Accept-Encoding'] = 'identity';
      if (raw.length) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        headers['Content-Length'] = raw.length;
      }
      headers['X-XS-From-Web'] = '0'; headers['Sdk-Version'] = '2'; headers['X-SS-DP'] = '8662';
      headers['X-Tt-Store-Region'] = 'cn'; headers['X-Tt-Store-Region-Src'] = 'did';
      return requestBuffer(API_BASE + pathName + '?' + signed.query, method || 'GET', headers, raw.length ? raw : null, MAX_JSON).then(function (response) {
        if (response.status < 200 || response.status >= 300) throw fail('红果接口 HTTP ' + response.status);
        var text = response.body.toString('utf8');
        if (!trim(text)) {
          if (attempt < 3) return next();
          throw fail('红果接口返回空响应');
        }
        try { return parseExactJSON(text); } catch (error) { throw fail('红果接口响应不是有效 JSON'); }
      }).catch(function (error) {
        if (attempt < 3 && /返回空响应/.test(String(error && error.message || error))) return next();
        throw error;
      });
    }
    return next();
  }

  function publicJSON(pathName, values) {
    var query = [];
    Object.keys(values || {}).forEach(function (key) { query.push(querystring.escape(key) + '=' + querystring.escape(String(values[key]))); });
    return requestBuffer(WEB_BASE + pathName + (query.length ? '?' + query.join('&') : ''), 'GET', { 'User-Agent': 'Googlebot', Accept: 'application/json' }, null, MAX_JSON).then(function (response) {
      if (response.status < 200 || response.status >= 300) throw fail('官网 HTTP ' + response.status);
      var text = response.body.toString('utf8');
      if (!trim(text)) throw fail('官网接口返回空响应');
      try { return parseExactJSON(text); } catch (error) { throw fail('官网接口响应不是有效 JSON'); }
    });
  }

  function miniJSON(pathName, values) {
    var device = freshDevice();
    var stamp = Date.now();
    var params = appQuery(device);
    delete params._rticket;
    Object.keys(values || {}).forEach(function (key) { params[key] = String(values[key]); });
    params._rticket = String(stamp);
    var query = sortedQuery(params);
    var headers = miniSign(query, Buffer.alloc(0), stamp);
    headers['User-Agent'] = APP_UA;
    headers['X-XS-From-Web'] = '0'; headers['Sdk-Version'] = '2';
    headers.Accept = 'application/json';
    return requestBuffer(API_BASE + pathName + '?' + query, 'GET', headers, null, MAX_JSON).then(function (response) {
      if (response.status < 200 || response.status >= 300) throw fail('红果接口 HTTP ' + response.status);
      var text = response.body.toString('utf8');
      if (!trim(text)) throw fail('红果接口返回空响应');
      try { return parseExactJSON(text); } catch (error) { throw fail('红果接口响应不是有效 JSON'); }
    });
  }

  function sortedQuery(values) {
    var keys = Object.keys(values).sort();
    var out = [];
    keys.forEach(function (key) { out.push(querystring.escape(key) + '=' + querystring.escape(String(values[key]))); });
    return out.join('&');
  }

  function appQuery(device) {
    return {
      _rticket: String(Date.now()), ac: 'wifi', aid: '8662', app_name: 'novelread', channel: 'update_64',
      device_brand: 'Redmi', device_id: device.deviceID, device_platform: 'android', device_type: '25053RT47C',
      dpi: '520', iid: device.installID, language: 'zh', manifest_version_code: '73532', os: 'android',
      os_api: '36', os_version: '16', resolution: '1280*2772', ssmix: 'a', update_version_code: '73532',
      version_code: '73532', version_name: '7.3.5.32'
    };
  }

  function playbackQuery(device, stamp) {
    return {
      _rticket: String(stamp), ac: 'wifi', aid: '8662', app_name: 'novelread', channel: 'update_64', cdid: device.cdid,
      compliance_status: '0', device_brand: 'Redmi', device_id: device.deviceID, device_platform: 'android',
      device_type: '25053RT47C', dpi: '520', dragon_device_type: 'phone', host_abi: 'arm64-v8a', iid: device.installID,
      is_android_pad_screen: '0', language: 'zh', manifest_version_code: '71332', need_personal_recommend: '1',
      os: 'android', os_api: '36', os_version: '16', player_so_load: '1', pv_player: '71332',
      resolution: '1280*2772', ssmix: 'a', update_version_code: '71332', version_code: '71332', version_name: '7.1.3.32'
    };
  }

  function getPlaybackDevice() {
    if (!playbackDevicePromise) {
      var pending = Promise.resolve().then(function () {
        return createAccount.registerPlaybackDevice(function (target, method, headers, body, limit) {
          return requestBuffer(target, method, headers, body, limit, null, 8000);
        });
      }).catch(function (error) {
        if (playbackDevicePromise === pending) playbackDevicePromise = null;
        throw error;
      });
      playbackDevicePromise = pending;
    }
    return playbackDevicePromise;
  }

  function randomID() {
    var bytes = crypto.randomBytes(16);
    var text = '';
    var i;
    for (i = 0; i < bytes.length; i++) text += String(bytes[i] % 10);
    return '1' + text.slice(1, 16);
  }
  function freshDevice() { return { deviceID: randomID(), installID: randomID() }; }
  function reverseBits(value) {
    var out = 0, i;
    for (i = 0; i < 8; i++) out |= ((value >> i) & 1) << (7 - i);
    return out;
  }
  function rotateNibble(value) { return ((value << 4) | (value >> 4)) & 255; }

  function miniSign(query, body, stamp) {
    var queryDigest = crypto.createHash('md5').update(query).digest();
    var bodyDigest = crypto.createHash('md5').update(body || '').digest();
    var payload = Buffer.alloc(20);
    queryDigest.copy(payload, 0, 0, 4);
    bodyDigest.copy(payload, 4, 0, 4);
    payload[12] = 0; payload[13] = 6; payload[14] = 11; payload[15] = 28;
    payload.writeUInt32BE(Math.floor(stamp / 1000), 16);
    var mask = Buffer.from('44b9b9d9a4aef9fca493aa757ca3c2c4a496938f', 'hex');
    var i;
    for (i = 0; i < 20; i++) payload[i] ^= mask[i];
    for (i = 0; i < 20; i++) payload[i] = reverseBits(rotateNibble(payload[i]) ^ payload[(i + 1) % 20]) ^ 0xff ^ 20;
    return {
      'X-Khronos': String(Math.floor(stamp / 1000)),
      'X-Gorgon': '8404401c0000' + payload.toString('hex'),
      'X-SS-STUB': bodyDigest.toString('hex').toUpperCase(),
      'X-SS-Req-Ticket': String(stamp)
    };
  }

  function bitCount(value) { var count = 0; while (value) { count++; value &= value - 1; } return count; }
  function base36(value) {
    if (value >= 48 && value <= 57) return value - 48;
    if (value >= 97 && value <= 122) return value - 97 + 10;
    if (value >= 65 && value <= 90) return value - 65 + 10;
    return -1;
  }
  function decodeSpade(value) {
    var raw;
    try { raw = Buffer.from(value, 'base64'); } catch (error) { raw = Buffer.alloc(0); }
    if (!raw.length) { try { raw = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch (ignored) {} }
    if (raw.length < 3 || raw.length > 1024) throw fail('spade_a 无效');
    var tagLength = (raw[0] ^ raw[1] ^ raw[2]) - 48;
    var length = raw.length - tagLength - 1;
    if (tagLength < 1 || length < 33 || length >= raw.length) throw fail('spade_a 结构无效');
    var seed = raw[raw.length - tagLength - 2] ^ raw[raw.length - tagLength - 1];
    var tag = Buffer.alloc(tagLength);
    var i;
    for (i = 0; i < tagLength; i++) tag[i] = raw[raw.length - tagLength + i] ^ seed;
    if (tag.toString() === 'app_v2' || tag.toString() === 'web_v2') throw fail('spade_a 格式不支持');
    var decoded = Buffer.alloc(length);
    var previous = [250, 85];
    for (i = 0; i < length; i++) {
      var current = raw[i + 1];
      decoded[i] = (previous[i % 2] ^ current) - 21 - bitCount(i) & 255;
      previous[i % 2] = current;
    }
    var keyLength = base36(decoded[0]);
    if (keyLength < 0 || keyLength >= 36 || length - keyLength - 1 !== 32) throw fail('spade_a 密钥载荷无效');
    var keyText = decoded.slice(1, 33).toString();
    if (!/^[0-9a-fA-F]{32}$/.test(keyText)) throw fail('CENC 密钥无效');
    return Buffer.from(keyText, 'hex');
  }

  function decodeModel(value) {
    if (typeof value === 'string') {
      try { return parseExactJSON(value); } catch (ignored) {}
    }
    return value;
  }
  function modelString(value) { if (typeof value === 'string') return trim(value); if (value == null) return ''; return String(value); }
  function modelRows(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    return Object.keys(value).map(function (key) { return value[key]; }).filter(function (row) { return row && typeof row === 'object'; });
  }

  function fallbackAPI(value) {
    if (typeof value === 'string') {
      var text = trim(value), parsed;
      try { parsed = parseExactJSON(text); } catch (ignored) { return text; }
      if (Array.isArray(parsed)) return fallbackAPI(parsed[0]);
      if (parsed && typeof parsed === 'object') return fallbackAPI(parsed.fallback_api);
      return text;
    }
    if (Array.isArray(value)) return value.length ? fallbackAPI(value[0]) : '';
    if (value && typeof value === 'object') return fallbackAPI(value.fallback_api);
    return '';
  }

  function checkedFallbackURL(target) {
    var parsed;
    try { parsed = URLConstructor ? new URLConstructor(String(target)) : url.parse(String(target)); } catch (ignored) { parsed = null; }
    var host = String(parsed && parsed.hostname || '').toLowerCase();
    function inDomain(domain) { return host === domain || host.slice(-domain.length - 1) === '.' + domain; }
    var trusted = inDomain('fqnovel.com') || inDomain('snssdk.com');
    var hasCredentials = parsed && (parsed.username || parsed.password || parsed.auth);
    if (!parsed || parsed.protocol !== 'https:' || !host || hasCredentials || parsed.hash || parsed.port && parsed.port !== '443' || !trusted) {
      throw fail('fallback_api 地址不在允许的 HTTPS 域名内', 502, 'FALLBACK_API_BLOCKED', 'fallback_api');
    }
    return parsed.href || url.format(parsed);
  }

  function fallbackModel(target, signal, redirects, deadline) {
    var safeTarget;
    try { safeTarget = checkedFallbackURL(target); } catch (error) { return Promise.reject(error); }
    if (signal && signal.aborted) return Promise.reject(preparationCancelled());
    deadline = Number(deadline) || Date.now() + 12000;
    var remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(fail('fallback_api 请求超时', 502, 'ETIMEDOUT', 'fallback_api'));
    var headers = { 'User-Agent': FALLBACK_UA, Accept: 'application/json; charset=utf-8,application/x-protobuf' };
    return requestBuffer(safeTarget, 'GET', headers, null, MAX_JSON, signal, remaining).then(function (response) {
      if ([301, 302, 303, 307, 308].indexOf(Number(response.status)) >= 0) {
        var location = response.headers && (response.headers.location || response.headers.Location);
        if (!location || redirects >= 3) throw fail('fallback_api 跳转次数超限或缺少目标地址', 502, 'FALLBACK_API_REDIRECT', 'fallback_api');
        var next;
        try { next = URLConstructor ? new URLConstructor(location, safeTarget).toString() : url.resolve(safeTarget, location); } catch (ignored) { throw fail('fallback_api 跳转地址无效', 502, 'FALLBACK_API_REDIRECT', 'fallback_api'); }
        try { checkedFallbackURL(next); } catch (error) { throw fail('fallback_api 跳转到不受信任的域名', 502, 'FALLBACK_API_BLOCKED', 'fallback_api'); }
        return fallbackModel(next, signal, redirects + 1, deadline);
      }
      if (response.status !== 200) throw fail('fallback_api HTTP ' + response.status, 502, 'FALLBACK_API_HTTP', 'fallback_api');
      var envelope;
      try { envelope = parseExactJSON(response.body.toString('utf8')); } catch (error) { throw fail('fallback_api 响应不是有效 JSON', 502, 'FALLBACK_API_INVALID_JSON', 'fallback_api'); }
      var responseCode = modelString(envelope && (envelope.Code == null ? envelope.code : envelope.Code));
      if (responseCode && responseCode !== '0') throw fail('fallback_api 拒绝了播放请求（' + responseCode + '）', 502, 'FALLBACK_API_REJECTED', 'fallback_api');
      var videoInfo = envelope && envelope.video_info;
      if (!videoInfo || typeof videoInfo !== 'object') throw fail('fallback_api 未返回 video_info', 502, 'FALLBACK_API_MISSING_MODEL', 'fallback_api');
      var infoCode = modelString(videoInfo.Code == null ? videoInfo.code : videoInfo.Code);
      if (infoCode && infoCode !== '0') throw fail('fallback_api video_info 拒绝了播放请求（' + infoCode + '）', 502, 'FALLBACK_API_REJECTED', 'fallback_api');
      var model = decodeModel(videoInfo.data);
      if (!model || typeof model !== 'object') throw fail('fallback_api 未返回本集视频模型', 502, 'FALLBACK_API_MISSING_MODEL', 'fallback_api');
      return model;
    });
  }

  function videoOptions(vid, signal, retry) {
    retry = retry || {};
    var transientRetries = 0;
    var maxTransientRetries = Math.max(0, Number(retry.maxTransientRetries) || 0);
    var maximum = Math.max(1, Math.min(3, Number(retry.maxAttempts) || 3));
    var offset = Number(retry.attemptOffset) || 0;
    var attempt = 0;
    var startedAt = Number(retry.startedAt) || Date.now();
    var diagnostic;
    function recordDiagnostic(value) {
      diagnostic = Object.assign({}, value, { video_id: String(vid), attempt: offset + attempt, elapsed_ms: Math.max(0, Date.now() - startedAt) });
      lastVideoModelDiagnostic = Object.assign({}, diagnostic);
      if (typeof retry.onDiagnostic === 'function') {
        var safe = Object.assign({}, diagnostic); delete safe.video_id;
        retry.onDiagnostic(safe);
      }
    }
    function next() {
      if (signal && signal.aborted) return Promise.reject(preparationCancelled());
      attempt++;
      recordDiagnostic({ stage: 'device_register', code: 'VIDEO_MODEL_REQUEST' });
      return getPlaybackDevice().then(function (device) {
        if (signal && signal.aborted) throw preparationCancelled();
        var stamp = Date.now();
        var params = playbackQuery(device, stamp);
        var body = JSON.stringify({
          biz_param: { detail_page_version: 0, device_level: 3, disable_digg_stat: false, need_all_video_definition: true, need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024 },
          mixed_video_id_map: { '1004': [String(vid)] }
        });
        var headers = {
          'User-Agent': PLAYBACK_UA,
          Accept: 'application/json; charset=utf-8,application/x-protobuf',
          'Content-Type': 'application/json; charset=UTF-8'
        };
        recordDiagnostic({ stage: 'multi_video_model', code: 'VIDEO_MODEL_REQUEST' });
        return requestBuffer(API_BASE + API_PATH + '?' + sortedQuery(params), 'POST', headers, Buffer.from(body), MAX_JSON, signal);
      }).then(function (response) {
        recordDiagnostic({ stage: 'multi_video_model', http_status: response.status, response_bytes: response.body.length, code: 'VIDEO_MODEL_RESPONSE' });
        if (response.status < 200 || response.status >= 300) {
          throw fail('multi_video_model HTTP ' + response.status, response.status, 'VIDEO_MODEL_HTTP', 'multi_video_model');
        }
        if (!response.body.length) {
          throw fail('multi_video_model 返回空响应', 502, 'VIDEO_MODEL_EMPTY', 'multi_video_model');
        }
        var envelope;
        try { envelope = parseExactJSON(response.body.toString('utf8')); } catch (error) { throw fail('multi_video_model 响应不是有效 JSON', 502, 'VIDEO_MODEL_INVALID_JSON', 'multi_video_model'); }
        var responseCode = modelString(envelope && (envelope.code == null ? envelope.Code : envelope.code));
        if (responseCode && responseCode !== '0') { throw fail('multi_video_model 拒绝了播放请求（' + responseCode + '）', 502, 'VIDEO_MODEL_REJECTED', 'multi_video_model'); }
        var data = envelope && envelope.data;
        var entry = data && data[String(vid)];
        var model = decodeModel(entry && entry.video_model);
        if (!model || typeof model !== 'object') model = decodeModel(data && data.video_model);
        if (!model || typeof model !== 'object') { throw fail('multi_video_model 未返回所选分集的视频数据', 502, 'VIDEO_MODEL_MISSING', 'multi_video_model'); }
        var rows = modelRows(model.video_list);
        var resolvedModel = Promise.resolve(model);
        if (!rows.length) {
          var fallback = fallbackAPI(model.fallback_api);
          if (!fallback) { throw fail('multi_video_model 未返回本集片源地址', 502, 'VIDEO_MODEL_MISSING', 'multi_video_model'); }
          resolvedModel = fallbackModel(fallback, signal, 0).catch(function (error) {
            recordDiagnostic({ stage: 'fallback_api', code: error && error.code || 'FALLBACK_API_ERROR' });
            throw error;
          });
        }
        return resolvedModel.then(function (optionModel) {
          var options = [];
          modelRows(optionModel.video_list).forEach(function (row) {
            var meta = row && row.video_meta || {};
            var encryption = row && row.encrypt_info || {};
            if (String(row && row.codec_type || meta.codec_type || '').toLowerCase() === 'bytevc2') return;
            var backup = row && row.backup_url_list;
            var raw = modelString(row && (row.main_url || row.backup_url || (Array.isArray(backup) && backup[0])));
            var mediaURL = raw;
            if (!/^https?:\/\//i.test(mediaURL)) {
              try { mediaURL = Buffer.from(raw, 'base64').toString(); } catch (ignored) {}
            }
            if (!/^https:\/\//i.test(mediaURL)) return;
            var key = null;
            if (modelString(encryption.spade_a)) {
              try { key = decodeSpade(modelString(encryption.spade_a)); } catch (ignoredKey) { return; }
            }
            var height = number(row && (row.vheight || row.height) || meta.vheight || meta.height);
            var definition = modelString(row && (row.quality_desc || row.definition) || meta.definition).match(/(\d{3,4})/);
            if (definition) height = Number(definition[1]);
            options.push({ url: mediaURL, key: key, height: height, quality: height > 0 ? String(height) + 'P' : '', duration: number(optionModel.video_duration) });
          });
        if (!options.length) { throw fail('multi_video_model 没有可播放清晰度', 502, 'VIDEO_MODEL_NO_QUALITY', 'multi_video_model'); }
        recordDiagnostic(Object.assign({}, diagnostic, { code: 'VIDEO_MODEL_OK', quality_count: options.length,
          qualities: options.map(function (option) { return option.quality; }).filter(Boolean) }));
        return options;
        });
      }).catch(function (error) {
        if (signal && signal.aborted || error && error.name === 'AbortError') throw preparationCancelled();
        var stage = error && error.stage || (error && error.code === 'ACCOUNT_DEVICE' ? 'device_register' : 'multi_video_model_transport');
        recordDiagnostic(Object.assign({}, diagnostic, { stage: stage,
          code: error && error.code === 'ACCOUNT_DEVICE' ? 'DEVICE_REGISTRATION_FAILED' : error && error.code || 'VIDEO_MODEL_NETWORK' }));
        error.stage = stage;
        error.videoModel = Object.assign({}, diagnostic); delete error.videoModel.video_id;
        if (diagnostic.http_status) error.upstreamStatus = diagnostic.http_status;
        if (attempt < maximum && (!retry.allowRetry || retry.allowRetry()) && (error.code === 'VIDEO_MODEL_EMPTY' ||
            maxTransientRetries > transientRetries && transientVideoModelError(error))) {
          var delay = offset + attempt === 1 ? 250 : 1000;
          if (error.code !== 'VIDEO_MODEL_EMPTY') transientRetries++;
          if (typeof retry.onRetry === 'function') retry.onRetry(error, delay, offset + attempt);
          return recoveryDelay(signal, delay).then(function () {
            if (retry.allowRetry && !retry.allowRetry()) throw error;
            return next();
          });
        }
        throw error;
      });
    }
    return next();
  }

  function choose(options, quality, fallback) {
    var requested = String(quality || '').toUpperCase();
    if (requested && requested !== 'AUTO') {
      for (var i = 0; i < options.length; i++) if (options[i].quality === requested) return options[i];
      if (!fallback) throw fail('本集不提供 ' + requested);
    }
    var candidates = options.filter(function (option) { return option.height > 0 && option.height <= 720; });
    if (!candidates.length) candidates = options.slice();
    return candidates.sort(function (a, b) { return a.height - b.height; })[candidates.length - 1];
  }

  function mediaToken(seriesID, vid, quality, fallback, mode) {
    quality = String(quality || '').trim().toUpperCase();
    if (quality === 'AUTO') quality = '';
    var suffix = quality ? ':' + quality + ':' + String(!!fallback) : '';
    var token = crypto.createHash('sha256').update(String(seriesID) + ':' + String(vid) + suffix).digest('hex').slice(0, 24);
    return mode === 'range' ? crypto.createHash('sha256').update(token + ':range').digest('hex').slice(0, 24) : token;
  }
  function ensureCacheRoot() {
    if (cacheRoot) return cacheRoot;
    var candidates = [];
    if (process.env.HONGGUO_WEBOS_CACHE_DIR) candidates.push(process.env.HONGGUO_WEBOS_CACHE_DIR);
    candidates.push('/var/palm/data/com.aston314.hongguo.webos.service/media');
    candidates.push(path.join(process.cwd(), 'media-cache'));
    for (var i = 0; i < candidates.length; i++) {
      try {
        mkdirp(candidates[i], 448);
        var stat = fs.lstatSync(candidates[i]);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        cacheRoot = candidates[i];
        mediaCache = createMediaCache(cacheRoot);
        mediaCache.start();
        return cacheRoot;
      } catch (ignored) {}
    }
    throw fail('webOS 媒体缓存目录不可写');
  }
  function fileExists(file) { try { return fs.statSync(file).isFile(); } catch (ignored) { return false; } }

  function downloadFile(target, destination, token) {
    return rangeMedia.downloadFile(target, destination, { 'User-Agent': APP_UA }, MAX_MEDIA, function (size) { mediaCache.reserve(token, size); });
  }

  function readU32(buffer, offset) { return buffer.readUInt32BE(offset); }
  function readU64(buffer, offset) { var high = buffer.readUInt32BE(offset); var low = buffer.readUInt32BE(offset + 4); return high * 4294967296 + low; }
  function box(buffer, offset, limit) {
    if (offset + 8 > limit) return null;
    var size = readU32(buffer, offset); var header = 8;
    if (size === 1) { if (offset + 16 > limit) return null; size = readU64(buffer, offset + 8); header = 16; }
    if (size === 0) size = limit - offset;
    if (size < header || offset + size > limit) return null;
    return { start: offset, size: size, header: header, type: buffer.toString('ascii', offset + 4, offset + 8), payload: offset + header, end: offset + size };
  }
  function boxes(buffer, start, end) { var out = []; for (var at = start; at < end;) { var item = box(buffer, at, end); if (!item) return null; out.push(item); at += item.size; } return out; }
  function child(buffer, parent, type) { var list = boxes(buffer, parent.payload, parent.end) || []; for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i]; return null; }
  function pathBox(buffer, parent, names) { var current = parent; for (var i = 0; i < names.length; i++) { current = child(buffer, current, names[i]); if (!current) return null; } return current; }
  function allChildren(buffer, parent) { return boxes(buffer, parent.payload, parent.end) || []; }

  function trackSamples(buffer, stbl, senc) {
    var stsc = child(buffer, stbl, 'stsc'), stsz = child(buffer, stbl, 'stsz'), stco = child(buffer, stbl, 'stco') || child(buffer, stbl, 'co64');
    if (!stsc || !stsz || !stco) throw fail('CENC MP4 缺少样本表');
    var p = stco.payload + 4, count = readU32(buffer, p), offsets = [], wide = stco.type === 'co64'; p += 4;
    for (var i = 0; i < count; i++) { offsets.push(wide ? readU64(buffer, p) : readU32(buffer, p)); p += wide ? 8 : 4; }
    p = stsz.payload + 4; var constant = readU32(buffer, p), sizesCount = readU32(buffer, p + 4); p += 8; var sizes = [];
    for (i = 0; i < sizesCount; i++) { sizes.push(constant || readU32(buffer, p)); if (!constant) p += 4; }
    p = stsc.payload + 8; var entryCount = readU32(buffer, stsc.payload + 4), entries = [];
    for (i = 0; i < entryCount; i++) { entries.push({ first: readU32(buffer, p), perChunk: readU32(buffer, p + 4) }); p += 12; }
    var positions = [], sample = 0;
    for (var chunk = 1; chunk <= offsets.length && sample < sizes.length; chunk++) {
      var entry = entries[entries.length - 1];
      for (i = 0; i < entries.length; i++) if (entries[i].first <= chunk) entry = entries[i];
      var at = offsets[chunk - 1];
      for (var n = 0; n < entry.perChunk && sample < sizes.length; n++) { positions.push(at); at += sizes[sample++]; }
    }
    if (sample !== sizes.length) throw fail('CENC MP4 样本数量不一致');
    p = senc.payload; var flags = readU32(buffer, p) & 0xffffff; var sencCount = readU32(buffer, p + 4); p += 8;
    if (sencCount !== sizes.length) throw fail('CENC MP4 IV 数量不一致');
    var ivSize = (senc.end - p === sencCount * 16) ? 16 : 8; var ivs = [];
    for (i = 0; i < sencCount; i++) { ivs.push(buffer.slice(p, p + ivSize)); p += ivSize; if (flags & 2) throw fail('暂不支持带 subsample 的 CENC MP4'); }
    return sizes.map(function (size, index) { return { offset: positions[index], size: size, iv: ivs[index] }; });
  }

  function zeroProtection(buffer, entry) {
    var header = entry.type === 'encv' ? 78 : 28;
    var list = boxes(buffer, entry.payload + header, entry.end) || [];
    list.forEach(function (item) { if (item.type === 'sinf') { buffer.write('free', item.start + 4, 4, 'ascii'); buffer.fill(0, item.payload, item.end); } });
  }
  function originalFormat(buffer, entry) {
    var list = boxes(buffer, entry.payload + 78, entry.end) || [];
    var sinf = list.filter(function (x) { return x.type === 'sinf'; })[0];
    if (!sinf) return 'hvc1';
    var frma = child(buffer, sinf, 'frma');
    return frma && frma.payload + 4 <= frma.end ? buffer.toString('ascii', frma.payload, frma.payload + 4) : 'hvc1';
  }
  function decryptMP4(file, key) {
    var buffer = fs.readFileSync(file);
    var root = boxes(buffer, 0, buffer.length) || [];
    var moov = root.filter(function (x) { return x.type === 'moov'; })[0];
    if (!moov) throw fail('MP4 缺少 moov');
    var tracks = allChildren(buffer, moov); var decrypted = 0;
    tracks.forEach(function (trak) {
      if (trak.type !== 'trak') return;
      var stbl = pathBox(buffer, trak, ['mdia', 'minf', 'stbl']); if (!stbl) return;
      var senc = child(buffer, stbl, 'senc'); if (!senc) return;
      var samples = trackSamples(buffer, stbl, senc);
      var stsd = child(buffer, stbl, 'stsd');
      samples.forEach(function (sample) {
        if (sample.offset < 0 || sample.offset + sample.size > buffer.length) throw fail('MP4 样本越界');
        var iv = Buffer.alloc(16); sample.iv.copy(iv, 0);
        var decipher = crypto.createDecipheriv('aes-128-ctr', key, iv); decipher.setAutoPadding(false);
        var plain = Buffer.concat([decipher.update(buffer.slice(sample.offset, sample.offset + sample.size)), decipher.final()]);
        plain.copy(buffer, sample.offset);
      });
      if (stsd) {
        var entries = allChildren(buffer, { payload: stsd.payload + 8, end: stsd.end });
        entries.forEach(function (entry) {
          if (entry.type === 'encv') { buffer.write(originalFormat(buffer, entry), entry.start + 4, 4, 'ascii'); zeroProtection(buffer, entry); }
          if (entry.type === 'enca') { buffer.write('mp4a', entry.start + 4, 4, 'ascii'); zeroProtection(buffer, entry); }
        });
      }
      decrypted++;
    });
    if (!decrypted) throw fail('MP4 没有可解密的 senc 轨道');
    fs.writeFileSync(file, buffer, { mode: 384 });
  }

  function rememberPreparation(token, report) {
    delete preparationReports[token];
    preparationReports[token] = report;
    var keys = Object.keys(preparationReports);
    while (keys.length > 16) delete preparationReports[keys.shift()];
  }

  function measurePreparation(report, stage, field, action) {
    var start = Date.now();
    report.media_preparation_stage = stage;
    return Promise.resolve().then(action).then(function (value) {
      report[field] = Math.max(0, Date.now() - start);
      return value;
    }, function (error) {
      report[field] = Math.max(0, Date.now() - start);
      if (error && error.name !== 'AbortError') {
        report.media_preparation_error_code = String(error.code || 'PROVIDER_ERROR');
        report.media_preparation_error_stage = String(error.stage || stage);
      }
      throw error;
    });
  }

  function prepare(seriesID, vid, quality, fallback, mode, prefetch, signal) {
    if (signal && signal.aborted) return Promise.reject(preparationCancelled());
    if (!validID(seriesID) || !validID(vid)) return Promise.reject(fail('播放参数无效'));
    quality = String(quality || '').trim().toUpperCase();
    if (quality === 'AUTO') quality = '';
    var wantsRange = String(mode || '') === 'range';
    var fullToken = mediaToken(seriesID, vid, quality, fallback, 'full');
    var token = wantsRange ? mediaToken(seriesID, vid, quality, fallback, 'range') : fullToken;
    var jobKey = token;
    var root = ensureCacheRoot(); var dir = path.join(root, token); var file = path.join(dir, token + '.mp4');
    mediaCache.prune(false);
    function resultWithReport(result, report, shared, cached) {
      // In-flight reports were selected when the request began. A late result
      // from an older drama must not replace a newer foreground diagnostic.
      if (!prefetch && cached) lastForegroundPreparation = report;
      var value = Object.assign({}, result, { preparation_timing: Object.assign({}, report), preparation_shared: !!shared, preparation_cached: !!cached });
      var source = wantsRange && rangeSources[token];
      if (!prefetch || !source || typeof rangeMedia.prefetchHead !== 'function') return value;
      return rangeMedia.prefetchHead(source, signal).then(function () {
        Object.assign(value.preparation_timing, rangeMedia.headDiagnostics(source));
        return value;
      }, function (error) {
        if (signal && signal.aborted) throw preparationCancelled();
        // Source metadata remains usable when speculative bytes fail. Only
        // foreground playback decides whether a complete-file fallback is needed.
        value.preparation_timing.media_head_prefetch_failed = true;
        return value;
      });
    }
    function useJob(record, shared) {
      record.users++;
      if (!prefetch) { record.foreground = true; record.foregroundUsers++; lastForegroundPreparation = record.report; }
      return new Promise(function (resolve, reject) {
        var done = false;
        function leave() {
          if (done) return false; done = true;
          if (signal) signal.removeEventListener('abort', aborted);
          if (--record.users === 0 && !record.settled) record.resolveCancel.abort('PLAYBACK_PREPARATION_CANCELLED');
          if (!prefetch && --record.foregroundUsers === 0 && !record.settled && record.recoveryCancel) {
            record.recoveryCancel.abort('PLAYBACK_PREPARATION_CANCELLED');
          }
          return true;
        }
        function aborted() { if (leave()) reject(preparationCancelled()); }
        function ready(result) {
          if (!leave()) return;
          record.report.media_preparation_stage = 'ready';
          delete record.report.media_preparation_error_code;
          delete record.report.media_preparation_error_stage;
          resolve(resultWithReport(result, record.report, shared, false));
        }
        function failed(error) {
          if (!leave()) return;
          if (!prefetch || !record.foreground) {
            record.report.media_preparation_error_stage = error.stage || record.report.media_preparation_stage;
            record.report.media_preparation_error_code = String(error.code || 'PROVIDER_ERROR');
            record.report.media_preparation_stage = 'failed';
          }
          reject(error);
        }
        if (signal) { signal.addEventListener('abort', aborted); if (signal.aborted) { aborted(); return; } }
        record.promise.then(ready, function (error) {
          if (done) return;
          // Only an active foreground caller may start the existing full-file
          // fallback. Cancellation must not turn speculative work into a download.
          if (!wantsRange || prefetch || !record.fullFallback || error.name === 'AbortError') { failed(error); return; }
          Promise.resolve().then(function () {
            if (done) throw preparationCancelled();
            return record.fullFallback(error);
          }).then(ready, failed);
        });
      });
    }
    if (rangeSources[token] && wantsRange && Date.now() - rangeSources[token].preparedAt < RANGE_PREPARATION_TTL) {
      rangeSources[token].lastUsedAt = Date.now();
      mediaCache.touch(token, true);
      return Promise.resolve(resultWithReport({ path: '/minireel-proxy/media/' + token + '.mp4', quality: rangeSources[token].quality || quality || '', qualities: [], vid: vid, mode: 'range' }, rangeSources[token].preparationTiming, false, true));
    }
    if (jobs[jobKey] && !jobs[jobKey].resolveCancel.signal.aborted) return useJob(jobs[jobKey], true);
    if (!wantsRange && fileExists(file)) {
      mediaCache.touch(token, true);
      return Promise.resolve(resultWithReport({ path: '/minireel-proxy/media/' + token + '.mp4', quality: quality || '', qualities: [], vid: vid, mode: 'full' }, preparationReports[token] || { media_mode: 'full', media_preparation_stage: 'ready' }, false, true));
    }
    var record = { users: 0, foregroundUsers: 0, speculative: !!prefetch, settled: false, resolveCancel: audioCancel.create(),
      report: { media_mode: wantsRange ? 'range' : 'full', media_preparation_stage: 'resolve' } };
    rememberPreparation(token, record.report);
    var resolveStartedAt = Date.now();
    function diagnostic(value) { record.report.media_video_model = value; }
    function retried(error, delay, count) {
      record.report.media_resolve_retries = count;
      record.report.media_resolve_retry_reason = error && error.code || 'VIDEO_MODEL_TRANSIENT';
      record.report.media_resolve_retry_delay_ms = delay;
    }
    function foregroundWaiting() { return record.foregroundUsers > 0; }
    var job = measurePreparation(record.report, 'resolve', 'media_resolve_ms', function () {
      return videoOptions(vid, record.resolveCancel.signal, {
        maxAttempts: prefetch ? 1 : 3,
        maxTransientRetries: prefetch ? 0 : 2,
        startedAt: resolveStartedAt, onRetry: retried, onDiagnostic: diagnostic, allowRetry: foregroundWaiting
      }).catch(function (error) {
        if (!record.speculative || !record.foregroundUsers || !transientVideoModelError(error)) throw error;
        record.recoveryCancel = record.resolveCancel;
        // Keep this same job registered during backoff and recovery, so all
        // foreground callers share the remaining budget. No page retry loop.
        retried(error, 250, 1);
        return recoveryDelay(record.recoveryCancel.signal).then(function () {
          if (!record.foregroundUsers || record.recoveryCancel.signal.aborted) throw preparationCancelled();
          return videoOptions(vid, record.recoveryCancel.signal, {
            maxAttempts: error.code === 'VIDEO_MODEL_EMPTY' ? 2 : 1, attemptOffset: 1,
            startedAt: resolveStartedAt, onRetry: retried, onDiagnostic: diagnostic, allowRetry: foregroundWaiting
          });
        });
      }).catch(function (error) {
        // The provider owns the preparation retry budget. Do not restart it
        // again in the page after it has already been consumed here.
        if (error.videoModel) error.recoveryComplete = true;
        throw error;
      });
    }).then(function (options) {
      if (record.resolveCancel.signal.aborted) throw preparationCancelled();
      var selected = choose(options, quality, fallback);
      var qualities = options.map(function (x) { return x.quality; }).filter(Boolean);
      function prepareFull(rangeError) {
        record.report.media_mode = 'full';
        rememberPreparation(fullToken, record.report);
        if (rangeError) record.report.media_range_fallback = String(rangeError.message || '按需读取不可用，已使用整集播放模式').replace(/https?:\/\/\S+/gi, '[redacted]').slice(0, 180);
        var fullDir = path.join(root, fullToken);
        var fullFile = path.join(fullDir, fullToken + '.mp4');
        function withFallback(result) {
          var output = Object.assign({}, result);
          if (rangeError) output.range_fallback = record.report.media_range_fallback;
          return output;
        }
        if (fileExists(fullFile)) {
          mediaCache.touch(fullToken, true);
          return Promise.resolve(withFallback({ path: '/minireel-proxy/media/' + fullToken + '.mp4', quality: selected.quality, qualities: qualities, vid: vid, mode: 'full' }));
        }
        if (fullDownloads[fullToken]) return fullDownloads[fullToken].then(withFallback);
        var releaseDownload = mediaCache.protect(fullToken);
        var temp = fullFile + '.part';
        var download = measurePreparation(record.report, 'download', 'media_download_ms', function () {
          mediaCache.reserve(fullToken, 1);
          mkdirp(fullDir, 448);
          return downloadFile(selected.url, temp, fullToken);
        }).then(function () {
          return measurePreparation(record.report, 'decrypt', 'media_decrypt_ms', function () { if (selected.key) decryptMP4(temp, selected.key); });
        }).then(function () {
          fs.renameSync(temp, fullFile);
          mediaCache.touch(fullToken, true);
          return { path: '/minireel-proxy/media/' + fullToken + '.mp4', quality: selected.quality, qualities: qualities, vid: vid, mode: 'full' };
        }).catch(function (error) {
          try { fs.unlinkSync(temp); } catch (ignored) {}
          try { fs.rmdirSync(fullDir); } catch (ignoredDir) {}
          if (error && (error.code === 'ENOSPC' || error.code === 'EDQUOT')) throw mediaCache.fullError();
          throw error;
        });
        var sharedDownload = download.then(function (result) {
          if (fullDownloads[fullToken] === sharedDownload) delete fullDownloads[fullToken];
          mediaCache.finishDownload(fullToken); releaseDownload(); mediaCache.prune(true);
          return result;
        }, function (error) {
          if (fullDownloads[fullToken] === sharedDownload) delete fullDownloads[fullToken];
          mediaCache.finishDownload(fullToken); releaseDownload(); mediaCache.prune(true);
          throw error;
        });
        fullDownloads[fullToken] = sharedDownload;
        return sharedDownload.then(withFallback);
      }
      if (!wantsRange) return prepareFull(null);
      record.fullFallback = prepareFull;
      return measurePreparation(record.report, 'range_init', 'media_range_init_ms', function () {
        if (!selected.key) throw fail('当前视频没有 CENC key');
        return rangeMedia.open(selected.url, selected.key, { vid: vid, quality: selected.quality });
      }).then(function (source) {
        source.quality = selected.quality;
        source.refresh = function () {
          return videoOptions(vid).then(function (freshOptions) {
            var fresh = choose(freshOptions, selected.quality, false);
            return { url: fresh.url, key: fresh.key };
          });
        };
        source.lastUsedAt = Date.now();
        source.preparedAt = Date.now();
        source.preparationTiming = record.report;
        trimRangeSources(token, source);
        rangeSources[token] = source;
        mediaCache.touch(token, true);
        return { path: '/minireel-proxy/media/' + token + '.mp4', quality: selected.quality, qualities: qualities, vid: vid, mode: 'range' };
      });
    }).then(function (result) {
      record.settled = true;
      if (jobs[jobKey] === record) delete jobs[jobKey];
      return result;
    }, function (error) {
      record.settled = true;
      if (jobs[jobKey] === record) delete jobs[jobKey];
      throw error;
    });
    record.promise = job;
    jobs[jobKey] = record;
    return useJob(record, false);
  }

  function prepareAudio(mediaPath, signal) {
    if (signal && signal.aborted) return Promise.reject(audioCancel.error(signal));
    var match = /^\/minireel-proxy\/media\/([a-f0-9]{24})\.mp4$/.exec(String(mediaPath || ''));
    if (!match) return Promise.reject(fail('音频请求不是当前本机媒体', 400, 'WEBOS_AUDIO_SOURCE'));
    var token = match[1], now = Date.now();
    audioCache = audioCache.filter(function (entry) { return now - entry.at < 120000; });
    var cached = audioCache.filter(function (entry) { return entry.token === token; })[0];
    if (cached) { cached.at = now; return Promise.resolve(cached.value); }
    function join(record) {
      record.users++;
      return new Promise(function (resolve, reject) {
        var finished = false;
        function leave() {
          if (finished) return false; finished = true;
          if (signal) signal.removeEventListener('abort', aborted);
          record.users--;
          if (!record.done && !record.users) record.cancel.abort();
          return true;
        }
        function aborted() { if (leave()) reject(audioCancel.error(signal)); }
        if (signal) { signal.addEventListener('abort', aborted); if (signal.aborted) aborted(); }
        record.promise.then(function (value) { if (leave()) resolve(value); }, function (error) { if (leave()) reject(error); });
      });
    }
    if (audioJobs[token] && !audioJobs[token].cancel.signal.aborted) return join(audioJobs[token]);
    if (Object.keys(audioJobs).length >= 2) return Promise.reject(fail('音频准备繁忙，请稍后重试', 503, 'WEBOS_AUDIO_BUSY'));
    var root = ensureCacheRoot(), source = rangeSources[token], file = path.join(root, token, token + '.mp4');
    if (!source && !fileExists(file)) return Promise.reject(fail('当前播放源尚未准备好', 404, 'WEBOS_AUDIO_NOT_READY'));
    var release = mediaCache.protect(token);
    var record = { users: 0, done: false, cancel: audioCancel.create() };
    var deadline = setTimeout(function () { record.cancel.abort('WEBOS_AUDIO_TIMEOUT'); }, 18000);
    function finish() { record.done = true; clearTimeout(deadline); if (audioJobs[token] === record) delete audioJobs[token]; release(); }
    record.promise = Promise.resolve().then(function () {
      audioCancel.check(record.cancel.signal);
      return source ? audioMedia.buildBatched(source.prefix, source.length, function (spans, currentSignal) { return audioRange.read(source, spans, currentSignal); }, record.cancel.signal) : audioMedia.fromFile(file, record.cancel.signal);
    }).then(function (value) {
      audioCancel.check(record.cancel.signal);
      audioCache.push({ token: token, at: Date.now(), value: value });
      audioCache.sort(function (a, b) { return a.at - b.at; });
      while (audioCache.length > 2 || audioCache.reduce(function (n, entry) { return n + entry.value.body.length; }, 0) > 16 * 1024 * 1024) audioCache.shift();
      return value;
    }).then(function (value) { finish(); return value; }, function (error) { record.cancel.abort(); finish(); throw error; });
    audioJobs[token] = record; return join(record);
  }

  function parseMediaByteRange(value, length) {
    if (value == null) return { start: 0, end: length - 1, partial: false };
    if (length <= 0) return null;
    var match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim());
    if (!match || match[1] === '' && match[2] === '') return null;
    function safeInteger(raw) {
      if (!/^\d+$/.test(raw)) return null;
      var parsed = Number(raw);
      return isFinite(parsed) && Math.floor(parsed) === parsed && parsed <= 9007199254740991 ? parsed : null;
    }
    if (match[1] === '') {
      var suffix = safeInteger(match[2]);
      if (suffix == null || suffix <= 0) return null;
      suffix = Math.min(suffix, length);
      return { start: length - suffix, end: length - 1, partial: true };
    }
    var start = safeInteger(match[1]);
    if (start == null || start >= length) return null;
    var end = match[2] === '' ? length - 1 : safeInteger(match[2]);
    if (end == null || end < start) return null;
    return { start: start, end: Math.min(end, length - 1), partial: true };
  }

  function ifRangeMatches(value, etag, modifiedAt) {
    if (!value) return true;
    if (String(value).trim() === etag) return true;
    var date = Date.parse(value);
    return isFinite(date) && Math.floor(modifiedAt / 1000) <= Math.floor(date / 1000);
  }

  function serveMedia(req, res, token) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return jsonResponse(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    }
    if (!/^[a-f0-9]{24}$/.test(token)) return jsonResponse(res, 400, { ok: false, error: '媒体标识无效' });
    ensureCacheRoot();
    mediaCache.touch(token);
    var releaseRead = mediaCache.protect(token);
    res.once('close', releaseRead);
    res.once('finish', releaseRead);
    if (rangeSources[token]) {
      rangeSources[token].lastUsedAt = Date.now();
      return rangeMedia.serve(req, res, rangeSources[token], function (status) {
        mediaStatus[token] = { status: status, at: Date.now(), mode: 'range' };
      });
    }
    var file = path.join(ensureCacheRoot(), token, token + '.mp4');
    var stat;
    try { stat = fs.statSync(file); } catch (error) { mediaStatus[token] = { status: 404, at: Date.now() }; return jsonResponse(res, 404, { ok: false, error: '媒体尚未准备好' }); }
    if (!stat.isFile() || stat.size <= 0) { mediaStatus[token] = { status: 404, at: Date.now() }; return jsonResponse(res, 404, { ok: false, error: '媒体缓存无效' }); }
    var range = parseMediaByteRange(req.headers.range, stat.size);
    if (!range) {
      mediaStatus[token] = { status: 416, at: Date.now() };
      res.statusCode = 416;
      res.setHeader('Content-Range', 'bytes */' + stat.size);
      return res.end();
    }
    var modifiedAt = stat.mtime.getTime();
    var etag = '"' + stat.size + '-' + modifiedAt + '"';
    if (range.partial && req.headers['if-range'] && !ifRangeMatches(req.headers['if-range'], etag, modifiedAt)) {
      range = { start: 0, end: stat.size - 1, partial: false };
    }
    var start = range.start;
    var end = range.end;
    res.statusCode = range.partial ? 206 : 200;
    mediaStatus[token] = { status: res.statusCode, at: Date.now() };
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-Range');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    if (range.partial) res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
    if (req.method === 'HEAD') return res.end();
    var stream = fs.createReadStream(file, { start: start, end: end });
    res.once('close', function () { stream.destroy(); });
    stream.on('error', function (error) {
      mediaStatus[token] = { status: 500, at: Date.now() };
      if (res.headersSent) { if (typeof res.destroy === 'function') res.destroy(error); return; }
      jsonResponse(res, 500, { ok: false, error: '媒体缓存读取失败' });
    });
    stream.pipe(res);
  }

  function jsonResponse(res, status, payload) { var body = JSON.stringify(payload); res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS'); res.end(body); }
  function fetchHTML(target) { return requestBuffer(target, 'GET', { 'User-Agent': 'Googlebot', Accept: 'text/html' }, null, 12 * 1024 * 1024).then(function (response) { if (response.status < 200 || response.status >= 300) throw fail('官网 HTTP ' + response.status); return response.body.toString('utf8'); }); }
  function routerData(html) { var marker = html.indexOf('_ROUTER_DATA'); if (marker < 0) throw fail('页面缺少 _ROUTER_DATA'); var start = html.indexOf('{', marker); if (start < 0) throw fail('页面数据起点无效'); var depth = 0, string = false, escaped = false, end = start; for (; end < html.length; end++) { var c = html.charAt(end); if (string) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') string = false; continue; } if (c === '"') string = true; else if (c === '{' || c === '[') depth++; else if (c === '}' || c === ']') { depth--; if (!depth) break; } } try { return parseExactJSON(html.slice(start, end + 1)); } catch (error) { throw fail('页面数据解析失败'); } }
  function findObject(value, key) { if (!value || typeof value !== 'object') return null; if (!Array.isArray(value) && value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) return value[key]; var keys = Object.keys(value); for (var i = 0; i < keys.length; i++) { var found = findObject(value[keys[i]], key); if (found) return found; } return null; }
  function findArray(value, key) { if (!value || typeof value !== 'object') return null; if (!Array.isArray(value) && Array.isArray(value[key])) return value[key]; var keys = Object.keys(value); for (var i = 0; i < keys.length; i++) { var found = findArray(value[keys[i]], key); if (found) return found; } return null; }
  // Match the Go core's HEIC alternative without changing the signed original.
  function browserCoverFallback(cover) {
    var parsed;
    try { parsed = url.parse(cover); } catch (ignored) { return ''; }
    var pathname = parsed.pathname || '';
    var hostname = String(parsed.hostname || '').toLowerCase();
    if (!/\.heic$/i.test(pathname) || !/\.(?:fqnovelpic|byteimg)\.com$/.test(hostname) ||
        pathname.indexOf('/novel-pic/') !== 0 || pathname.indexOf('~') < 0) return '';
    return 'https://p3-novel.byteimg.com' + pathname.split('~')[0] + '~tplv-shrink:640:0.image';
  }
  function normalize(value) {
    if (!value || typeof value !== 'object') return null;
    var object = value.video_data && typeof value.video_data === 'object' ? value.video_data : value;
    var id = first(object.series_id_str, object.series_id, object.seriesId, object.book_id, object.id);
    if (!id) return null;
    var vids = stringArray(object.vid_list); if (!vids.length) vids = stringArray(object.episodeVids);
    var episodeCount = number(first(object.episode_cnt, object.episode_total_cnt)) || vids.length;
    var item = { series_id: id, title: first(object.series_title, object.series_name, object.title, '未命名短剧'), cover: first(object.series_cover, object.cover, object.cover_url), intro: first(object.series_intro, object.video_desc, object.description), score: first(object.score, object.rating, object.scoreText).replace(/^评分/, ''), play_count: number(object.play_cnt), episode_count: episodeCount, accessible_episode_cnt: number(object.accessible_episode_cnt) || episodeCount, vid: first(object.vid, object.video_id, vids[0]), vid_list: vids, tags: stringArray(object.tags), rank: number(object.rank), heat: first(object.heatText), season_index: number(object.season_index), is_multi_season: bool(object.is_multi_season), followed: bool(object.followed) || bool(object.is_subscribed), following_update: bool(object.following_update), follow_count: number(object.follow_count), series_status: first(object.series_status, object.status) };
    var fallback = browserCoverFallback(item.cover);
    if (fallback) item.cover_fallback = fallback;
    return item;
  }
  function normalizeRows(rows) { var seen = {}; return (rows || []).map(normalize).filter(function (item) { if (!item || seen[item.series_id]) return false; seen[item.series_id] = true; return true; }); }
  function normalizeSeriesActors(value) {
    var actors = [], seen = {};
    function append(raw) {
      if (!raw || typeof raw !== 'object') return;
      var person = raw;
      if (person.user_info && typeof person.user_info === 'object') person = person.user_info;
      if (person.base_info && typeof person.base_info === 'object') person = person.base_info;
      var id = first(person.celebrity_id, person.actor_id, person.actor_id_str, person.person_id);
      var name = first(person.nickname, person.user_name, person.celebrity_name, person.actor_name, person.name);
      if (!name) return;
      var key = id || name;
      if (seen[key]) return;
      seen[key] = true;
      actors.push({ id: id, name: name, avatar: first(person.user_avatar, person.avatar, person.avatar_url, person.cover_url) });
    }
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      ['celebrities', 'celebrity_list', 'actors', 'actor_list'].forEach(function (key) {
        if (Array.isArray(node[key])) node[key].forEach(append);
      });
      Object.keys(node).forEach(function (key) {
        if (['celebrities', 'celebrity_list', 'actors', 'actor_list'].indexOf(key) < 0) walk(node[key]);
      });
    }
    walk(value);
    return actors;
  }
  function arraysByKeys(value, names, output) {
    if (!value || typeof value !== 'object') return output;
    if (Array.isArray(value)) { value.forEach(function (item) { arraysByKeys(item, names, output); }); return output; }
    Object.keys(value).forEach(function (key) {
      var child = value[key];
      if (names.indexOf(key) >= 0 && Array.isArray(child)) output.push.apply(output, child);
      else if (child && typeof child === 'object') arraysByKeys(child, names, output);
    });
    return output;
  }
  function normalizeSeriesReviews(value) {
    return arraysByKeys(value, ['reviews', 'review_list'], []).map(function (raw) {
      var review = raw && raw.review && typeof raw.review === 'object' ? raw.review : raw || {};
      var common = review.common || {}, content = common.content || {};
      var text = first(review.content, review.text, content.text);
      if (!text) return null;
      return { id: first(review.review_id, review.comment_id, review.id), user_name: first(review.user_name, review.username, review.name), avatar: first(review.avatar, review.user_avatar), content: text, rating: number(review.rating), digg_count: number(review.digg_count) || number(review.like_count), reply_count: number(review.reply_count), create_time: number(review.create_time) || number(review.create_timestamp) };
    }).filter(Boolean);
  }
  function normalizeRelatedDramas(value, currentID) {
    var seen = {};
    return arraysByKeys(value, ['related_list', 'videoList', 'related', 'detail_page_more_related', 'related_video', 'rawRelatedVideo'], []).map(function (raw) {
      if (raw && raw.model && typeof raw.model === 'object') raw = raw.model;
      return normalize(raw);
    }).filter(function (item) {
      if (!item || item.series_id === currentID || seen[item.series_id]) return false;
      seen[item.series_id] = true;
      return true;
    });
  }

  var categoryFilterNames = {
    genre: '体裁', category_dim_theme: '主题', category_dim_role: '设定',
    category_dim_epoch: '背景', sort: '推荐', gender: '受众',
    online_time: '时间', creation_status: '状态'
  };
  function validCategoryFilter(type, value) {
    if (!Object.prototype.hasOwnProperty.call(categoryFilterNames, type)) return false;
    if (!value) return true;
    if (type === 'genre') return ['short_play', 'comic_series', 'ai_series'].indexOf(value) >= 0;
    if (type === 'category_dim_theme' || type === 'category_dim_role' || type === 'category_dim_epoch') return /^cate_[0-9]{1,8}$/.test(value);
    if (type === 'sort') return ['hot_score', 'online_time', 'hot_collect'].indexOf(value) >= 0;
    if (type === 'gender') return value === '0' || value === '1';
    if (type === 'online_time') return ['days_7', 'days_14', 'days_30', 'days_90'].indexOf(value) >= 0;
    if (type === 'creation_status') return value === 'creation_status_0' || value === 'creation_status_1';
    return false;
  }
  function normalizeCategoryFilters(raw) {
    var result = [], statusIndex = -1;
    (Array.isArray(raw) ? raw : []).forEach(function (row) {
      if (!row || !Object.prototype.hasOwnProperty.call(categoryFilterNames, row.type)) return;
      var options = [], seen = Object.create(null);
      (Array.isArray(row.items) ? row.items : []).forEach(function (item) {
        var id = first(item && item.selector_item_id), label = first(item && item.show_name);
        if (!id || !label || seen[id] || !validCategoryFilter(row.type, id)) return;
        seen[id] = true; options.push({ id: id, label: label });
      });
      if (!options.length) return;
      if (row.type === 'creation_status') statusIndex = result.length;
      result.push({ type: row.type, label: categoryFilterNames[row.type], options: options });
    });
    var status = { type: 'creation_status', label: categoryFilterNames.creation_status, options: [
      { id: 'creation_status_0', label: '已完结' }, { id: 'creation_status_1', label: '连载中' }
    ] };
    if (statusIndex < 0) {
      statusIndex = result.findIndex ? result.findIndex(function (row) { return row.type === 'online_time'; }) : -1;
      if (statusIndex < 0) statusIndex = result.length;
      result.splice(statusIndex, 0, status);
    } else {
      result[statusIndex] = status;
    }
    return result;
  }

  function category(pathName, offset, filters, selectors) {
    filters = filters || {};
    var scene = pathName === '/category/comic' ? 'comic' : pathName.indexOf('comic') >= 0 ? 'comic_series' : pathName.indexOf('ai') >= 0 ? 'ai_series' : 'default';
    var defaultGenre = scene === 'comic_series' ? 'comic_series' : scene === 'ai_series' ? 'ai_series' : scene === 'comic' ? 'comic' : 'short_play';
    var selection = { genre: [defaultGenre], sort: [pathName.indexOf('/new/') === 0 ? 'online_time' : 'hot_score'], category_dim_theme: [], category_dim_role: [], category_dim_epoch: [], gender: [], online_time: [], creation_status: [] };
    Object.keys(categoryFilterNames).forEach(function (key) {
      if (filters[key] === undefined) return;
      var value = trim(filters[key]);
      if (!validCategoryFilter(key, value)) throw fail('分类筛选参数无效: ' + key);
      selection[key] = value ? [value] : [];
    });
    var pageOffset = Number(offset) || 0;
    // Category is an app API endpoint, so it needs the same one-shot device
    // identity and Passport envelope as the other catalogue calls. An
    // unsigned POST may return an empty body even though the endpoint exists.
    var body = { filter_ids: first(filters.shown), req_scene: scene, offset: pageOffset, need_selector_panel: !!selectors, limit: 15, select_items: selection, session_id: first(filters.session_id), req_type: selectors ? 'default' : 'only_content', client_req_type: 3 };
    return signedJSON('/reading/distribution/category/landpage/v/', 'POST', {}, body).then(function (payload) {
      var data = payload && payload.data || {};
      var items = normalizeRows(data.video_data);
      var hasMore = bool(data.has_more);
      var nextOffset = number(data.next_offset);
      if (!nextOffset && hasMore) nextOffset = pageOffset + items.length;
      return { items: items, has_more: hasMore, next_offset: nextOffset, session_id: first(data.session_id), filters: selectors ? normalizeCategoryFilters(data.selector_rows) : undefined, source: 'webos-category' };
    });
  }
  function rankOptions(selector) {
    var outer = selector && selector.outer_row || {};
    return (outer.items || []).map(function (row) {
      var item = { id: first(row.selector_item_id), label: first(row.show_name), selected: !!row.is_selected, children: rankOptions(row.sub_cell_selector), panels: [] };
      var panelRows = row.panel_selector && row.panel_selector.inner_rows || [];
      item.panels = panelRows.map(function (panel) { return { type: first(panel.type), label: first(panel.row_name), options: (panel.items || []).map(function (option) { return { id: first(option.selector_item_id), label: first(option.show_name) }; }).filter(function (option) { return option.label; }) }; });
      return item;
    }).filter(function (item) { return item.label; });
  }
  function rank(query) {
    query = query || {};
    var offset = Number(query.offset) || 0;
    var params = { tab_type: offset > 0 ? '18' : '26', client_req_type: '2', client_template: '2', background_selected_items: '', category_id: '0', limit: '20', cell_sub_id: '0', gender: '2', cell_id: '7470092475068071998', selected_items: query.rank || '', sub_selected_items: query.rank_sub || '', panel_selected_items: query.rank_panel || '', offset: String(offset), session_id: query.session_id || '', filter_ids: query.shown || '', unlimited_selector_change_type: '0' };
    return signedJSON('/reading/bookapi/bookmall/cell/change/v', 'GET', params, null).then(function (payload) {
      var data = payload && payload.data || {}; var view = data.cell_view || {}; var items = [];
      (view.cell_data || []).forEach(function (cell) {
        var videos = cell && cell.video_data;
        if (videos && !Array.isArray(videos)) videos = [videos];
        (videos || []).forEach(function (video) { var item = normalize(video); if (item) items.push(item); });
        (cell && cell.ugc_user_data || []).forEach(function (actor) {
          var user = actor.user_info || {}; var base = user.base_info || {}; var id = first(base.actor_id_str, base.actor_id);
          if (!validID(id)) return;
          var rec = actor.rec_text_item || {};
          items.push({ series_id: 'actor-' + id, actor_id: id, title: first(base.user_name), cover: first(base.user_avatar), intro: first(actor.intro), heat: first(rec.RecommendText), tags: stringArray(actor.sub_title_list) });
        });
      });
      var hasMore = payload && data.next_offset != null ? bool(data.has_more) : bool(view.has_more);
      var nextOffset = data.next_offset == null ? number(view.next_offset) : number(data.next_offset);
      var sessionID = first(data.session_id, view.session_id);
      if (nextOffset <= offset) hasMore = false;
      return { items: items, has_more: hasMore, next_offset: nextOffset, session_id: sessionID, ranks: rankOptions(view.cell_selector), source: 'webos-rank-api' };
    });
  }

  function newSeries(query) {
    query = query || {};
    var offset = Number(query.offset) || 0;
    var params = { change_type: '1', selected_items: 'firstonlinetime_new', client_req_type: '1', cell_id: '7431550523368554558', limit: '20', offset: String(offset), cell_gender: query.gender || '2', session_id: query.session_id || '' };
    return signedJSON('/reading/bookapi/bookmall/cell/change/v1/', 'GET', params, null).then(function (payload) {
      var data = payload && payload.data || {}; var view = data.cell_view || {};
      var items = normalizeRows(view.video_data || []);
      return { items: items, has_more: bool(data.has_more), next_offset: number(data.next_offset), session_id: first(data.session_id), source: 'webos-new-api' };
    });
  }

  function feedRows(cells) {
    var items = [], seen = {};
    function append(raw, disabled) {
      var value = raw && raw.video_detail || raw;
      var item = normalize(value);
      if (!item || disabled || !validID(item.series_id) || !item.episode_count || seen[item.series_id]) return;
      item.vid = first(raw && raw.first_vid, item.vid);
      if (!validID(item.vid)) return;
      seen[item.series_id] = true; items.push(item);
    }
    function walk(rows) {
      (rows || []).forEach(function (cell) {
        if (!cell) return;
        if (cell.video_detail) append(cell.video_detail, cell.disable_play);
        (cell.video_data || []).forEach(function (video) { if (!video || !video.video_detail) return; append(video.video_detail, video.disable_play); });
        walk(cell.cell_data);
      });
    }
    walk(cells); return items;
  }

  function recommend(query) {
    query = query || {};
    var tab = first(query.channel, '16');
    if (['16', '36', '39', '45'].indexOf(tab) < 0) return Promise.reject(fail('推荐频道无效'));
    var cell = first(query.feed_cell), plan = first(query.feed_plan);
    if (tab === '16') { cell = '7294257141911650341'; plan = '7294257258253254693'; }
    if (!cell || !plan) {
      var init = { bottom_tab_type: '7', landing_bottom_tab_type: '7', need_personal_recommend: '1', device_level: '3', screen_width_px: '1078', is_horizontal_screen: 'false', disable_digg_stat: 'false', auth_aweme: 'true', auth_backward: 'true', has_video_cache: 'false', last_tab_type: '0', last_tab_index: '0', tab_index: '0', req_rank_category_id: '0', video_type_preferences_str: '[]', tab_type: tab, offset: '0', session_id: '', client_req_type: '1' };
      return signedJSON('/reading/bookapi/bookmall/tab/v', 'GET', init, null).then(function (payload) {
        var data = payload && payload.data || {}; var tabs = data.tab_item || [];
        var selected = tabs.filter(function (item) { return String(item.tab_type) === tab; })[0];
        if (!selected) throw fail('推荐响应没有对应频道');
        var cells = selected.cell_data || [];
        var foundCell = '';
        cells.some(function (item) { var id = first(item.cell_id_str, item.cell_id); if (validID(id) && id !== '0') { foundCell = id; return true; } return false; });
        return { items: feedRows(cells), has_more: bool(selected.bottom_unlimited), next_offset: 0, session_id: first(selected.session_id), feed_cell: foundCell, feed_plan: first(data.bookstore_id), source: 'webos-recommend-api' };
      });
    }
    if (!validID(cell) || !validID(plan)) return Promise.reject(fail('推荐分页标识无效'));
    var params = { bottom_tab_type: '7', client_req_type: '2', client_template: '7', change_type: '0', category_id: '0', cell_sub_id: '0', limit: '0', need_personal_recommend: '1', video_type_preferences_str: '[]', cell_id: cell, plan_id: plan, tab_type: tab, offset: String(Number(query.offset) || 0), session_id: query.session_id || '', filter_ids: query.shown || '' };
    return signedJSON('/reading/bookapi/bookmall/cell/change/v', 'GET', params, null).then(function (payload) {
      var data = payload && payload.data || {}; var view = data.cell_view || {};
      return { items: feedRows(view.cell_data || []), has_more: bool(data.has_more), next_offset: number(data.next_offset), session_id: first(data.session_id), feed_cell: cell, feed_plan: plan, source: 'webos-recommend-api' };
    });
  }

  function publicationItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var sub = raw.subscribe_data || {};
    var item = normalize(sub);
    if (!item && validID(String(raw.item_id || ''))) item = { series_id: String(raw.item_id), title: first(raw.name), cover: first(raw.cover), intro: first(raw.item_desc), episode_count: 0, vid: '' };
    if (!item || !item.title) return null;
    item.reservation_id = validID(String(raw.item_id || '')) && String(raw.item_id) !== '0' ? String(raw.item_id) : '';
    item.upcoming = !(raw.is_online === true || raw.is_online === 1);
    item.reserved = !!(raw.has_subscribed === true || raw.has_subscribed === 1);
    item.publish_time = number(raw.schedule_publish_time) || number(raw.expected_publish_time);
    item.publish_text = first(raw.sub_info, raw.expected_rec_text);
    item.tags = stringArray(item.tags);
    if (!item.tags.length) item.tags = stringArray(raw.categories).length ? stringArray(raw.categories) : stringArray(raw.sub_title_list);
    return item;
  }

  function calendar(query) {
    query = query || {};
    var offset = Number(query.offset) || 0;
    var params = { offset: String(offset), session_id: query.session_id || '', tab_type: '5', tab_style: '2', active_panel: '6', gender_type: '2', need_calendar_schema: 'true' };
    if (query.subscribe_offset != null && query.subscribe_offset !== '') params.subscribe_offset = String(query.subscribe_offset);
    if (query.date) params.target_date = String(query.date);
    return signedJSON('/reading/user/subscribe/list/v1/', 'GET', params, null).then(function (payload) {
      var data = payload && payload.data || {}; var loc = data.calendar_loc_info || {}; var schema = data.calendar_schema || {};
      var next = number(data.next_offset); var subOffset = loc.subscribe_offset == null ? null : number(loc.subscribe_offset);
      var advances = next > offset || subOffset != null && (query.subscribe_offset == null || subOffset > Number(query.subscribe_offset));
      return { items: (data.subscribe_items || []).map(publicationItem).filter(Boolean), has_more: (bool(data.has_more) || bool(loc.down_has_more)) && advances, next_offset: next, session_id: first(data.session_id), next_subscribe_offset: subOffset, calendar: { dates: stringArray(schema.date_list), default_date: first(schema.default_date), current_date: first(schema.current_date) }, source: 'webos-calendar-api' };
    });
  }
  function appendSearchRows(value, items, seen, depth) {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') {
      try { appendSearchRows(parseExactJSON(value), items, seen, depth + 1); } catch (ignored) {}
      return;
    }
    if (Array.isArray(value)) { value.forEach(function (row) { appendSearchRows(row, items, seen, depth + 1); }); return; }
    if (typeof value !== 'object') return;
    if (Array.isArray(value.video_data)) {
      value.video_data.forEach(function (row) { appendSearchRows(row, items, seen, depth + 1); });
    } else {
      var drama = normalize(value);
      if (drama && validID(drama.series_id) && drama.series_id !== '0' && drama.episode_count > 0 && !seen[drama.series_id]) {
        seen[drama.series_id] = true; items.push(drama);
      }
    }
    ['cell_data', 'data', 'items'].forEach(function (key) { if (value[key] != null) appendSearchRows(value[key], items, seen, depth + 1); });
    if (value.lynx_data) appendSearchRows(value.lynx_data, items, seen, depth + 1);
  }

  function parseAppSearch(payload, offset) {
    var data = payload && payload.data || {};
    var tabs = Array.isArray(data.search_tabs) ? data.search_tabs : Array.isArray(payload && payload.search_tabs) ? payload.search_tabs : [];
    var tab = tabs.filter(function (item) { return Number(item && item.tab_type) === 11; })[0];
    if (!tab) throw fail('App 搜索响应没有短剧分区', 502, 'APP_SEARCH_EMPTY', 'search');
    var items = [], seen = {};
    appendSearchRows(tab.data || [], items, seen, 0);
    var next = number(tab.next_offset);
    var hasMore = bool(tab.has_more);
    if (next <= offset) hasMore = false;
    return { items: items, has_more: hasMore, next_offset: next, search_id: first(tab.search_id), passback: first(tab.passback), source: 'app' };
  }

  function searchApp(query) {
    var offset = Number(query.offset) || 0;
    var params = {
      bookshelf_search_plan: '4', use_correct: 'true', user_is_login: '0', query: trim(query.q),
      count: '20', offset: String(offset), tab_type: '11', search_id: first(query.search_id), passback: first(query.passback)
    };
    return signedJSON('/reading/bookapi/search/tab/v', 'GET', params, null).then(function (payload) {
      return parseAppSearch(payload, offset);
    });
  }

  function parseWebSearch(payload, page) {
    var rows = payload && payload.searchList;
    var pageNumber = number(payload && payload.pageNum);
    var totalPages = number(payload && payload.totalPages);
    if (!Array.isArray(rows) || pageNumber !== page || totalPages < 0) throw fail('官网搜索响应缺少有效分页信息', 502, 'WEB_SEARCH_INVALID', 'search');
    var items = [], seen = {};
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object' || !row.video_data || typeof row.video_data !== 'object') return;
      appendSearchRows(row.video_data, items, seen, 0);
    });
    var hasMore = bool(payload.hasMore) && (totalPages === 0 || page < totalPages) && rows.length > 0;
    return { items: items, has_more: hasMore, next_offset: page, source: 'web' };
  }

  function searchWebsite(query, page) {
    var target = WEB_BASE + '/api/search/result?query=' + querystring.escape(trim(query));
    if (page > 1) target += '&page=' + String(page);
    var attempt = 0;
    function requestPage() {
      attempt++;
      return requestBuffer(target, 'GET', { 'User-Agent': 'Mozilla/5.0 (Android TV; HongguoTV)', Accept: 'application/json', Referer: WEB_BASE + '/' }, null, MAX_JSON).then(function (response) {
        if (response.status < 200 || response.status >= 300) {
          var statusError = fail('官网搜索 HTTP ' + response.status, response.status, 'WEB_SEARCH_HTTP', 'search');
          if (attempt < 2 && response.status >= 500) return requestPage();
          throw statusError;
        }
        var text = response.body.toString('utf8');
        if (!trim(text)) throw fail('官网搜索返回空响应', 502, 'WEB_SEARCH_EMPTY', 'search');
        try { return parseWebSearch(parseExactJSON(text), page); } catch (error) {
          if (error && error.code === 'WEB_SEARCH_INVALID') throw error;
          throw fail('官网搜索响应不是有效 JSON', 502, 'WEB_SEARCH_INVALID', 'search');
        }
      }).catch(function (error) {
        if (attempt < 2 && error && ['ECONNRESET', 'ETIMEDOUT', 'UPSTREAM_TIMEOUT', 'EAI_AGAIN', 'ENETUNREACH'].indexOf(error.code) >= 0) return requestPage();
        throw error;
      });
    }
    return requestPage();
  }

  function search(query) {
    query = query || {};
    var text = trim(query.q);
    if (!text || text.length > 80) return Promise.reject(fail('搜索关键词无效', 400, 'SEARCH_PARAMETERS'));
    var source = first(query.source);
    if (source && source !== 'app' && source !== 'web') return Promise.reject(fail('搜索来源无效', 400, 'SEARCH_SOURCE_INVALID'));
    var rawOffset = query.offset == null || query.offset === '' ? '0' : String(query.offset);
    if (!/^\d{1,6}$/.test(rawOffset) || Number(rawOffset) > 100000) return Promise.reject(fail('搜索分页位置无效', 400, 'SEARCH_PARAMETERS'));
    var offset = Number(rawOffset);
    if (source === 'web') return searchWebsite(text, offset + 1);
    if (source === 'app') return searchApp(query);
    if (offset !== 0) return Promise.reject(fail('搜索分页来源缺失', 400, 'SEARCH_SOURCE_REQUIRED'));
    return searchApp({ q: text, offset: 0 }).catch(function (error) {
      // Website JSON is a deliberate first-page fallback. It has no App
      // device identity, cookie, search_id, or passback cursor.
      return searchWebsite(text, 1).catch(function (webError) {
        var combined = fail('App 搜索失败：' + String(error && error.message || error) + '；官网搜索失败：' + String(webError && webError.message || webError), 502, 'SEARCH_FAILED', 'search');
        throw combined;
      });
    });
  }
  function detail(seriesID) { return fetchHTML(WEB_BASE + '/detail?series_id=' + encodeURIComponent(seriesID)).then(function (html) { var router = routerData(html); var raw = findObject(router, 'seriesDetail'); var drama = normalize(raw); if (!drama || drama.series_id !== seriesID) throw fail('详情响应缺少剧集信息'); drama.episodes = (drama.vid_list || []).map(function (vid, index) { var inferredLocked = index >= drama.accessible_episode_cnt; return { index: index + 1, video_id: vid, title: '第' + (index + 1) + '集', locked: inferredLocked, locked_inferred: inferredLocked }; }); var actors = normalizeSeriesActors(raw); if (!actors.length) actors = normalizeSeriesActors(router); return { series_id: drama.series_id, title: drama.title, cover: drama.cover, cover_fallback: drama.cover_fallback, intro: drama.intro, score: drama.score, play_count: drama.play_count, episode_count: drama.episode_count, accessible_episode_cnt: drama.accessible_episode_cnt, vid: drama.vid, vid_list: drama.vid_list, episodes: drama.episodes, tags: drama.tags, actors: actors, related: normalizeRelatedDramas(router, seriesID), reviews: normalizeSeriesReviews(router) }; }); }

  function fallbackSeason(seriesID, error) {
    return detail(seriesID).then(function (item) {
      item.season_index = Number(item.season_index) || 1;
      item.label = '第' + item.season_index + '季';
      item.playable = true;
      item.upcoming = false;
      item.is_multi_season = false;
      return { items: [item], source: 'webos-detail-fallback', fallback_reason: String(error && error.message || error || '官方系列剧列表为空') };
    });
  }

  function seasonLabelRows(value) {
    return (Array.isArray(value) ? value : []).map(function (entry) {
      if (entry && typeof entry === 'object') return first(entry.content, entry.name, entry.show_name, entry.text);
      return trim(entry);
    }).filter(Boolean);
  }

  function parseOfficialSeasons(payload) {
    if (!payload || String(payload.code) !== '0') throw fail('官方系列剧未确认请求成功');
    var blocks = payload.data;
    if (!Array.isArray(blocks)) throw fail('官方系列剧响应缺少列表');
    var seen = {}, items = [];
    blocks.forEach(function (block) {
      (block && Array.isArray(block.video_data) ? block.video_data : []).forEach(function (row) {
        var item = normalize(row);
        if (!item || !validID(item.series_id) || seen[item.series_id]) return;
        seen[item.series_id] = true;
        var labels = seasonLabelRows(row.secondary_info_list);
        item.label = labels.filter(function (x) { return /^第[1-9][0-9]*季$/.test(x); })[0] || '';
        item.season_index = Number(item.season_index) || Number((item.label.match(/[0-9]+/) || [0])[0]) || 0;
        item.subtitle = seasonLabelRows(row.sub_title_list).join(' · ');
        item.is_multi_season = true;
        var subscribe = row.subscribe_item && typeof row.subscribe_item === 'object' ? row.subscribe_item : null;
        item.upcoming = !!subscribe || !item.vid || !item.episode_count;
        item.playable = !item.upcoming && !row.disable_play;
        item.reservation_id = item.upcoming && subscribe ? item.series_id : '';
        item.reserved = !!(subscribe && (subscribe.is_subscribed === true || subscribe.is_subscribed === 1));
        if (item.upcoming) item.vid = '';
        items.push(item);
      });
    });
    return items;
  }

  function loadSeasonRows(seriesID) {
    var params = { scene: '10', from: 'single_col_same_ip_series', offset: '0', limit: '0', total_chapter_num: '0', current_chapter_num: '0', post_id: '0', is_horizontal_screen: 'false', bookstore_tab: '0', bookstore_tab_type: '0', book_id: seriesID, filter_ids: seriesID };
    params.from = 'series_short_play_info';
    return miniJSON('/reading/bookapi/plan/v', params).then(parseOfficialSeasons).then(function (items) {
      if (!items.length) throw fail('官方系列剧列表为空');
      return items;
    });
  }

  function seriesSeasons(seriesID) {
    if (!validID(seriesID)) return Promise.reject(fail('series_id 无效'));
    return loadSeasonRows(seriesID).then(function (items) {
      return { items: items, source: 'webos-plan' };
    }).catch(function (error) {
      // Some webOS networks receive an empty plan response even though the
      // public detail page is available. Keep the season selector truthful by
      // exposing the confirmed current season instead of inventing siblings.
      return fallbackSeason(seriesID, error);
    });
  }

  function nextSeason(seriesID) {
    if (!validID(seriesID)) return Promise.reject(fail('series_id 无效'));
    return loadSeasonRows(seriesID).then(function (items) {
      var current = items.filter(function (item) { return String(item.series_id) === String(seriesID); })[0];
      var currentIndex = current && Number(current.season_index) || 0;
      var sibling = items.filter(function (item) { return String(item.series_id) !== String(seriesID) && item.playable && Number(item.season_index) > 0; }).sort(function (a, b) { return Number(a.season_index) - Number(b.season_index); })[0];
      if (!sibling) return { current_season: currentIndex, next: null };
      function choose() {
        var next = items.filter(function (item) { return String(item.series_id) !== String(seriesID) && item.playable && Number(item.season_index) > currentIndex; }).sort(function (a, b) { return Number(a.season_index) - Number(b.season_index); })[0] || null;
        return { current_season: currentIndex, next: next };
      }
      if (currentIndex > 0) return choose();
      // plan/v can omit the requested current season. Confirm its number from
      // a sibling's reciprocal relation before crossing to another season.
      return loadSeasonRows(sibling.series_id).then(function (reciprocal) {
        var confirmed = reciprocal.filter(function (item) { return String(item.series_id) === String(seriesID); })[0];
        if (!confirmed || Number(confirmed.season_index) <= 0) throw fail('官方季关系未确认当前季，已停止自动跨季');
        currentIndex = Number(confirmed.season_index);
        return choose();
      });
    });
  }

  function suggestions(query) {
    query = trim(query);
    if (!query) return Promise.resolve({ items: [] });
    if (query.length > 100) return Promise.reject(fail('搜索关键词过长'));
    return publicJSON('/incent_resource/suggestion', { app_id: '8662', query: query, count: '10' }).then(function (payload) {
      var rows = payload && (payload.suggest_list || payload.suggestions) || [];
      return { items: rows.map(function (row) {
        row = row || {};
        var name = first(row.name, Array.isArray(row.display_words) && row.display_words[0]);
        if (!name) return null;
        var kind = first(row.word_type, 'common_query');
        var item = { kind: kind, key: first(row.keyword, name), name: name };
        if (kind === 'short_play_actor') item.actor_id = item.key;
        if (row.video_data && typeof row.video_data === 'object') {
          item.drama = normalize(row.video_data);
          item.meta = stringArray(row.video_data.category_list).slice(0, 3).join(' · ');
        }
        return item;
      }).filter(Boolean) };
    });
  }

  function actorWorks(actorID) {
    if (!validID(actorID)) return Promise.reject(fail('actor_id 无效'));
    return fetchHTML(WEB_BASE + '/character/' + encodeURIComponent(actorID)).then(function (html) {
      var router = routerData(html); var root = router && router.loaderData || {};
      var page = root['character_(id)/page'] || {};
      var user = page.userInfo || {};
      var id = first(user.actor_id, user.actor_id_str, user.person_id);
      if (id && id !== actorID) throw fail('演员作品响应与请求不一致');
      var rows = Array.isArray(page.videoList) ? page.videoList : [];
      return { actor: { id: actorID, name: first(user.user_name, user.name, '未知演员'), avatar: first(user.user_avatar, user.avatar), description: first(user.description, user.intro) }, items: normalizeRows(rows) };
    });
  }

  function engagement(seriesID, vid) {
    if (!validID(seriesID) || !validID(vid)) return Promise.reject(fail('短剧或视频 ID 无效'));
    return signedJSON('/novel/player/multi_video_detail/preload/v1', 'POST', {}, { dr_scene: 'preload', series_id: seriesID, biz_param: { detail_page_version: 0, disable_digg_stat: false, disable_video_relate_book: false, need_all_video_definition: false, need_mp4_align: false, source: 7, use_os_player: false, use_server_dns: false } }).then(function (payload) {
      var data = payload && payload.data || {}; var series = data[seriesID] || {}; var video = series.video_data || {};
      var out = { series_id: seriesID, vid: vid, likes: null, favorites: number(video.followed_cnt), comments: null, episode_cover: '' };
      (Array.isArray(video.video_list) ? video.video_list : []).forEach(function (row) { if (String(row.vid) === vid) { out.likes = number(row.digged_count); out.comments = number(row.comment_count); out.episode_cover = first(row.episode_cover); } });
      return out;
    });
  }

  function discussion(seriesID, vid, query, danmaku) {
    query = query || {};
    if (!validID(seriesID) || !validID(vid)) return Promise.reject(fail('缺少短剧或集的视频 ID'));
    var cursor = first(query.cursor, '0');
    var params = { comment_source: danmaku ? '601' : '4', server_channel: danmaku ? '1000' : '18', group_id: vid, group_type: '30', comment_type: danmaku ? '20' : '4', sort: '1', need_count: 'true', book_id: seriesID, req_type: '0', count: danmaku ? '90' : '20', cursor: danmaku ? '0' : cursor, aid: '8662', compliance_status: '0' };
    if (danmaku) {
      var start = Number(query.start || 0), duration = Number(query.duration || 600000);
      if (!isFinite(start) || start < 0 || start > 86400000 || !isFinite(duration) || duration < 1 || duration > 86400000) return Promise.reject(fail('弹幕时间无效'));
      params.start_offset_time = String(start); params.playlet_item_duration = String(duration); params.need_danmaku_guide_type = '24';
    }
    params.business_param = JSON.stringify({ need_count: true, book_id: seriesID, req_type: 0 });
    return signedJSON('/novel/commentapi/comment/list/' + encodeURIComponent(vid) + '/v1/', 'GET', params, null).then(function (payload) {
      var data = payload && payload.data || {}, info = data.common_list_info || {};
      var rows = Array.isArray(data.data_list) ? data.data_list : [];
      return { items: rows.map(function (row) {
        var comment = row && (row.comment || row) || {}, common = comment.common || comment.Common || {}, content = common.content || {}, expand = comment.expand || {}, stat = comment.stat || {};
        var user = common.user_info || {}, base = user.base_info || {};
        return { comment_id: first(comment.comment_id), text: first(content.text), author: first(base.user_name), avatar: first(base.expand_user_avatar, base.user_avatar), created: number(common.create_timestamp), likes: number(stat.digg_count), replies: number(stat.reply_count), offset_ms: number(expand.offset_time), liked: !!(comment.user_action && comment.user_action.user_digg) };
      }).filter(function (item) { return validID(item.comment_id) && item.text; }), has_more: bool(info.has_more), next_cursor: first(info.cursor), total: number(info.total), window_end: 0 };
    });
  }

  function replies(seriesID, vid, commentID, query) {
    query = query || {};
    if (!validID(seriesID) || !validID(vid) || !validID(commentID)) return Promise.reject(fail('回复参数无效'));
    var body = { comment_source: 504, server_channel: 18, comment_id: commentID, comment_type: 4, group_id: vid, group_type: 30, business_param: { need_count: true, book_id: seriesID }, count: 10, cursor: first(query.cursor, '0'), aid: 8662, compliance_status: 0 };
    return signedJSON('/novel/commentapi/reply/list/' + encodeURIComponent(commentID) + '/v1/', 'POST', {}, body).then(function (payload) {
      var data = payload && payload.data || {}, info = data.comment_list_info || {}, rows = Array.isArray(data.reply_list) ? data.reply_list : [];
      return { items: rows.map(function (row) { var reply = row && (row.reply || row) || {}, common = reply.common || reply.Common || {}, content = common.content || {}, user = common.user_info || {}, base = user.base_info || {}; return { comment_id: first(reply.reply_id), text: first(content.text), author: first(base.user_name), avatar: first(base.expand_user_avatar, base.user_avatar), created: number(common.create_timestamp), likes: number((reply.stat || {}).digg_count), replies: number((reply.stat || {}).reply_count), offset_ms: 0, liked: !!(reply.user_action && reply.user_action.user_digg) }; }).filter(function (item) { return validID(item.comment_id) && item.text; }), has_more: bool(info.has_more), next_cursor: first(info.cursor), total: number(info.total) };
    });
  }

  function mediaDiagnostics(mediaPath) {
    var result = { version: 'webos-service', os: 'webos', arch: 'unknown', media_prepared: false, media_bytes: 0, media_http_status: 0, media_age_seconds: 0, media_state: 'none' };
    var match = /^\/minireel-proxy\/media\/([a-f0-9]{24})\.mp4$/.exec(String(mediaPath || ''));
    ensureCacheRoot();
    result.media_cache = mediaCache.diagnostics();
    var report = match ? preparationReports[match[1]] : lastForegroundPreparation;
    if (report && (match || report.media_preparation_stage !== 'ready')) Object.assign(result, report);
    if (!match) return result;
    var token = match[1], file = path.join(ensureCacheRoot(), token, token + '.mp4'), stat;
    try { stat = fs.statSync(file); result.media_prepared = stat.isFile(); result.media_bytes = stat.size; result.media_state = result.media_prepared ? 'ready' : 'missing'; } catch (ignored) { result.media_state = jobs[token] ? 'preparing' : 'missing'; }
    var status = mediaStatus[token];
    if (status) { result.media_http_status = status.status; result.media_age_seconds = Math.max(0, Math.floor((Date.now() - status.at) / 1000)); result.media_mode = status.mode || 'full'; }
    var rangeSource = rangeSources[token];
    if (rangeSource) {
      if (typeof rangeMedia.headDiagnostics === 'function') Object.assign(result, rangeMedia.headDiagnostics(rangeSource));
      result.media_mode = 'range';
      result.media_prepared = true;
      result.media_bytes = 0;
      result.media_range_length = rangeSource.length;
      result.media_init_bytes = rangeSource.prefix.length;
      result.media_sample_count = rangeSource.samples.length;
      result.media_metadata_bytes = rangeSource.prefix.length + rangeSource.samples.length * 128 + (rangeSource.key ? rangeSource.key.length : 0);
      result.media_state = 'range-ready';
    }
    return result;
  }

  function trimRangeSources(keepToken, keepSource) {
    var now = Date.now();
    var metadataBytes = keepSource ? keepSource.prefix.length + keepSource.samples.length * 128 + (keepSource.key ? keepSource.key.length : 0) : 0;
    if (metadataBytes > 24 * 1024 * 1024) throw fail('MP4 Range 索引超过内存限制');
    Object.keys(rangeSources).forEach(function (key) {
      if (key !== keepToken && !mediaCache.isActive(key) && now - Number(rangeSources[key].lastUsedAt || 0) > 15 * 60 * 1000) delete rangeSources[key];
    });
    var keys = Object.keys(rangeSources).filter(function (key) { return key !== keepToken && !mediaCache.isActive(key); });
    keys.sort(function (a, b) { return Number(rangeSources[a].lastUsedAt || 0) - Number(rangeSources[b].lastUsedAt || 0); });
    function totalBytes() {
      return Object.keys(rangeSources).reduce(function (total, key) {
        if (key === keepToken) return total;
        var source = rangeSources[key];
        return total + source.prefix.length + source.samples.length * 128 + (source.key ? source.key.length : 0);
      }, metadataBytes);
    }
    function otherCount() { return Object.keys(rangeSources).filter(function (key) { return key !== keepToken; }).length; }
    while ((otherCount() >= 2 || totalBytes() > 24 * 1024 * 1024) && keys.length) delete rangeSources[keys.shift()];
    if (otherCount() >= 2) throw fail('正在使用的 Range 索引已占满缓存，请稍后重试');
    if (totalBytes() > 24 * 1024 * 1024) throw fail('Range 索引缓存超过内存限制');
  }

  function videoModelDiagnostics() {
    if (!lastVideoModelDiagnostic) return { stage: 'idle', code: 'NOT_RUN' };
    return JSON.parse(JSON.stringify(lastVideoModelDiagnostic));
  }

  function foregroundVideoModelDiagnostics() {
    var diagnostic = lastForegroundPreparation && lastForegroundPreparation.media_video_model;
    return diagnostic ? JSON.parse(JSON.stringify(diagnostic)) : { stage: 'idle', code: 'NOT_RUN' };
  }

  function inspectVideoModel(vid) {
    var diagnostic;
    return videoOptions(String(vid || ''), null, { onDiagnostic: function (value) { diagnostic = value; } }).then(function () {
      return { ok: true, diagnostic: diagnostic };
    }, function (error) {
      return { ok: false, diagnostic: diagnostic, error: { status: Number(error && error.status) || 502, code: String(error && error.code || 'VIDEO_MODEL_ERROR'), stage: String(error && error.stage || 'video_model'), message: String(error && error.message || 'video_model 请求失败') } };
    });
  }

  function radar() {
    function remote(name) {
      var targets = ['https://ghfast.top/https://raw.githubusercontent.com/2252399314-cyber/hongguo-radar/main/data/derived/' + name + '.json', 'https://raw.githubusercontent.com/2252399314-cyber/hongguo-radar/main/data/derived/' + name + '.json'];
      var index = 0;
      function next() {
        if (index >= targets.length) return Promise.reject(fail('榜单雷达数据源不可用'));
        return requestBuffer(targets[index++], 'GET', { Accept: 'application/json', 'User-Agent': 'HongguoTV-Radar/1.0' }, null, 5 * 1024 * 1024).then(function (response) {
          if (response.status < 200 || response.status >= 300 || !response.body.length) throw fail('榜单雷达响应无效');
          try { return parseExactJSON(response.body.toString('utf8')); } catch (error) { throw fail('榜单雷达 JSON 无效'); }
        }).catch(next);
      }
      return next();
    }
    return Promise.all([remote('ranks_latest'), remote('growth_latest')]).then(function (values) {
      return { ranks: values[0], growth: values[1], ranks_stale: false, growth_stale: false };
    });
  }

  var dataRoot = '';
  function ensureDataRoot() {
    if (dataRoot) return dataRoot;
    var candidates = [];
    if (process.env.HONGGUO_WEBOS_DATA_DIR) candidates.push(process.env.HONGGUO_WEBOS_DATA_DIR);
    candidates.push('/var/palm/data/com.aston314.hongguo.webos.service/data');
    candidates.push(path.join(process.cwd(), 'data'));
    for (var i = 0; i < candidates.length; i++) { try { mkdirp(candidates[i], 448); dataRoot = candidates[i]; return dataRoot; } catch (ignored) {} }
    throw fail('webOS 数据目录不可写');
  }
  function dataDirectory() { return ensureDataRoot(); }
  function readData(name, fallback) {
    var file = path.join(ensureDataRoot(), name);
    try { return parseExactJSON(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error && error.code === 'ENOENT') return fallback; throw fail('本地数据文件损坏，未覆盖原记录'); }
  }
  function writeData(name, value) { var file = path.join(ensureDataRoot(), name); var temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value), { mode: 384 }); fs.renameSync(temp, file); }

  function library() { var value = readData('library.json', { version: 1, entries: [], owner_id: '' }); if (!Array.isArray(value.entries)) value.entries = []; return value; }
  function changeLibrary(change) {
    change = change || {};
    var data = library(); var id = String(change.series_id || change.drama && change.drama.series_id || ''); var index = -1; data.entries.forEach(function (entry, i) { if (entry.drama && String(entry.drama.series_id) === id) index = i; });
    function clearEntry(entry, kind) {
      if (!kind || kind === 'history') { entry.last_played_at = 0; entry.episode = 0; entry.position = 0; entry.duration = 0; entry.video_id = ''; entry.completed = false; }
      if (!kind || kind === 'favorites') entry.favorite_at = 0;
      if (!kind || kind === 'likes') { entry.liked_at = 0; entry.liked_videos = []; }
    }
    if (change.action === 'clear' || change.action === 'remove') {
      if (['history', 'favorites', 'likes'].indexOf(change.kind) < 0) throw fail('记录类型无效');
      if (change.action === 'remove' && !validID(id)) throw fail('series_id 无效');
      if (change.action === 'clear') data.entries.forEach(function (entry) { clearEntry(entry, change.kind); });
      else if (index >= 0) clearEntry(data.entries[index], change.kind);
    } else {
      if (['progress', 'favorite', 'like'].indexOf(change.action) < 0) throw fail('记录操作无效');
      if (!change.drama || !validID(String(change.drama.series_id || '')) || !change.drama.title) throw fail('短剧信息无效');
      if (change.action !== 'progress' && typeof change.value !== 'boolean') throw fail('缺少收藏/点赞状态');
      if (index < 0) { data.entries.push({ drama: change.drama || {}, liked_videos: [] }); index = data.entries.length - 1; }
      var entry = data.entries[index]; entry.drama = change.drama || entry.drama;
      var now = Date.now();
      if (change.action === 'progress') {
        entry.episode = Number(change.episode) || 0; entry.video_id = String(change.video_id || ''); entry.position = Number(change.position) || 0; entry.duration = Number(change.duration) || 0; entry.completed = !!change.completed; entry.last_played_at = now;
        if (entry.episode < 1 || !validID(entry.video_id) || entry.position < 0 || entry.position > 86400 || entry.duration < 0 || entry.duration > 86400) throw fail('播放进度无效');
      }
      if (change.action === 'favorite') entry.favorite_at = change.value ? now : 0;
      if (change.action === 'like') {
        var videoID = String(change.video_id || '');
        if (videoID) {
          var episode = Number(change.episode) || 0;
          if (!validID(videoID) || videoID === '0' || episode < 1 || episode > 10000) throw fail('缺少当前播放集');
          entry.liked_videos = Array.isArray(entry.liked_videos) ? entry.liked_videos : [];
          entry.liked_videos = entry.liked_videos.filter(function (item) { return String(item.video_id) !== videoID; });
          if (change.value) entry.liked_videos.push({ video_id: videoID, episode: episode, liked_at: now });
          entry.liked_at = entry.liked_videos.reduce(function (latest, item) { return Math.max(latest, Number(item.liked_at) || 0); }, 0);
        } else {
          entry.liked_at = change.value ? now : 0;
        }
      }
    }
    data.entries = data.entries.filter(function (entry) { return entry.last_played_at || entry.favorite_at || entry.liked_at || entry.liked_videos && entry.liked_videos.length; });
    writeData('library.json', data); return data;
  }
  function searchHistory(method, query) {
    var data = readData('search-history.json', { items: [] }); if (!Array.isArray(data.items)) data.items = [];
    if (method === 'GET') return { items: data.items, limit: 10 };
    if (method === 'DELETE') { data.items = []; writeData('search-history.json', data); return { items: [], limit: 10 }; }
    query = trim(query); if (!query || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) throw fail('请输入不超过100字的剧名或关键词'); data.items = [query].concat(data.items.filter(function (item) { return item !== query; })).slice(0, 10); writeData('search-history.json', data); return { items: data.items, limit: 10 };
  }

  module.exports = {
    prepare: prepare, prepareAudio: prepareAudio, serveMedia: serveMedia, category: category,
    recommend: recommend, newSeries: newSeries, calendar: calendar,
    rank: rank, search: search, detail: detail, seasons: seriesSeasons, nextSeason: nextSeason,
    suggestions: suggestions, actorWorks: actorWorks, engagement: engagement, discussion: discussion, replies: replies,
    radar: radar, library: library, changeLibrary: changeLibrary,
    dataDirectory: dataDirectory,
    startCache: function () { ensureCacheRoot(); mediaCache.start(); },
    closeCache: function () {
      Object.keys(jobs).forEach(function (key) { if (jobs[key].recoveryCancel) jobs[key].recoveryCancel.abort('PLAYBACK_PREPARATION_CANCELLED'); });
      Object.keys(audioJobs).forEach(function (key) { audioJobs[key].cancel.abort(); });
      audioRange.close(); audioCache = [];
      if (typeof rangeMedia.clearHeadCache === 'function') rangeMedia.clearHeadCache();
      if (mediaCache) mediaCache.close();
    },
    cacheSession: function (body) { ensureCacheRoot(); return mediaCache.updateSession(body); },
    searchHistory: searchHistory, mediaDiagnostics: mediaDiagnostics, parseMediaByteRange: parseMediaByteRange,
    videoModelDiagnostics: videoModelDiagnostics, foregroundVideoModelDiagnostics: foregroundVideoModelDiagnostics, inspectVideoModel: inspectVideoModel,
    status: function () { return { playback_verified: false, provider: 'first-party-js-port', media: 'cenc-aes-ctr-range-with-full-download-fallback', data: 'real-public-metadata-plus-local-library' }; }
  };
}());
