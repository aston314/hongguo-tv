(function () {
  'use strict';

  var http = require('http');
  var os = require('os');
  var crypto = require('crypto');
  var querystring = require('querystring');
  var QRCode = require('./qr-code');
  var QRErrorCorrectLevel = require('./qr-code/QRErrorCorrectLevel');
  var TTL_MS = 5 * 60 * 1000;
  var MAX_TEXT = 100;
  var PHONE_COUNTRIES = {
    '+86': { min: 11, max: 11 }, '+852': { min: 8, max: 8 }, '+853': { min: 8, max: 8 },
    '+886': { min: 9, max: 10 }, '+60': { min: 9, max: 10 }, '+65': { min: 8, max: 8 },
    '+62': { min: 10, max: 13 }, '+95': { min: 9, max: 10 }, '+63': { min: 7, max: 10 },
    '+84': { min: 9, max: 10 }, '+855': { min: 8, max: 9 }, '+81': { min: 9, max: 11 },
    '+82': { min: 8, max: 11 }, '+971': { min: 9, max: 9 }
  };

  function fail(message, status, code) {
    var error = new Error(message);
    error.status = status || 400;
    error.code = code || 'NUMBER_INPUT';
    return error;
  }

  function normalizeText(value, collapseWhitespace) {
    value = String(value == null ? '' : value).replace(/^\s+|\s+$/g, '');
    if (collapseWhitespace) value = value.replace(/\s+/g, ' ');
    if (!value || value.length > MAX_TEXT || /[\x00-\x1f\x7f-\x9f]/.test(value)) return '';
    return value;
  }

  function normalizeValue(kind, value, countryCode) {
    value = String(value == null ? '' : value).replace(/^\s+|\s+$/g, '');
    if (kind === 'search') return normalizeText(value, true);
    if (kind === 'danmaku') return normalizeText(value, false);
    if (kind === 'code') return /^[0-9]{4,8}$/.test(value) ? value : '';
    if (kind === 'phone') {
      countryCode = countryCode || '+86';
      var country = PHONE_COUNTRIES[countryCode];
      if (!country || !/^[0-9]+$/.test(value) || value.length < country.min || value.length > country.max || countryCode.length - 1 + value.length > 15) return '';
      if (countryCode === '+86' && !/^1[3-9][0-9]{9}$/.test(value)) return '';
      return value;
    }
    return '';
  }

  function privateIPv4(value) {
    var match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || ''));
    if (!match) return false;
    var a = Number(match[1]), b = Number(match[2]), c = Number(match[3]), d = Number(match[4]);
    if ([a, b, c, d].some(function (part) { return part < 0 || part > 255; })) return false;
    return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
  }

  function defaultLANAddress() {
    var interfaces = os.networkInterfaces();
    var names = Object.keys(interfaces).sort(function (left, right) {
      function rank(name) {
        if (/^(en0|wlan0|wifi0|eth0)$/i.test(name)) return 0;
        if (/wlan|wifi|en|eth/i.test(name)) return 1;
        return 2;
      }
      return rank(left) - rank(right) || left.localeCompare(right);
    });
    var i, j;
    for (i = 0; i < names.length; i++) {
      var rows = interfaces[names[i]] || [];
      for (j = 0; j < rows.length; j++) {
        var family = rows[j].family;
        if (!rows[j].internal && (family === 'IPv4' || family === 4) && privateIPv4(rows[j].address)) return rows[j].address;
      }
    }
    throw fail('未找到局域网连接，可继续使用电视上的输入方式', 503, 'LAN_ADDRESS_UNAVAILABLE');
  }

  function makeQR(value) {
    var qr = new QRCode(0, QRErrorCorrectLevel.M);
    qr.addData(value);
    qr.make();
    var count = qr.getModuleCount();
    var margin = 4;
    var modules = count + margin * 2;
    var commands = [];
    var row, col;
    for (row = 0; row < count; row++) {
      for (col = 0; col < count; col++) {
        if (qr.isDark(row, col)) commands.push('M' + (col + margin) + ' ' + (row + margin) + 'h1v1h-1z');
      }
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 ' + modules + ' ' + modules + '"><path fill="#fff" d="M0 0h' + modules + 'v' + modules + 'H0z"/><path fill="#000" d="' + commands.join('') + '"/></svg>';
    return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function page(session, state, message) {
    var isExpired = state === 'expired';
    var isComplete = state === 'complete';
    var isText = session.kind === 'search' || session.kind === 'danmaku';
    var title = isExpired ? '输入已结束' : isComplete ? '已发送到电视' : session.kind === 'search' ? '输入剧名或关键词' : session.kind === 'danmaku' ? '输入弹幕' : session.kind === 'phone' ? '输入手机号（' + session.countryCode + '）' : '输入验证码';
    var description = isExpired ? '请在电视上重新打开扫码输入，再扫描新的二维码。' : isComplete ? session.kind === 'search' ? '请回到电视查看搜索结果。' : session.kind === 'danmaku' ? '弹幕内容已回到电视，请确认无误后发送。' : '请回到电视继续操作。此页面不会发送短信或登录账号。' : session.kind === 'search' ? '输入或粘贴剧名，发送后在电视上搜索。' : session.kind === 'danmaku' ? '输入或粘贴弹幕，完成后回填电视。' : '填写或粘贴数字，点击完成后回填电视。';
    var label = session.kind === 'search' ? '剧名 / 关键词' : session.kind === 'danmaku' ? '弹幕内容' : session.kind === 'phone' ? '手机号（' + session.countryCode + '）' : '短信验证码';
    var inputType = isText ? 'text' : 'tel';
    var maxLength = session.kind === 'phone' ? PHONE_COUNTRIES[session.countryCode].max : session.kind === 'code' ? 8 : MAX_TEXT;
    var pattern = session.kind === 'phone' && session.countryCode === '+86' ? ' pattern="1[3-9][0-9]{9}"' : session.kind === 'code' ? ' pattern="[0-9]{4,8}"' : '';
    var hint = session.kind === 'search' ? '正常完成的搜索会保存在电视的最近搜索中。' : session.kind === 'danmaku' ? '内容只回填到当前弹幕输入框，不会自动发送。' : '数字仅用于本次输入，不会保存。';
    var form = !isExpired && !isComplete ? '<form method="post" action="/input/' + escapeHTML(session.id) + '" autocomplete="off"><input type="hidden" name="form_key" value="' + escapeHTML(session.formKey) + '"><label for="value">' + escapeHTML(label) + '</label><input id="value" name="value" type="' + inputType + '" inputmode="' + (isText ? 'text' : 'numeric') + '" autocomplete="off" required maxlength="' + maxLength + '"' + pattern + '><button type="submit">' + (session.kind === 'search' ? '发送并搜索' : session.kind === 'danmaku' ? '弹幕回填电视' : '完成，回填电视') + '</button></form><p class="hint">手机和电视需在同一局域网。二维码5分钟有效，电视关闭输入后立即失效。' + hint + '</p>' : '';
    var error = message ? '<p class="error">' + escapeHTML(message) + '</p>' : '';
    var content = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>红果短剧 · 手机输入</title><style>body{margin:0;background:#15151e;color:#fff;font:17px/1.6 sans-serif;padding:24px;box-sizing:border-box}main{max-width:420px;margin:40px auto}h1{font-size:26px}p{color:#c2c3ce}input,button{display:block;width:100%;box-sizing:border-box;padding:14px;margin:18px 0;font:inherit;border-radius:10px}input{background:#252631;color:#fff;border:2px solid #737586;font-size:24px}input[type=hidden]{display:none}button{background:#c73555;color:#fff;border:0}.error{color:#ffadb8}.hint{font-size:14px}</style></head><body><main><h1>' + title + '</h1><p>' + description + '</p>' + error + form + '</main></body></html>';
    return content;
  }

  function create(options) {
    options = options || {};
    var active = null;
    var closed = false;
    var selectIP = options.selectIP || defaultLANAddress;
    var ttl = Number(options.ttl) > 0 ? Number(options.ttl) : TTL_MS;
    var now = options.now || Date.now;

    function stopActive() {
      var previous = active;
      active = null;
      if (!previous) return;
      if (previous.timer) clearTimeout(previous.timer);
      previous.value = '';
      previous.formKey = '';
      if (previous.server) {
        try { previous.server.close(); } catch (ignored) {}
      }
    }

    function start(kind, countryCode) {
      return new Promise(function (resolve, reject) {
        if (closed || ['phone', 'code', 'search', 'danmaku'].indexOf(kind) < 0) return reject(fail('输入会话不可用', 400, 'NUMBER_INPUT_KIND'));
        countryCode = String(countryCode || '+86');
        if (kind === 'phone' && !PHONE_COUNTRIES[countryCode]) return reject(fail('暂不支持该国家或地区的手机号', 400, 'NUMBER_INPUT_COUNTRY'));
        stopActive();
        var ip;
        try { ip = selectIP(); } catch (error) { reject(error); return; }
        if (!privateIPv4(ip) && ip !== '127.0.0.1') return reject(fail('未找到局域网连接，可继续使用电视上的输入方式', 503, 'LAN_ADDRESS_UNAVAILABLE'));
        var session = {
          id: crypto.randomBytes(32).toString('hex'),
          formKey: crypto.randomBytes(32).toString('hex'),
          kind: kind,
          countryCode: countryCode,
          expires: now() + ttl,
          value: '',
          completed: false,
          server: null,
          host: '',
          timer: null
        };
        var server = http.createServer(function (req, res) { handleMobile(session, req, res); });
        session.server = server;
        server.once('error', function (error) {
          if (active === session) stopActive();
          reject(fail('扫码输入暂不可用，可继续使用电视上的输入方式', 503, error.code || 'NUMBER_INPUT_LISTEN'));
        });
        server.listen(0, ip, function () {
          if (closed) { try { server.close(); } catch (ignoredClosed) {} reject(fail('输入会话不可用', 503, 'NUMBER_INPUT_CLOSED')); return; }
          var address = server.address();
          session.host = ip + ':' + address.port;
          active = session;
          session.timer = setTimeout(function () { if (active === session) stopActive(); }, ttl);
          var qr;
          try { qr = makeQR('http://' + session.host + '/input/' + session.id); }
          catch (error) { stopActive(); reject(fail('无法生成输入二维码', 503, 'NUMBER_INPUT_QR')); return; }
          resolve({ session: session.id, kind: kind, state: 'waiting', qr: qr, expires_in: Math.ceil(ttl / 1000) });
        });
      });
    }

    function isAllowedRemote(remote) {
      if (remote === '::1' || remote === '::ffff:127.0.0.1') return true;
      if (remote && remote.indexOf('::ffff:') === 0) remote = remote.slice(7);
      return remote === '127.0.0.1' || privateIPv4(remote);
    }

    function handleMobile(session, req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      var remote = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (!isAllowedRemote(remote) || req.headers.host !== session.host || req.url !== '/input/' + session.id) return notFound(res);
      if (req.method !== 'GET' && req.method !== 'POST') { res.statusCode = 405; return res.end(); }
      var origin = req.headers.origin;
      if (origin && origin !== 'null' && origin !== 'http://' + session.host || req.headers['sec-fetch-site'] === 'cross-site' && req.method === 'POST') { res.statusCode = 403; return res.end(); }
      if (active !== session || session.completed || now() >= session.expires) return sendPage(res, 410, page(session, 'expired'));
      if (req.method === 'GET') return sendPage(res, 200, page(session, 'form'));
      var contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (contentType.indexOf('application/x-www-form-urlencoded') !== 0) { res.statusCode = 415; return res.end(); }
      var chunks = [], total = 0, rejected = false;
      req.on('data', function (chunk) {
        total += chunk.length;
        if (total > 4096) { rejected = true; chunks = []; res.statusCode = 413; req.destroy(); }
        else chunks.push(chunk);
      });
      req.on('error', function () {});
      req.on('end', function () {
        if (rejected) return;
        var form = querystring.parse(Buffer.concat(chunks).toString('utf8'));
        if (Object.keys(form).length !== 2 || Array.isArray(form.form_key) || Array.isArray(form.value) || form.form_key !== session.formKey) { res.statusCode = 403; return res.end(); }
        var value = normalizeValue(session.kind, form.value, session.countryCode);
        if (!value) return sendPage(res, 400, page(session, 'form', session.kind === 'search' ? '请输入不超过100字的剧名或关键词' : session.kind === 'danmaku' ? '请输入不超过100字的弹幕' : session.kind === 'phone' ? '请填写正确的手机号' : '请填写4到8位验证码'));
        session.value = value;
        session.completed = true;
        sendPage(res, 200, page(session, 'complete'));
      });
    }

    function notFound(res) { res.statusCode = 404; res.end(); }
    function sendPage(res, status, body) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
    }

    function poll(id, cancel) {
      var session = active;
      if (!session || !id || id !== session.id) return { state: 'expired' };
      if (cancel || now() >= session.expires) { stopActive(); return { state: 'expired' }; }
      if (session.completed) {
        var result = { state: 'completed', kind: session.kind, value: session.value };
        stopActive();
        return result;
      }
      return { state: 'waiting', kind: session.kind };
    }

    return {
      start: start,
      poll: poll,
      close: function () { closed = true; stopActive(); },
      _active: function () { return active; }
    };
  }

  create.searchHelpers = { privateIPv4: privateIPv4, selectIP: defaultLANAddress, makeQR: makeQR };
  module.exports = create;
}());
