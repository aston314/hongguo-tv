'use strict';

// Website QR protocol stays in the Service. Only a local opaque ID, PNG and
// display state may cross the HTTP boundary to the shared UI.
var https = require('https');
var url = require('url');
var querystring = require('querystring');
var crypto = require('crypto');
var BASE = 'https://hongguoduanju.com';
var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function failure(message) { var error = new Error(message); error.status = 502; error.code = 'ACCOUNT_QR'; return error; }
function validTarget(target) {
  var p;
  try { p = url.parse(target); } catch (ignored) { return false; }
  var host = String(p.hostname || '').toLowerCase();
  return p.protocol === 'https:' && !p.auth && !p.hash && (!p.port || p.port === '443') &&
    (host === 'hongguoduanju.com' || /\.hongguoduanju\.com$/.test(host));
}
function image(value) {
  value = String(value || '').replace(/^data:image\/png;base64,/, '');
  if (value.length > 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) return '';
  var bytes = Buffer.from(value, 'base64');
  if (bytes.length < 33 || bytes.slice(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') return '';
  var w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  return w >= 32 && h >= 32 && w <= 2048 && h <= 2048 ? 'data:image/png;base64,' + bytes.toString('base64') : '';
}
function expiry(value, now) {
  var seconds = Number(value);
  if (value == null || value === '') seconds = 180;
  if (!isFinite(seconds)) seconds = 0;
  if (seconds > 1000000000000) seconds = Math.floor(seconds / 1000) - Math.floor(now / 1000);
  else if (seconds > 1000000000) seconds -= Math.floor(now / 1000);
  return now + Math.max(0, Math.min(600, seconds)) * 1000;
}

// Small, domain/path-scoped HTTPS cookie jar; never forward a child-domain
// cookie to the parent or to an unrelated redirect target.
function Jar() { this.values = []; }
Jar.prototype.set = function (target, headers) {
  var p = url.parse(target), host = p.hostname.toLowerCase(), self = this, lines = headers && headers['set-cookie'] || [];
  if (typeof lines === 'string') lines = [lines];
  lines.forEach(function (line) {
    var parts = String(line).split(';'), match = /^([A-Za-z0-9_-]{1,80})=([^\r\n;]*)$/.exec(parts.shift());
    if (!match) return;
    var pathname = p.pathname || '/', slash = pathname.lastIndexOf('/');
    var item = { name: match[1], value: match[2], domain: host, hostOnly: true, path: slash > 0 ? pathname.slice(0, slash) : '/', until: Infinity }, maxAge = null;
    parts.forEach(function (part) {
      var at = part.indexOf('='), key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase(), value = at < 0 ? '' : part.slice(at + 1).trim();
      if (key === 'domain') { item.domain = value.replace(/^\./, '').toLowerCase(); item.hostOnly = false; }
      if (key === 'path' && value.charAt(0) === '/') item.path = value;
      if (key === 'expires' && isFinite(Date.parse(value))) item.until = Date.parse(value);
      if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    });
    if (item.domain !== host && host.slice(-(item.domain.length + 1)) !== '.' + item.domain) return;
    if (item.domain !== 'hongguoduanju.com' && !/\.hongguoduanju\.com$/.test(item.domain)) return;
    if (maxAge !== null) item.until = Date.now() + maxAge * 1000;
    self.values = self.values.filter(function (v) { return !(v.name === item.name && v.domain === item.domain && v.path === item.path) && v.until > Date.now(); });
    if (item.until > Date.now() && self.values.length < 128) self.values.push(item);
  });
};
Jar.prototype.cookies = function (target) {
  var p = url.parse(target), host = p.hostname.toLowerCase(), pathname = p.pathname || '/';
  return this.values.filter(function (v) {
    return v.until > Date.now() && (v.domain === host || !v.hostOnly && host.slice(-(v.domain.length + 1)) === '.' + v.domain) &&
      (pathname === v.path || pathname.indexOf(v.path) === 0 && (v.path.slice(-1) === '/' || pathname.charAt(v.path.length) === '/'));
  }).sort(function (a, b) { return b.path.length - a.path.length; });
};
Jar.prototype.header = function (target) { return this.cookies(target).map(function (c) { return c.name + '=' + c.value; }).join('; '); };
Jar.prototype.export = function () { var out = {}; this.cookies(BASE + '/').forEach(function (c) { if (!Object.prototype.hasOwnProperty.call(out, c.name)) out[c.name] = c.value; }); return out; };

function nativeRequest(target, method, headers, body, limit, control) {
  return new Promise(function (resolve, reject) {
    var p = url.parse(target), req = https.request({ hostname: p.hostname, port: p.port || 443, path: p.path, method: method, headers: headers });
    var chunks = [], size = 0, done = false;
    function finish(error, value) { if (done) return; done = true; if (error) reject(error); else resolve(value); }
    control.onCancel(function () { req.destroy(); finish(failure('扫码请求已取消')); });
    req.on('error', function () { finish(failure('扫码登录连接失败，请重试')); });
    req.on('response', function (res) {
      res.on('error', function () { finish(failure('扫码登录响应读取失败')); });
      res.on('aborted', function () { finish(failure('扫码登录响应读取失败')); });
      res.on('data', function (chunk) { size += chunk.length; if (size > limit) { req.destroy(); finish(failure('扫码登录响应过大')); } else chunks.push(chunk); });
      res.on('end', function () { finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    if (body && body.length) req.write(body);
    req.end();
  });
}

module.exports = function (options) {
  options = options || {};
  var send = options.requestBuffer || nativeRequest, parse = options.parseJSON || JSON.parse;
  var pollEvery = options.pollInterval == null ? 1800 : options.pollInterval;
  var requestTimeout = options.requestTimeout == null ? 12000 : options.requestTimeout;
  var completionTimeout = options.completionTimeout == null ? 45000 : options.completionTimeout;
  var current = null;
  function snapshot() {
    if (!current) return null;
    return Object.assign({}, current.status);
  }
  function valid(attempt) { return current === attempt && attempt.active; }
  function clean(attempt) {
    clearTimeout(attempt.timer); clearTimeout(attempt.deadline);
    attempt.requests.slice().forEach(function (abort) { abort(); });
    attempt.requests = []; attempt.jar.values = [];
  }
  function terminal(attempt, state, message) {
    if (!valid(attempt)) return;
    attempt.active = false; attempt.status.state = state; attempt.status.error = message || ''; delete attempt.status.image;
    clean(attempt);
  }
  function cancel(id) {
    if (!current || id && id !== current.status.id || current.status.state === 'signed_in') return;
    terminal(current, 'cancelled', '');
  }
  function request(attempt, target, method, headers, body, limit) {
    if (!valid(attempt)) return Promise.reject(failure('扫码请求已取消'));
    return new Promise(function (resolve, reject) {
      var done = false, hooks = [], timer;
      function finish(error, result) {
        if (done) return; done = true; clearTimeout(timer);
        attempt.requests = attempt.requests.filter(function (fn) { return fn !== abort; });
        if (error) reject(error); else resolve(result);
      }
      function abort() { hooks.forEach(function (fn) { try { fn(); } catch (ignored) {} }); finish(failure('扫码登录连接失败，请重试')); }
      attempt.requests.push(abort);
      timer = setTimeout(abort, requestTimeout);
      Promise.resolve().then(function () {
        if (!valid(attempt) || done) throw failure('扫码请求已取消');
        return send(target, method || 'GET', headers || {}, body || null, limit || 2 * 1024 * 1024, { onCancel: function (fn) { if (done) fn(); else hooks.push(fn); } });
      }).then(function (result) {
        if (!valid(attempt)) return finish(failure('扫码请求已取消'));
        if (!result || !Buffer.isBuffer(result.body) || result.body.length > (limit || 2 * 1024 * 1024)) return finish(failure('扫码登录响应无效'));
        finish(null, result);
      }, function () { finish(failure('扫码登录连接失败，请重试')); });
    });
  }
  function web(attempt, target) {
    if (!validTarget(target)) return Promise.reject(failure('登录确认跳转地址无效'));
    return request(attempt, target, 'GET', { 'User-Agent': UA, Referer: BASE + '/', Origin: BASE, Accept: 'application/json, text/javascript', 'Accept-Encoding': 'identity', Cookie: attempt.jar.header(target) }).then(function (response) {
      attempt.jar.set(target, response.headers); return response;
    });
  }
  function json(attempt, pathname, values) {
    var params = Object.assign({ aid: '513755', passport_jssdk_version: '3.4.10', passport_jssdk_type: 'normal', account_sdk_source: 'web', is_from_ttaccountsdk: '1', language: 'zh' }, values || {});
    return web(attempt, BASE + pathname + '?' + querystring.stringify(params)).then(function (response) {
      var payload;
      try { payload = parse(response.body.toString('utf8')); } catch (ignored) { throw failure('扫码登录响应无效，请重新获取二维码'); }
      var data = payload && payload.data || {}, code = data.error_code || payload.error_code || payload.code;
      if (response.status !== 200 || payload.message !== 'success' || code != null && String(code) !== '0') throw failure('扫码登录响应无效，请重新获取二维码');
      return data;
    });
  }
  function redirect(attempt, target, count) {
    return web(attempt, target).then(function (response) {
      if ([301, 302, 303, 307, 308].indexOf(response.status) >= 0) {
        if (count >= 4 || !response.headers.location) throw failure('登录确认跳转次数过多');
        return redirect(attempt, url.resolve(target, response.headers.location), count + 1);
      }
      if (response.status !== 200) throw failure('登录确认未完成，请重新扫码');
    });
  }
  function confirm(attempt, target) {
    attempt.status.state = 'processing';
    clearTimeout(attempt.deadline);
    attempt.deadline = setTimeout(function () { terminal(attempt, 'failed', '扫码账号确认超时，请重试'); }, completionTimeout);
    return (target ? redirect(attempt, url.resolve(BASE + '/', target), 0) : Promise.resolve()).then(function () {
      var cookies = attempt.jar.export();
      if (!cookies.sessionid && !cookies.sessionid_ss) throw failure('扫码确认未取得会话，请重新扫码');
      return json(attempt, '/passport/account/info/v2/');
    }).then(function (data) {
      var uid = String(data.user_id_str || data.user_id || ''), numeric = data.user_id == null ? '' : String(data.user_id);
      if (!/^[0-9]{1,32}$/.test(uid) || uid === '0' || numeric && numeric !== uid) throw failure('扫码账号身份无效，请重新扫码');
      var profile = { uid: uid, name: String(data.name || data.screen_name || data.username || '红果用户').trim() || '红果用户', avatar: String(data.avatar_url || '') };
      return options.finish(profile, attempt.jar.export(), { current: function () { return valid(attempt); }, request: function (target, method, headers, body, limit) { return request(attempt, target, method, headers, body, limit); } });
    }).then(function () { terminal(attempt, 'signed_in', ''); });
  }
  function poll(attempt, token) {
    if (!valid(attempt)) return;
    attempt.timer = setTimeout(function () {
      json(attempt, '/passport/web/check_qrconnect/', { next: BASE + '/', token: token }).then(function (data) {
        if (!valid(attempt)) return;
        attempt.status.error = '';
        var state = String(data.status == null ? '' : data.status);
        if (['1', 'new', 'pending', ''].indexOf(state) >= 0) return poll(attempt, token);
        if (state === '2' || state === 'scanned') { attempt.status.state = 'scanned'; return poll(attempt, token); }
        if (state === '4' || state === 'cancelled') return terminal(attempt, 'cancelled', '');
        if (state === '5' || state === 'expired') return terminal(attempt, 'expired', '');
        if (state === '3' || state === 'confirmed') return confirm(attempt, String(data.redirect_url || '')).catch(function () { terminal(attempt, 'failed', '扫码账号确认失败，请重新扫码'); });
        terminal(attempt, 'failed', '扫码状态已变化，请重新获取二维码');
      }, function () {
        if (!valid(attempt)) return;
        attempt.status.error = '连接暂时中断，正在重试'; poll(attempt, token);
      }).catch(function () { terminal(attempt, 'failed', '扫码登录失败，请重试'); });
    }, pollEvery);
  }
  function start() {
    cancel();
    var attempt = { active: true, status: { id: crypto.randomBytes(16).toString('hex'), state: 'preparing' }, jar: new Jar(), requests: [] };
    current = attempt;
    attempt.deadline = setTimeout(function () { terminal(attempt, 'expired', ''); }, 10 * 60 * 1000);
    json(attempt, '/passport/web/get_qrcode/', { next: BASE + '/' }).then(function (data) {
      if (!valid(attempt)) return;
      var png = image(data.qrcode), token = String(data.token || '');
      if (!png || !token || token.length > 8192) throw failure('二维码响应无效');
      attempt.status.state = 'pending'; attempt.status.image = png; attempt.status.expires_at = expiry(data.expire_time, Date.now());
      clearTimeout(attempt.deadline);
      attempt.deadline = setTimeout(function () { terminal(attempt, 'expired', ''); }, Math.max(0, attempt.status.expires_at - Date.now()));
      poll(attempt, token);
    }).catch(function () { terminal(attempt, 'failed', '二维码获取失败，请重试'); });
    return snapshot();
  }
  return { start: start, snapshot: snapshot, cancel: cancel, reset: function () { cancel(); current = null; } };
};
