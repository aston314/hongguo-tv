// webOS account/session adapter.  This is intentionally self-contained so the
// service can run on the older Node runtime shipped by LG webOS.
(function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  var crypto = require('crypto');
  var zlib = require('zlib');
  var http = require('http');
  var https = require('https');
  var url = require('url');
  var querystring = require('querystring');
  var sign = require('./passport-sign');
  var createScan = require('./account-scan');

  var API_BASE = 'https://api5-normal-lq.fqnovel.com';
  var DEVICE_BASE = 'https://log.snssdk.com';
  var UA = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
  var COUNTRY = {
    '+86': { name: '中国大陆', min: 11, max: 11 }, '+852': { name: '中国香港', min: 8, max: 8 },
    '+853': { name: '中国澳门', min: 8, max: 8 }, '+886': { name: '中国台湾', min: 9, max: 10 },
    '+60': { name: '马来西亚', min: 9, max: 10 }, '+65': { name: '新加坡', min: 8, max: 8 },
    '+62': { name: '印度尼西亚', min: 10, max: 13 }, '+95': { name: '缅甸', min: 9, max: 10 },
    '+63': { name: '菲律宾', min: 7, max: 10 }, '+84': { name: '越南', min: 9, max: 10 },
    '+855': { name: '柬埔寨', min: 8, max: 9 }, '+81': { name: '日本', min: 9, max: 11 },
    '+82': { name: '韩国', min: 8, max: 11 }, '+971': { name: '阿拉伯联合酋长国', min: 9, max: 9 }
  };

  function mkdirp(directory, mode) {
    try { fs.mkdirSync(directory, mode); }
    catch (error) {
      if (error.code === 'EEXIST') { if (!fs.statSync(directory).isDirectory()) throw error; return; }
      if (error.code !== 'ENOENT') throw error;
      var parent = path.dirname(directory);
      if (parent === directory) throw error;
      mkdirp(parent, mode);
      fs.mkdirSync(directory, mode);
    }
  }
  function trim(v) { return String(v == null ? '' : v).replace(/^\s+|\s+$/g, ''); }
  function str(v) { return v == null ? '' : String(v); }
  function validID(v) { return /^[0-9]{1,32}$/.test(trim(v)); }
  function fail(message, status, code) { var e = new Error(message); e.status = status || 502; e.code = code || 'ACCOUNT_ERROR'; return e; }
  function asMap(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function dataOf(p) { return asMap(p && p.data); }
  function errorCode(p) { var d = dataOf(p); return str(d.error_code || p && p.error_code); }
  function success(p) { var code = errorCode(p); return (!code || code === '0') && str(p && p.message) === 'success'; }
  function safeDescription(p) { var d = dataOf(p); var text = str(d.description || p && p.description); if (!text || /https?:\/\//i.test(text) || /\d{7,}/.test(text) || text.length > 120) text = '红果未提供具体失败原因'; return text + (errorCode(p) ? '（' + errorCode(p) + '）' : ''); }
  function rawNumber(value) { value = str(value); if (!/^\d{1,32}$/.test(value)) throw fail('请求 ID 无效', 400, 'ACCOUNT_ID'); return { __rawNumber: value }; }
  function stringifyExact(value) { return JSON.stringify(value, function (key, item) { if (item && item.__rawNumber) return '\u0000HGNUM' + item.__rawNumber + '\u0000'; return item; }).replace(/"\\u0000HGNUM([0-9]+)\\u0000"/g, '$1'); }
  function parseExactJSON(text) {
    var out = '', inString = false, escaped = false, i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (inString) {
        out += ch;
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        i++;
        continue;
      }
      if (ch === '"') { inString = true; out += ch; i++; continue; }
      if (ch === '-' || ch >= '0' && ch <= '9') {
        var start = i;
        while (i < text.length && /[0-9eE+.-]/.test(text.charAt(i))) i++;
        var token = text.slice(start, i);
        out += /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token;
        continue;
      }
      out += ch; i++;
    }
    return JSON.parse(out);
  }
  function requestBuffer(target, method, headers, body, limit) {
    return new Promise(function (resolve, reject) {
      var parsed = url.parse(target); var transport = parsed.protocol === 'http:' ? http : https;
      var req;
      try { req = transport.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443), path: parsed.path, method: method || 'GET', headers: headers || {}, timeout: 30000 }); } catch (e) { reject(e); return; }
      var done = false, chunks = [], total = 0;
      function finish(err, value) { if (done) return; done = true; if (err) reject(err); else resolve(value); }
      req.on('timeout', function () { req.destroy(); finish(fail('红果账号服务连接超时', 504, 'ACCOUNT_TIMEOUT')); });
      req.on('error', function (e) { finish(e.code === 'ECONNRESET' ? fail('红果账号服务连接失败，请稍后重试', 502, 'ACCOUNT_NETWORK') : e); });
      req.on('response', function (res) {
        res.on('data', function (chunk) { total += chunk.length; if (limit && total > limit) { req.destroy(); finish(fail('红果账号响应过大', 502, 'ACCOUNT_RESPONSE')); return; } chunks.push(chunk); });
        res.on('end', function () { finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      });
      if (body && body.length) req.write(body); req.end();
    });
  }
  function parseJSON(response) {
    if (response.status < 200 || response.status >= 300) throw fail('红果账号服务返回 HTTP ' + response.status, response.status, 'ACCOUNT_HTTP');
    var text = response.body.toString('utf8'); if (!trim(text)) throw fail('红果账号返回空响应', 502, 'ACCOUNT_RESPONSE');
    try { return parseExactJSON(text); } catch (e) { throw fail('红果账号响应不是有效 JSON', 502, 'ACCOUNT_RESPONSE'); }
  }
  function randomID() { var bytes = crypto.randomBytes(16), out = ''; for (var i = 0; i < bytes.length; i++) out += String(bytes[i] % 10); return '1' + out.slice(1, 16); }
  function uuid() { var b = crypto.randomBytes(16); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; return b.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'); }
  function device() { return { cdid: uuid(), clientudid: uuid(), openudid: crypto.randomBytes(8).toString('hex'), created: Date.now() }; }
  function appQuery(s) {
    var q = { ac: 'wifi', aid: '8662', app_name: 'novelread', channel: 'update_64', device_brand: 'Redmi', device_id: s.device_id, device_platform: 'android', device_type: '25053RT47C', dpi: '520', iid: s.install_id, language: 'zh', manifest_version_code: '73532', os: 'android', os_api: '36', os_version: '16', resolution: '1280*2772', ssmix: 'a', update_version_code: '73532', version_code: '73532', version_name: '7.3.5.32' };
    if (s.device) { q.cdid = s.device.cdid; q.openudid = s.device.openudid; }
    return q;
  }
  function sortedQuery(values) { return Object.keys(values).sort().map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key])); }).join('&'); }
  function le32(n) { var b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
  function protocolDevicePayload(d, stamp) {
    var h = { aid: 8662, access: 'wifi', app_version: '7.3.5.32', app_version_minor: '', channel: 'update_64', device_brand: 'Redmi', device_manufacturer: 'Redmi', device_model: '25053RT47C', device_category: 'phone', device_platform: 'android', os: 'Android', os_api: 36, os_version: '16', density_dpi: 520, display_density: 'xxxhdpi', resolution: '2772x1280', language: 'zh', timezone: 8, tz_name: 'Asia/Shanghai', tz_offset: 28800, region: 'CN', package: 'com.phoenix.read', version_code: 73532, manifest_version_code: 73532, update_version_code: 73532, apk_first_install_time: d.created, cdid: d.cdid, clientudid: d.clientudid, openudid: d.openudid, cpu_abi: 'arm64-v8a', display_name: '红果短剧', sdk_version: '3.7.2', sdk_target_version: 29, sdk_flavor: 'china', guest_mode: 0, is_system_app: 0, not_request_sender: 0, oaid_may_support: true, ipv6_list: [], sim_serial_number: [], custom: { is_android_fold: 0, filter_warn: 0, web_ua: '', is_android_pad: 0, client_ipv4: '' } };
    return Buffer.from(JSON.stringify({ magic_tag: 'ss_app_log', header: h, _gen_time: stamp }));
  }
  function deviceKey(seed) { var h = crypto.createHash('sha512').update(seed).digest(); return crypto.createHash('sha512').update(Buffer.concat([h, Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex')])).digest(); }
  function ttEncrypt(plain, seed) {
    var zipped = zlib.gzipSync(plain, { level: 9 }); Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0]).copy(zipped, 0);
    var hash = crypto.createHash('sha512').update(zipped).digest(); var p = Buffer.concat([hash, zipped]); var pad = 16 - (p.length % 16); p = Buffer.concat([p, Buffer.alloc(pad, pad)]); var key = deviceKey(seed); var cipher = crypto.createCipheriv('aes-128-cbc', key.slice(0, 16), key.slice(16, 32)); cipher.setAutoPadding(false); return Buffer.concat([Buffer.from([0x74, 0x63, 5, 0x10, 0, 0]), seed, cipher.update(p), cipher.final()]);
  }
  function ttDecrypt(input) {
    if (input.length < 118 || input[0] !== 0x74 || input[1] !== 0x63 || (input.length - 38) % 16) throw fail('设备注册响应无效', 502, 'ACCOUNT_DEVICE');
    var seed = input.slice(6, 38), key = deviceKey(seed), decipher = crypto.createDecipheriv('aes-128-cbc', key.slice(0, 16), key.slice(16, 32)); decipher.setAutoPadding(false); var p = Buffer.concat([decipher.update(input.slice(38)), decipher.final()]); var pad = p[p.length - 1]; if (pad < 1 || pad > 16) throw fail('设备注册响应无效', 502, 'ACCOUNT_DEVICE'); p = p.slice(0, p.length - pad); if (p.length < 64) throw fail('设备注册响应无效', 502, 'ACCOUNT_DEVICE'); var hash = crypto.createHash('sha512').update(p.slice(64)).digest(); if (!hash.equals(p.slice(0, 64))) throw fail('设备注册响应校验失败', 502, 'ACCOUNT_DEVICE'); return zlib.gunzipSync(p.slice(64));
  }
  function updateCookies(cookies, headers) {
    cookies = cookies || {};
    (headers && headers['set-cookie'] || []).forEach(function (line) {
      var match = /^([^=;]+)=([^;]*)/.exec(line);
      if (!match || !/^[A-Za-z0-9_-]{1,80}$/.test(match[1])) return;
      var attributes = line.slice(match[0].length).toLowerCase();
      if (/;\s*max-age\s*=\s*0(?:;|$)/.test(attributes) || /;\s*expires\s*=\s*thu, 01 jan 1970/i.test(attributes)) delete cookies[match[1]];
      else cookies[match[1]] = match[2];
    });
    return cookies;
  }
  function register(s, sendRequest, save) {
    if (s.registered && validID(s.device_id) && validID(s.install_id)) return Promise.resolve(s);
    var now = Date.now(), ts = Math.floor(now / 1000), seed = crypto.randomBytes(32), body = ttEncrypt(protocolDevicePayload(s.device, now), seed), q = appQuery(s); delete q.device_id; delete q.iid; q.tt_data = 'a'; q.ts = String(ts); q._rticket = String(now); q.package = 'com.phoenix.read'; var query = sortedQuery(q); var nonce = crypto.randomBytes(2).readUInt16LE(0); var headers = { 'User-Agent': UA, 'Content-Type': 'application/octet-stream;tt-data=a', Accept: 'application/json; charset=utf-8,application/x-protobuf', 'Content-Encoding': 'gzip', 'X-Tt-Request-Tag': 't=0;n=1', 'Log-Encode-Type': 'gzip', Lc: '102', 'Sdk-Version': '2', 'Passport-Sdk-Version': '60755', 'Passport-Sdk-Settings': 'device_transfer_s_0,device_transfer_ab_1', 'X-SS-DP': '8662', 'X-Vc-Bdturing-Sdk-Version': '4.0.3.cn', 'X-Tt-Store-Region': 'cn', 'X-Tt-Store-Region-Src': 'did', 'X-Khronos': String(ts), 'X-Argus': le32(ts).toString('base64'), 'X-SS-Req-Ticket': String(now), 'X-SS-STUB': crypto.createHash('md5').update(body).digest('hex'), 'X-Gorgon': sign.gorgon(query, body, ts, nonce) };
    return sendRequest(DEVICE_BASE + '/service/2/device_register/?' + query, 'POST', headers, body, 4 * 1024 * 1024).then(function (response) { if (response.status < 200 || response.status >= 300) throw fail('设备注册连接失败（HTTP ' + response.status + '）', response.status, 'ACCOUNT_DEVICE'); var bytes = response.body; if (bytes.slice(0, 6).equals(Buffer.from([0x74, 0x63, 5, 0x10, 0, 0]))) bytes = ttDecrypt(bytes); var p; try { p = parseExactJSON(bytes.toString('utf8')); } catch (e) { throw fail('设备注册响应无效', 502, 'ACCOUNT_DEVICE'); } var did = str(p.device_id_str || p.device_id), iid = str(p.install_id_str || p.install_id); if (!validID(did) || !validID(iid) || did === '0' || iid === '0') throw fail('设备注册未返回有效身份', 502, 'ACCOUNT_DEVICE'); s.device_id = did; s.install_id = iid; s.registered = true; s.cookies = updateCookies(s.cookies, response.headers); s.cookies.install_id = iid; if (save) save(); return s; });
  }
  function wirePhone(phone) {
    var p = splitPhone(str(phone)), country = COUNTRY[p.code], local = p.local, widths = [];
    if (!country) return str(phone);
    if (country.max === 10) widths = [3, 4, 3];
    else if (country.max === 11) widths = [3, 4, 4];
    else {
      var width = country.max % 4 === 0 ? 4 : 3;
      while (local.length) { widths.push(Math.min(width, local.length)); local = local.slice(Math.min(width, local.length)); }
      local = p.local;
    }
    var groups = [];
    widths.forEach(function (width) { if (local.length) { groups.push(local.slice(0, width)); local = local.slice(width); } });
    if (local.length) groups.push(local);
    return p.code + groups.join(' ');
  }
  function xorHex(text) { var b = Buffer.from(text); for (var i = 0; i < b.length; i++) b[i] ^= 5; return b.toString('hex'); }
  function canonical(country, local) { country = trim(country || '+86'); if (country.charAt(0) !== '+') country = '+' + country; var c = COUNTRY[country]; local = trim(local); if (!c || !/^\d+$/.test(local) || local.length < c.min || local.length > c.max || country === '+86' && !/^1[3-9]\d{9}$/.test(local)) throw fail(c ? '请输入正确的' + c.name + '手机号' : '暂不支持该国家或地区的手机号', 400, 'ACCOUNT_PHONE'); return country + local; }
  function splitPhone(phone) { var codes = Object.keys(COUNTRY).sort(function (a, b) { return b.length - a.length; }); for (var i = 0; i < codes.length; i++) if (phone.indexOf(codes[i]) === 0) return { code: codes[i], local: phone.slice(codes[i].length) }; return { code: '+86', local: phone }; }
  function mask(phone) { var p = splitPhone(phone), v = p.local; return p.code + (v.length > 4 ? v.slice(0, 2) + '****' + v.slice(-2) : '****'); }
  function normalizeDrama(raw) { var m = asMap(raw); if (m.video_data && typeof m.video_data === 'object') m = asMap(m.video_data); if (m.common) { var merged = Object.assign({}, asMap(m.common), asMap(m.expand), asMap(asMap(m.expand).extra), asMap(asMap(m.expand).update_info)); if (!merged.series_id && !merged.book_id) merged.series_id = m.video_id || m.video_id_str; m = merged; } var id = str(m.series_id_str || m.series_id || m.book_id || m.book_id_str || m.video_id || m.video_id_str || m.id); var title = str(m.series_title || m.series_name || m.book_name || m.title || m.name); if (!validID(id) || !title) return null; return { series_id: id, title: title, cover: str(m.series_cover || m.book_cover || m.cover || m.thumb_url || m.thumb), intro: str(m.series_intro || m.book_intro || m.intro || m.abstract), episode_count: Number(m.episode_cnt || m.episode_count || m.video_count || 0), vid: str(m.vid || m.first_vid || ''), season_index: Number(m.season_index || 0), multi_season: !!m.is_multi_season, followed: !!(m.followed || m.has_subscribed || m.following_update), following_update: !!(m.following_update || m.followed), latest_watched_episode: Number(m.latest_watched_index || m.latest_watched_vid_index || 0), follow_update_time: Number(m.follow_update_time || m.update_time || 0), tags: Array.isArray(m.categories) ? m.categories.map(String) : [] }; }
  function feedDramas(cells) {
    var items = [];
    function append(detail, disabled) {
      if (disabled) return;
      var item = normalizeDrama(detail);
      if (!item || item.episode_count < 1) return;
      item.vid = str(detail && detail.first_vid || item.vid);
      items.push(item);
    }
    function walk(rows) {
      (Array.isArray(rows) ? rows : []).forEach(function (cell) {
        if (!cell || typeof cell !== 'object') return;
        if (cell.video_detail) append(cell.video_detail, cell.disable_play === true || cell.disable_play === 1);
        (Array.isArray(cell.video_data) ? cell.video_data : []).forEach(function (video) {
          if (video && video.video_detail) append(video.video_detail, video.disable_play === true || video.disable_play === 1);
        });
        walk(cell.cell_data);
      });
    }
    walk(cells);
    return items;
  }
  function normalizeReservation(raw) { var x = asMap(raw), sub = asMap(x.subscribe_data), drama = normalizeDrama(sub), id = str(x.item_id); if (!drama) { var title = str(x.name || x.item_name); if (!validID(id) || !title) return null; drama = { series_id: id, title: title, cover: str(x.cover), intro: str(x.item_desc), episode_count: 0, tags: [] }; } drama.reservation_id = validID(id) ? id : ''; drama.upcoming = !(x.is_online === true || x.is_online === 1 || x.is_online === '1'); drama.reserved = !!(x.has_subscribed || x.reserved); drama.publish_time = Number(x.schedule_publish_time || x.expected_publish_time || 0); drama.publish_text = str(x.sub_info || x.expected_rec_text); return drama; }
  function formPhone(phone) { return xorHex(wirePhone(phone)); }
  function passportForm(phone) { return { mobile: formPhone(phone), account_sdk_source: 'app', passport_support_flow: 'captcha,verify', mix_mode: '1' }; }
  function encodeForm(values) { return querystring.stringify(values); }
  function Client(state, save, sendRequest) { this.s = state; this.save = save; this.sendRequest = sendRequest || requestBuffer; if (this.s.registered) { this.s.cookies = this.s.cookies || {}; this.s.cookies.install_id = this.s.install_id; } }
  Client.prototype.request = function (pathname, method, values, body, international) {
    var self = this; return register(self.s, self.sendRequest, self.save).then(function () {
      var q = appQuery(self.s); Object.keys(values || {}).forEach(function (k) { q[k] = String(values[k]); }); var raw = body ? Buffer.from(typeof body === 'string' ? body : stringifyExact(body)) : Buffer.alloc(0); var stamp = Date.now(); q._rticket = String(stamp); var foreign = !!international; var signed = foreign && sign.signInternational ? sign.signInternational(q, raw, stamp) : sign.sign(q, raw, stamp, self.s.device_id); var headers = Object.assign({}, signed.headers, { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'identity', 'X-XS-From-Web': '0', 'Sdk-Version': '2', 'Passport-Sdk-Version': pathname.indexOf('/passport/') === 0 ? '5051452' : '6031190', 'X-SS-DP': '8662', 'X-Tt-Store-Region': (self.s.cookies || {})['store-region'] || 'cn', 'X-Tt-Store-Region-Src': 'did' }); if (pathname.indexOf('/passport/') === 0) { headers['X-Vc-Bdturing-Sdk-Version'] = '4.0.3.cn'; headers.Lc = '101'; } if (self.s.token) headers['X-Tt-Token'] = self.s.token; var cookies = self.s.cookies || {}; headers.Cookie = Object.keys(cookies).map(function (k) { return k + '=' + cookies[k]; }).join('; '); if (raw.length) { headers['Content-Type'] = body && typeof body === 'string' ? 'application/x-www-form-urlencoded; charset=UTF-8' : 'application/json; charset=utf-8'; headers['Content-Length'] = raw.length; }
      return self.sendRequest(API_BASE + pathname + '?' + signed.query, method || 'GET', headers, raw, 4 * 1024 * 1024).then(function (response) { var p = parseJSON(response); updateCookies(self.s.cookies, response.headers); if (response.headers && response.headers['x-tt-token']) self.s.token = response.headers['x-tt-token']; self.save(); return p; });
    });
  };
  Client.prototype.loginRequest = function (pathname, phone, form) { var p = splitPhone(phone); return this.request(pathname, 'POST', {}, encodeForm(form), p.code !== '+86'); };
  function Account(options) {
    options = options || {}; this.dir = options.dataDir || process.env.HONGGUO_WEBOS_DATA_DIR || path.join(process.cwd(), 'data'); mkdirp(this.dir, 448); this.file = path.join(this.dir, 'account.json'); this.state = this.load(); this.save = this.save.bind(this); this.requestBuffer = options.requestBuffer || requestBuffer; this.login = null; this.generation = 0; this.syncing = false; this.syncPromise = null; this.libraryRevision = 0; this.syncError = '';
    this.attachClient();
    var self = this;
    this.scan = createScan({ requestBuffer: options.qrRequestBuffer || options.requestBuffer, parseJSON: parseExactJSON,
      pollInterval: options.qrPollInterval, requestTimeout: options.qrRequestTimeout, completionTimeout: options.qrCompletionTimeout,
      finish: function (profile, cookies, control) {
        var generation = self.generation;
        var session = { device_id: randomID(), install_id: randomID(), device: device(), cookies: {} };
        return register(session, control.request).then(function () {
          if (!control.current() || generation !== self.generation || self.state.profile) throw fail('登录已取消', 409, 'ACCOUNT_CHANGED');
          Object.keys(cookies).forEach(function (key) { if (key !== 'install_id') session.cookies[key] = cookies[key]; });
          self.commitLogin(session, profile, 'qr');
        });
      }
    });
  }
  Account.prototype.load = function () { var value; try { value = parseExactJSON(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e && e.code !== 'ENOENT') throw fail('账号信息文件无效，未覆盖原记录', 500, 'ACCOUNT_STORAGE'); } if (!value) value = { version: 1, session: { device_id: randomID(), install_id: randomID(), device: device(), cookies: {} } }; if (value.version !== 1 || !value.session) throw fail('账号信息文件无效，未覆盖原记录', 500, 'ACCOUNT_STORAGE'); value.session.cookies = value.session.cookies || {}; if (!value.session.device) value.session.device = device(); if (value.profile && (!validID(value.profile.uid) || value.profile.uid === '0')) throw fail('账号身份无效，未覆盖原记录', 500, 'ACCOUNT_STORAGE'); return value; };
  Account.prototype.writeState = function (state) { var temp = this.file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(state), { mode: 384 }); fs.renameSync(temp, this.file); };
  Account.prototype.save = function () { this.writeState(this.state); };
  Account.prototype.attachClient = function () {
    var self = this, session = this.state.session;
    this.client = new Client(session, function () { if (self.state.session === session) self.save(); }, this.requestBuffer);
  };
  Account.prototype.invalidateLogin = function () {
    this.generation++;
    if (this.scan) this.scan.reset();
    this.login = null;
    this.syncPromise = null; this.syncing = false;
    // Detach outstanding phone requests before another login method takes over.
    this.state.session = JSON.parse(JSON.stringify(this.state.session)); this.attachClient();
  };
  Account.prototype.checkLogin = function (generation) {
    if (generation !== this.generation || this.state.profile) throw fail('登录已取消', 409, 'ACCOUNT_CHANGED');
  };
  Account.prototype.commitLogin = function (session, profile, method) {
    loadLibraryFile(path.join(this.dir, 'accounts', profile.uid, 'library.json'), profile.uid);
    var next = { version: 1, session: session, profile: profile, login_method: method };
    this.writeState(next); this.state = next; this.attachClient(); this.login = null; this.syncError = '';
    var self = this, generation = this.generation;
    setTimeout(function () { if (self.generation === generation && self.state === next) self.sync().catch(function () {}); }, 0);
  };
  Account.prototype.startQR = function () {
    if (this.state.profile) throw fail('请先退出当前账号', 409, 'ACCOUNT_CHANGED');
    this.invalidateLogin(); this.scan.start(); return this.status();
  };
  Account.prototype.qrStatus = function (id) {
    var qr = this.scan.snapshot();
    if (!qr || qr.id !== id) throw fail('扫码会话已失效', 409, 'ACCOUNT_QR');
    return this.status();
  };
  Account.prototype.cancelQR = function (id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw fail('扫码会话无效', 400, 'ACCOUNT_QR');
    var qr = this.scan.snapshot();
    if (!this.state.profile && qr && qr.id === id) { this.generation++; this.scan.cancel(id); }
    return this.status();
  };
  Account.prototype.close = function () { this.generation++; this.scan.cancel(); };
  Account.prototype.status = function () { var s = this.state, l = this.login, guest = this.readGuestLibrary(), local = s.profile ? this.library() : null, pending = local && local.cloud && Array.isArray(local.cloud.pending) ? local.cloud.pending.length : 0, latest = {}, available = 0; (guest.entries || []).forEach(function (e) { var id = str(e.drama && e.drama.series_id); if (!e.last_played_at || !validID(id) || !validID(str(e.video_id)) || Number(e.episode) < 1) return; latest[id] = Math.max(latest[id] || 0, Number(e.last_played_at)); }); if (s.profile) Object.keys(latest).forEach(function (id) { var own = (local.entries || []).filter(function (e) { return str(e.drama && e.drama.series_id) === id; })[0], hidden = local.cloud && local.cloud.hidden || {}; if ((!own || Number(own.last_played_at) < latest[id]) && !(hidden['history:' + id] >= latest[id])) available++; }); return { qr_login_available: true, qr_login: this.scan ? this.scan.snapshot() : null, login_method: s.profile ? s.login_method || 'phone' : '', logged_in: !!s.profile, profile: s.profile || null, phase: s.profile ? 'logged_in' : this.scan && this.scan.snapshot() && ['preparing', 'pending', 'scanned', 'processing'].indexOf(this.scan.snapshot().state) >= 0 ? 'qr' : l && l.mfa ? 'mfa' : l ? 'code' : 'phone', phone: l ? mask(l.phone) : '', country_code: l ? splitPhone(l.phone).code : '', retry_after: l && l.retry_after > Date.now() ? Math.ceil((l.retry_after - Date.now()) / 1000) : 0, sms_state: l && l.sms_state || '', sms_number: l && l.mfa && l.mfa.channel_mobile || '', sms_content: l && l.mfa && l.mfa.sms_content || '', mfa_expires_at: l && l.mfa_expires || 0, error: l && l.error || '', app_code_available: !!(l && l.app_code_available), sync: { state: !s.profile ? 'signed_out' : this.syncing ? 'syncing' : this.syncError ? 'error' : pending ? 'pending' : 'idle', pending: pending, last_sync: local && local.cloud && local.cloud.last_sync || 0, error: this.syncError || local && local.cloud && local.cloud.sync_error || '' }, guest_history: { total: Object.keys(latest).length, available: available }, capabilities: ['browse', 'search', 'play', 'local-library', 'account-login', 'account-mfa', 'follow', 'reservations', 'notifications', 'player-actions', 'cloud-library'] }; };
  Account.prototype.sendCode = function (country, local) {
    var self = this, phone = canonical(country, local);
    self.checkLogin(self.generation); self.invalidateLogin();
    var generation = self.generation, client = self.client;
    var login = { phone: phone, sms_state: 'uncertain', app_code_available: true, retry_after: 0 }; self.login = login;
    return client.loginRequest('/passport/mobile/send_code/v1/', phone, Object.assign(passportForm(phone), { auto_read: '0', unbind_exist: '34', type: xorHex('24') })).then(function (p) {
      self.checkLogin(generation);
      if (!success(p)) throw fail(safeDescription(p), 400, 'ACCOUNT_SEND_CODE');
      login.sms_state = 'sent'; login.app_code_available = false; login.retry_after = Date.now() + Math.max(60000, Number(dataOf(p).retry_time || 0) * 1000); self.save(); return self.status();
    }).catch(function (e) {
      self.checkLogin(generation); login.sms_state = 'rejected'; login.error = e.message; login.app_code_available = true; self.save(); throw e;
    });
  };
  Account.prototype.loginSMS = function (country, local, code) {
    var self = this, phone = canonical(country, local);
    if (!/^\d{4,8}$/.test(str(code))) return Promise.reject(fail('请输入手机号和验证码', 400, 'ACCOUNT_CODE'));
    self.checkLogin(self.generation);
    if (!self.login || self.login.phone !== phone) self.invalidateLogin();
    self.scan.cancel(); var generation = self.generation, client = self.client;
    var login = self.login || { phone: phone }; self.login = login; login.code = str(code);
    return client.loginRequest('/passport/mobile/sms_login/', phone, Object.assign(passportForm(phone), { code: xorHex(code) })).then(function (p) {
      self.checkLogin(generation);
      if (success(p)) return self.finishLogin(p, phone);
      var d = dataOf(p), ways = d.verify_ways || [], mfa = null;
      for (var i = 0; i < ways.length; i++) if (ways[i].verify_way === 'upsms' || ways[i].sms_content) { mfa = ways[i]; break; }
      if (mfa && d.encrypt_uid && d.sms_code_key) {
        login.mfa = { encrypt_uid: str(d.encrypt_uid), sms_code_key: str(d.sms_code_key), channel_mobile: str(mfa.channel_mobile), sms_content: str(mfa.sms_content), passport_scene: str(d.passport_scene), log_id: str(d.event_params && d.event_params.log_id) };
        login.mfa_expires = Date.now() + 600000; self.save(); return self.status();
      }
      throw fail(safeDescription(p), 400, 'ACCOUNT_LOGIN');
    });
  };
  Account.prototype.verify = function () {
    var self = this, login = self.login, generation = self.generation, client = self.client;
    if (!login || !login.mfa || Date.now() > login.mfa_expires) return Promise.reject(fail('当前短信验证不存在或已结束，请重新获取验证码', 400, 'ACCOUNT_MFA'));
    var m = login.mfa, body = { passport_mfa_retry_tag: '1', sms_code_key: m.sms_code_key };
    var form = { encrypt_uid: m.encrypt_uid, verify_ticket: '', verify_scene: 'sms_login', verify_reason: 'ato', copywriting_key: 'sms_login', ies_safety_diversion_tag: 'mfa', new_verify_flow: '', new_authn_sdk_version: '1.1.31', new_authn_sdk_verify_reason: 'ato', new_authn_sdk_verify_scene: 'sms_login', request_tag_from: 'h5', biz_params: JSON.stringify(body), new_authn_sdk_log_id: m.log_id || '' };
    return client.loginRequest('/passport/upsms/verify/', login.phone, form).then(function (p) {
      self.checkLogin(generation);
      var ticket = str(dataOf(p).ticket || dataOf(p).verify_ticket);
      if (!success(p) && errorCode(p) !== '1045') throw fail(safeDescription(p), 400, 'ACCOUNT_MFA');
      return client.loginRequest('/passport/mobile/sms_login/', login.phone, Object.assign(passportForm(login.phone), { code: xorHex(login.code), passport_mfa_retry_tag: '1', sms_code_key: xorHex(m.sms_code_key), verify_ticket: ticket })).then(function (result) {
        self.checkLogin(generation); if (!success(result)) throw fail(safeDescription(result), 400, 'ACCOUNT_MFA'); return self.finishLogin(result, login.phone);
      });
    });
  };
  Account.prototype.finishLogin = function (p, phone) {
    var d = dataOf(p), uid = str(d.user_id_str || d.user_id), numeric = str(d.user_id);
    if (!validID(uid) || uid === '0' || numeric && (!validID(numeric) || numeric !== uid)) throw fail('登录响应缺少有效账号身份', 400, 'ACCOUNT_LOGIN');
    if (!this.state.session.token && !this.state.session.cookies.sessionid && !this.state.session.cookies.sessionid_ss) throw fail('登录响应缺少会话凭证', 400, 'ACCOUNT_LOGIN');
    this.commitLogin(this.state.session, { uid: uid, name: str(d.screen_name || d.name || '红果用户'), avatar: str(d.avatar_url || ''), phone: mask(phone) }, 'phone');
    return this.status();
  };
  Account.prototype.cancel = function () { this.invalidateLogin(); this.save(); return this.status(); };
  Account.prototype.logout = function () {
    this.invalidateLogin(); var keep = this.state.session;
    var next = { version: 1, session: { device_id: keep.device_id, install_id: keep.install_id, device: keep.device, cookies: {}, registered: keep.registered } };
    this.writeState(next); this.state = next; this.attachClient(); this.syncing = false; this.syncError = ''; return this.status();
  };
  Account.prototype.authed = function () { if (!this.state.profile) throw fail('请先登录', 401, 'ACCOUNT_REQUIRED'); return this.client; };
  Account.prototype.call = function (pathname, method, query, body) { var self = this, client = this.authed(); return client.request(pathname, method, query, body, false).then(function (p) { if (self.client !== client) throw fail('账号已切换，请重新打开页面', 409, 'ACCOUNT_CHANGED'); var code = str(p && p.code), nested = errorCode(p); if (code !== '0' || nested && nested !== '0') throw fail(safeDescription(p), 502, 'ACCOUNT_UPSTREAM'); return p; }); };
  Account.prototype.recommend = function (query) {
    query = query || {};
    var tab = str(query.channel || '45');
    if (tab !== '45') return Promise.reject(fail('账号推荐频道无效', 400, 'ACCOUNT_RECOMMEND'));
    var cellID = str(query.feed_cell || ''), planID = str(query.feed_plan || ''), self = this;
    try { this.authed(); } catch (error) { return Promise.reject(error); }
    var ownerID = str(this.state.profile.uid);
    function verifyOwner() { if (!self.state.profile || str(self.state.profile.uid) !== ownerID) throw fail('账号已切换，请重新读取', 409, 'ACCOUNT_CHANGED'); }
    if (cellID && planID) {
      if (!validID(cellID) || !validID(planID)) return Promise.reject(fail('推荐分页标识无效', 400, 'ACCOUNT_RECOMMEND'));
      var page = { bottom_tab_type: '7', client_req_type: '2', client_template: '7', change_type: '0', category_id: '0', cell_sub_id: '0', limit: '0', need_personal_recommend: '1', video_type_preferences_str: '[]', cell_id: cellID, plan_id: planID, tab_type: tab, offset: String(Number(query.offset) || 0), session_id: str(query.session_id || ''), filter_ids: str(query.shown || '') };
      return this.call('/reading/bookapi/bookmall/cell/change/v', 'GET', page, null).then(function (payload) {
        verifyOwner();
        var data = dataOf(payload), view = asMap(data.cell_view), offset = Number(query.offset) || 0, nextOffset = Number(data.next_offset) || 0;
        var hasMore = !!data.has_more && nextOffset > offset;
        return { items: feedDramas(view.cell_data), has_more: hasMore, next_offset: nextOffset, session_id: str(data.session_id), feed_cell: cellID, feed_plan: planID, source: 'webos-account-recommend' };
      });
    }
    var init = { bottom_tab_type: '7', landing_bottom_tab_type: '7', need_personal_recommend: '1', device_level: '3', screen_width_px: '1078', is_horizontal_screen: 'false', disable_digg_stat: 'false', auth_aweme: 'true', auth_backward: 'true', has_video_cache: 'false', last_tab_type: '0', last_tab_index: '0', tab_index: '0', req_rank_category_id: '0', video_type_preferences_str: '[]', tab_type: tab, offset: '0', session_id: '', client_req_type: '1' };
    return this.call('/reading/bookapi/bookmall/tab/v', 'GET', init, null).then(function (payload) {
      verifyOwner();
      var data = dataOf(payload), tabs = Array.isArray(data.tab_item) ? data.tab_item : [], selected = null;
      tabs.some(function (entry) { if (str(entry && entry.tab_type) === tab) { selected = entry; return true; } return false; });
      if (!selected) throw fail('推荐响应没有对应频道', 502, 'ACCOUNT_RECOMMEND');
      var cells = Array.isArray(selected.cell_data) ? selected.cell_data : [], followCell = null;
      cells.some(function (cell) {
        var id = str(cell && (cell.cell_id_str || cell.cell_id));
        if (Number(cell && cell.show_type) === 648 && validID(id) && id !== '0') { followCell = cell; return true; }
        return false;
      });
      if (!followCell) return { items: [], has_more: false, next_offset: 0, session_id: str(selected.session_id), feed_cell: '', feed_plan: str(data.bookstore_id), source: 'webos-account-recommend' };
      return { items: feedDramas([followCell]), has_more: !!followCell.has_more, next_offset: Number(followCell.next_offset) || 0, session_id: str(selected.session_id), feed_cell: str(followCell.cell_id_str || followCell.cell_id), feed_plan: str(data.bookstore_id), source: 'webos-account-recommend' };
    });
  };
  Account.prototype.follow = function (query) { query = query || {}; return this.call('/reading/user/subscribe/list/v1/', 'GET', { cursor: query.cursor || '', count: '20', tab_type: '14' }, null).then(function (p) { var d = dataOf(p), info = asMap(d.follow_list_info), rows = d.mix_data || d.follow_update_list || d.subscribe_items || [], items = []; if (!Array.isArray(rows)) throw fail('追更响应列表格式无效', 502, 'ACCOUNT_FOLLOW'); rows.forEach(function (row) { var item = normalizeDrama(row); if (item) { item.followed = true; item.following_update = true; items.push(item); } }); var cursor = str(d.cursor || d.next_cursor || info.cursor), more = !!(d.has_more || info.has_more || asMap(d.comment_list_info).has_more); return { items: items, has_more: more && !!cursor && cursor !== str(query.cursor), next_cursor: cursor, session_id: str(d.session_id), source: 'webos-account' }; }); };
  Account.prototype.setFollow = function (id, enabled) { if (!validID(id)) return Promise.reject(fail('追更项目无效', 400, 'ACCOUNT_FOLLOW')); return this.call('/reading/user/subscribe/delete/v', 'POST', {}, { series_id: id, book_id: id, book_type: 2, op_type: enabled ? 1 : 2 }).then(function () { return { following_update: !!enabled }; }); };
  Account.prototype.reservations = function (query) { var q = { offset: String(Number(query.offset) || 0), subscribe_offset: '0', tab_type: '13', subscribe_order_type: '0', swipe_type: '0', need_calendar_schema: 'false', limit: '20', is_online: query.mode !== 'upcoming' ? 'true' : 'false' }; if (query.session_id) q.session_id = query.session_id; return this.call('/reading/user/subscribe/list/v1/', 'GET', q, null).then(function (p) { var d = dataOf(p), rows = d.subscribe_items || [], items = []; rows.forEach(function (row) { var item = normalizeReservation(row); if (item) { item.reserved = true; items.push(item); } }); var offset = Number(query.offset) || 0, next = Number(d.next_offset || 0); if (d.has_more && next <= offset && items.length) next = offset + 20; return { items: items, has_more: !!d.has_more && next > offset, next_offset: next, session_id: str(d.session_id), online_total_count: Number(d.online_total_count || 0), offline_total_count: Number(d.offline_total_count || 0) }; }); };
  Account.prototype.reserve = function (id, value) { if (!validID(id) || id === '0') return Promise.reject(fail('预约项目无效', 400, 'ACCOUNT_RESERVATION')); return this.call('/reading/bookapi/search/uncover_subscribe/v', 'POST', {}, { item_id: rawNumber(id), item_type: 1, op_type: value ? 1 : 2, shark_param: { enter_from: 'BulletActivity', previous_page: 'MainFragmentActivity', page_list: 'MainFragmentActivity,BulletActivity' }, wish_list_all_del: 0 }).then(function () { return { accepted: true, confirmed: false }; }); };
  Account.prototype.playerAction = function (body) {
    var a = body || {}, action = str(a.action), text = trim(a.text), commentID = str(a.comment_id), limit = action === 'danmaku' ? 100 : 500;
    if (!validID(a.series_id) || a.series_id === '0' || !validID(a.vid) || a.vid === '0') return Promise.reject(fail('缺少当前短剧或视频 ID', 400, 'ACCOUNT_PLAYER_ACTION'));
    if (['comment', 'reply', 'danmaku'].indexOf(action) >= 0 && (!text || Array.from(text).length > limit)) return Promise.reject(fail('内容为空或超过字数限制', 400, 'ACCOUNT_PLAYER_ACTION'));
    if (['reply', 'comment-like', 'comment-delete'].indexOf(action) >= 0 && (!validID(commentID) || commentID === '0')) return Promise.reject(fail('评论 ID 无效', 400, 'ACCOUNT_PLAYER_ACTION'));
    if ((action === 'comment-like') && typeof a.value !== 'boolean') return Promise.reject(fail('缺少点赞状态', 400, 'ACCOUNT_PLAYER_ACTION'));
    var offset = Number(a.offset_ms) || 0; if (offset < 0 || offset > 86400000) return Promise.reject(fail('弹幕时间无效', 400, 'ACCOUNT_PLAYER_ACTION'));
    if (['comment', 'reply', 'danmaku', 'comment-like', 'comment-delete'].indexOf(action) < 0) return Promise.reject(fail('播放操作无效', 400, 'ACCOUNT_PLAYER_ACTION'));
    var shark = { enter_from: 'MainFragmentActivity', previous_page: '', page_list: 'MainFragmentActivity' }, pathName = '/novel/commentapi/comment/add/v1/';
    var business = { ignore_urge_rule: false, book_id: a.series_id, shark_param: shark }, payload;
    if (action === 'comment-like') { pathName = '/novel/commentapi/comment/do_action/v1/'; payload = { object_id: commentID, object_type: 8, action_type: a.value ? 8 : 9, comment_type: 4, business_param: { shark_param: shark } }; }
    else if (action === 'comment-delete') { pathName = '/novel/commentapi/comment/del/v1/'; payload = { comment_id: commentID, service_id: 4, data_type: 4 }; }
    else {
      var dataType = action === 'danmaku' ? 20 : 4, commit = action === 'danmaku' ? 1500 : action === 'reply' ? 9 : 3;
      business.offset = action === 'danmaku' ? offset : 0;
      if (action === 'danmaku') { shark.type = 'short_play'; shark.aid = '8662'; }
      else { business.text_feature = {}; business.has_aigc_content = false; business.log_extra = {}; }
      if (action === 'comment') business.preset_text_id = '';
      if (action === 'reply') { pathName = '/novel/commentapi/reply/add/v1/'; }
      payload = { commit_source: commit, group_id: a.vid, group_type: 30, data_type: dataType, text: text, business_param: business, aid: 8662 };
      if (action === 'reply') payload.reply_to_comment_id = commentID;
    }
    return this.call(pathName, 'POST', {}, payload).then(function (p) {
      if (action === 'comment-like' || action === 'comment-delete') return {};
      var d = dataOf(p), result = action === 'reply' ? asMap(d.reply) : asMap(d.comment_info), id = str(result.reply_id || result.comment_id);
      if (!validID(id) || id === '0') throw fail('服务未返回发布结果，请刷新查看，避免重复发送', 502, 'ACCOUNT_PLAYER_ACTION');
      return { comment_id: id, text: text, offset_ms: offset, own: true };
    });
  };
  function emptyLibrary(owner) { return { version: 1, entries: [], owner_id: owner || '', cloud: { sequence: 0, pending: [], hidden: {} } }; }
  function loadLibraryFile(file, owner) {
    var data;
    try { data = parseExactJSON(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error && error.code === 'ENOENT') return emptyLibrary(owner); throw fail('本地记录文件无效，未覆盖原记录', 500, 'LIBRARY_STORAGE'); }
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) throw fail('本地记录文件无效，未覆盖原记录', 500, 'LIBRARY_STORAGE');
    if (owner && data.owner_id && data.owner_id !== owner) throw fail('账号记录身份不匹配', 409, 'ACCOUNT_CHANGED');
    data.owner_id = owner || '';
    data.cloud = data.cloud || { sequence: 0, pending: [], hidden: {} };
    data.cloud.pending = Array.isArray(data.cloud.pending) ? data.cloud.pending : [];
    data.cloud.hidden = data.cloud.hidden || {};
    data.cloud.sequence = Number(data.cloud.sequence) || 0;
    data.cloud.pending.forEach(function (op) { if (!Number(op.sequence)) { data.cloud.sequence++; op.sequence = data.cloud.sequence; } });
    return data;
  }
  Account.prototype.readGuestLibrary = function () { return loadLibraryFile(path.join(this.dir, 'library.json'), ''); };
  Account.prototype.library = function () { if (!this.state.profile) throw fail('请先登录', 401, 'ACCOUNT_REQUIRED'); return loadLibraryFile(path.join(this.dir, 'accounts', this.state.profile.uid, 'library.json'), this.state.profile.uid); };
  Account.prototype.librarySnapshot = function () { var data = this.state.profile ? this.library() : this.readGuestLibrary(); delete data.cloud; return data; };
  Account.prototype.saveLibrary = function (data) { var root = path.join(this.dir, 'accounts', this.state.profile.uid); mkdirp(root, 448); var file = path.join(root, 'library.json'), temp = file + '.' + process.pid + '.tmp'; data.version = 1; data.owner_id = this.state.profile.uid; fs.writeFileSync(temp, JSON.stringify(data), { mode: 384 }); fs.renameSync(temp, file); };
  Account.prototype.queueMutation = function (data, kind, id, value, entry) {
    data.cloud = data.cloud || { sequence: 0, pending: [], hidden: {} }; data.cloud.pending = data.cloud.pending || []; data.cloud.sequence = Number(data.cloud.sequence) || 0;
    var index = data.cloud.pending.findIndex(function (op) { return op.kind === kind && str(op.series_id) === id; });
    if (index < 0 && data.cloud.pending.length >= 2000) throw fail('待同步记录过多，请先恢复网络并同步', 409, 'ACCOUNT_SYNC');
    var operation = { sequence: ++data.cloud.sequence, kind: kind, series_id: id, value: !!value, entry: entry ? JSON.parse(JSON.stringify(entry)) : {} };
    if (index < 0) data.cloud.pending.push(operation); else data.cloud.pending[index] = operation;
  };
  Account.prototype.changeLibrary = function (change) {
    change = change || {}; if (!this.state.profile) throw fail('请先登录', 401, 'ACCOUNT_REQUIRED');
    var uid = this.state.profile.uid; if (str(change.owner_id) !== uid) throw fail('账号已切换，请重新打开页面', 409, 'ACCOUNT_CHANGED');
    var data = this.library(), entries = data.entries, id = str(change.series_id || change.drama && change.drama.series_id), at = entries.findIndex(function (entry) { return str(entry.drama && entry.drama.series_id) === id; }), now = Date.now(), self = this;
    if (change.action === 'clear' || change.action === 'remove') {
      if (['history', 'favorites', 'likes'].indexOf(change.kind) < 0 || change.action === 'remove' && (!validID(id) || id === '0')) throw fail('记录类型无效', 400, 'LIBRARY_CHANGE');
      entries.forEach(function (entry) {
        if (change.action === 'remove' && str(entry.drama && entry.drama.series_id) !== id) return;
        var series = str(entry.drama && entry.drama.series_id); if (!validID(series)) return;
        data.cloud.hidden[change.kind + ':' + series] = now;
        if (change.kind === 'history') Object.assign(entry, { last_played_at: 0, episode: 0, video_id: '', position: 0, duration: 0, completed: false });
        if (change.kind === 'favorites') { entry.favorite_at = 0; if (change.action === 'remove') self.queueMutation(data, 'favorite', series, false, entry); }
        if (change.kind === 'likes') { entry.liked_at = 0; entry.liked_videos = []; }
      });
    } else {
      if (['progress', 'favorite', 'like'].indexOf(change.action) < 0 || !change.drama || !validID(str(change.drama.series_id)) || change.drama.series_id === '0' || !change.drama.title) throw fail('短剧信息无效', 400, 'LIBRARY_CHANGE');
      if (change.action !== 'progress' && typeof change.value !== 'boolean') throw fail('缺少收藏/点赞状态', 400, 'LIBRARY_CHANGE');
      if (change.action === 'progress' && (!validID(str(change.video_id)) || change.video_id === '0' || Number(change.episode) < 1 || Number(change.episode) > 10000 || !isFinite(Number(change.position)) || Number(change.position) < 0 || Number(change.position) > 86400 || !isFinite(Number(change.duration)) || Number(change.duration) < 0 || Number(change.duration) > 86400)) throw fail('播放进度无效', 400, 'LIBRARY_CHANGE');
      if (change.action === 'like' && (!validID(str(change.video_id)) || change.video_id === '0' || Number(change.episode) < 1 || Number(change.episode) > 10000)) throw fail('缺少当前播放集', 400, 'LIBRARY_CHANGE');
      if (at < 0) { entries.push({ drama: change.drama, liked_videos: [] }); at = entries.length - 1; }
      var entry = entries[at]; entry.drama = change.drama;
      if (change.action === 'progress') {
        Object.assign(entry, { episode: Number(change.episode), video_id: str(change.video_id), position: Number(change.position), duration: Number(change.duration), completed: !!change.completed, last_played_at: now });
        delete data.cloud.hidden['history:' + id]; this.queueMutation(data, 'progress', id, false, entry);
      } else if (change.action === 'favorite') {
        entry.favorite_at = change.value ? now : 0;
        if (change.value) delete data.cloud.hidden['favorites:' + id]; this.queueMutation(data, 'favorite', id, change.value, entry);
      } else {
        var client = this.client, vid = str(change.video_id), enabled = change.value;
        this.libraryRevision++;
        return client.request('/novel/articleapi/do_action/v1/', 'POST', {}, { action_category: 1, action_reason_remark: 'like_click', action_type: enabled ? 3 : 4, object_id: vid, object_type: 6, business_param: { book_id: 0, has_aigc_content: false, modify_count: 0, shark_param: { enter_from: 'MainFragmentActivity', previous_page: '', page_list: 'MainFragmentActivity' }, video_id: id } }, false).then(function (p) {
          var code = str(p && p.code), nested = errorCode(p); if (['0', '101045', '101046'].indexOf(code) < 0 || nested && ['0', '101045', '101046'].indexOf(nested) < 0) throw fail('红果未确认点赞操作', 502, 'ACCOUNT_LIKE');
          var current = self.library(), currentEntry = current.entries.find(function (item) { return str(item.drama && item.drama.series_id) === id; });
          if (!currentEntry) throw fail('账号记录已变化，请刷新后重试', 409, 'ACCOUNT_CHANGED');
          currentEntry.liked_videos = (currentEntry.liked_videos || []).filter(function (item) { return str(item.video_id) !== vid; });
          if (enabled) currentEntry.liked_videos.push({ video_id: vid, episode: Number(change.episode), liked_at: now });
          currentEntry.liked_at = currentEntry.liked_videos.reduce(function (latest, item) { return Math.max(latest, Number(item.liked_at) || 0); }, 0);
          delete current.cloud.hidden['likes:' + id]; self.saveLibrary(current); return self.librarySnapshot();
        });
      }
    }
    data.entries = data.entries.filter(function (entry) { return entry.last_played_at || entry.favorite_at || entry.liked_at || entry.liked_videos && entry.liked_videos.length; });
    this.saveLibrary(data); this.libraryRevision++; setTimeout(function () { self.sync().catch(function () {}); }, 0); return this.librarySnapshot();
  };
  Account.prototype.notificationFile = function () { var root = path.join(this.dir, 'accounts', this.state.profile.uid); mkdirp(root, 448); return path.join(root, 'notifications.json'); };
  Account.prototype.readNotifications = function () { try { var state = parseExactJSON(fs.readFileSync(this.notificationFile(), 'utf8')); if (!state || !Array.isArray(state.items)) throw fail('提醒记录文件无效，未覆盖原记录', 500, 'ACCOUNT_STORAGE'); state.follow_snapshots = state.follow_snapshots || {}; state.reservation_snapshots = state.reservation_snapshots || {}; return state; } catch (e) { if (e && e.code === 'ENOENT') return { items: [], follow_snapshots: {}, reservation_snapshots: {}, last_check_at: 0 }; throw e; } };
  Account.prototype.saveNotifications = function (state) { var file = this.notificationFile(), temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(state), { mode: 384 }); fs.renameSync(temp, file); };
  Account.prototype.notifications = function () {
    this.authed(); var self = this, old = this.readNotifications();
    return Promise.all([this.follow({}), this.reservations({}), this.reservations({ mode: 'upcoming' })]).then(function (values) {
      var follows = {}, reservations = {}, now = Date.now(), items = old.items || [];
      (values[0].items || []).forEach(function (row) { follows[row.series_id] = { title: row.title, episode_count: row.episode_count || 0, update_time: row.follow_update_time || 0 }; });
      (values[1].items || []).concat(values[2].items || []).forEach(function (row) { if (row.reservation_id) reservations[row.reservation_id] = { title: row.title, series_id: row.series_id, upcoming: !!row.upcoming }; });
      if (old.last_check_at) {
        Object.keys(follows).forEach(function (id) { var before = old.follow_snapshots[id], current = follows[id]; if (before && (current.episode_count > before.episode_count || current.update_time > before.update_time)) items.push({ id: 'follow:' + id + ':' + current.episode_count + ':' + current.update_time, kind: 'follow_update', series_id: id, title: current.title, episode: current.episode_count, message: '《' + current.title + '》有新内容', created_at: now, read: false }); });
        Object.keys(reservations).forEach(function (id) { var before = old.reservation_snapshots[id], current = reservations[id]; if (before && before.upcoming && !current.upcoming) items.push({ id: 'reservation:' + id, kind: 'reservation_online', series_id: current.series_id, reservation_id: id, title: current.title, message: '《' + current.title + '》已上线，可以播放了', created_at: now, read: false }); });
      }
      var seen = {}; items = items.filter(function (item) { if (seen[item.id]) return false; seen[item.id] = true; return true; }).slice(-200);
      var state = { items: items, follow_snapshots: follows, reservation_snapshots: reservations, last_check_at: now }; self.saveNotifications(state);
      return { ok: true, items: items, unread_count: items.filter(function (item) { return !item.read; }).length, checked_at: now, stale: false };
    });
  };
  Account.prototype.markNotifications = function (body) { this.authed(); if (!(body && body.all === true) && !str(body && body.id)) throw fail('更新提醒参数无效', 400, 'ACCOUNT_NOTIFICATIONS'); var state = this.readNotifications(); if (body && body.all) state.items.forEach(function (item) { item.read = true; }); else { var id = str(body.id); state.items.forEach(function (item) { if (item.id === id) item.read = true; }); } this.saveNotifications(state); return { ok: true, items: state.items, unread_count: state.items.filter(function (item) { return !item.read; }).length, checked_at: state.last_check_at, stale: false }; };
  Account.prototype.uploadMutation = function (op) {
    var e = op.entry || {}, id = op.series_id, self = this;
    if (op.kind === 'favorite') return this.call('/reading/bookapi/bookshelf/video/update/v', 'POST', {}, { is_cancelled: false, shark_extra: { enter_from: '0', previous_page: '0', page_list: '0', is_active_behavior: '1', inactive_type: '0' }, update_bookshelf_video_list: [{ book_id: rawNumber(id), book_type: 2, modify_time: Date.now(), video_shelf_operate_type: op.value ? 0 : 1 }] }).then(function () {});
    if (op.kind !== 'progress' || !validID(e.video_id) || Number(e.episode) < 1) return Promise.reject(fail('云端播放进度无效', 400, 'ACCOUNT_SYNC'));
    var stamp = Number(e.last_played_at) || Date.now(), ms = Math.round((Number(e.position) || 0) * 1000), duration = Math.round((Number(e.duration) || 0) * 1000);
    var row = { book_id: rawNumber(id), book_type: 2, vid: rawNumber(e.video_id), vid_index: Number(e.episode), chapter_index: 0, current_play_position: ms, player_accumulate_total_time: ms, read_timestamp_ms: stamp, update_timestamp_ms: stamp, is_delete: false, is_interactive_game: false, is_listen_mode: false, is_multi_season: e.drama && e.drama.multi_season ? 1 : 0, season_index: Number(e.drama && e.drama.season_index) || 0, duration: duration, episode_cnt: Number(e.drama && e.drama.episode_count) || 0, digged_count: 0, user_digg: false, origin_novel_book_id: 0, recent_reads: 0, retain_video_play_time: 0, series_play_cnt: 0, tone_id: 0, use_soft_delete: false, meet_guide_comment_tag: false, user_playlet_comment_flag: false };
    return this.call('/reading/bookapi/read_history/update/v', 'POST', {}, { update_datas: [row] }).then(function () { return self.call('/reading/bookapi/read_progress/upload/v', 'POST', {}, { books: [{ book_id: id, book_type: 2, item_id: e.video_id, vid_index: Number(e.episode), current_play_time: ms, player_cumulative_total_duration: ms, read_timestamp_ms: stamp, progress_type: 0, channel_id: 0, cur_channel_id: 0, check_timestamp: false, is_listen_mode: false, is_local_book: false, listen_and_read: false, page_index: 0, page_progress_rate: 0, paragraph_offset: 0, tone_id: 0 }] }); });
  };
  Account.prototype.sync = function () {
    var self = this;
    if (!this.state.profile) return Promise.reject(fail('请先登录', 401, 'ACCOUNT_REQUIRED'));
    if (this.syncPromise) return this.syncPromise;
    this.syncing = true; this.syncError = '';
    var uid = this.state.profile.uid, generation = this.generation, likeRevision = this.libraryRevision, remote = {}, offset = 0, historyPages = 0;
    function historyPage() {
      if (historyPages++ >= 200) return Promise.reject(fail('云端历史分页未完成', 502, 'ACCOUNT_SYNC'));
      return self.call('/reading/bookapi/read_history/list/v', 'GET', { limit: '0', offset: String(offset), book_type: '2', full_field: 'false', query_soft_deleted: 'false', last_min_read_timestamp_ms: '0', is_first_load: offset === 0 ? 'true' : 'false' }, null).then(function (p) {
        var d = dataOf(p), rows = d.data_list || [];
        if (!Array.isArray(rows)) throw fail('云端历史列表格式无效', 502, 'ACCOUNT_SYNC');
        rows.forEach(function (r) {
          var id = str(r.book_id_str || r.book_id), vid = str(r.vid);
          if (!validID(id) || id === '0' || r.is_delete || !validID(vid) || vid === '0' || Number(r.vid_index) < 1) return;
          var stamp = Number(r.read_timestamp_ms || 0), old = remote[id];
          if (!old || stamp >= old.last_played_at) remote[id] = { drama: { series_id: id, title: str(r.book_name || '剧集信息暂未加载'), cover: str(r.thumb_url), episode_count: Number(r.episode_cnt || 0), season_index: Number(r.season_index || 0), multi_season: !!r.is_multi_season }, episode: Number(r.vid_index || 0), video_id: vid, position: Number(r.current_play_position || 0) / 1000, duration: Number(r.duration || 0) / 1000, completed: false, last_played_at: stamp, liked_videos: [] };
        });
        if (!d.has_more) return;
        var next = Number(d.next_offset || 0); if (!rows.length || next <= offset) next = offset + 500; offset = next; return historyPage();
      });
    }
    function pullFavorites() {
      return self.call('/reading/bookapi/bookshelf/video/list/v', 'GET', { target_user_id: uid }, null).then(function (p) {
        var rows = dataOf(p).video_shelf_info || [];
        if (!Array.isArray(rows)) throw fail('云端收藏列表格式无效', 502, 'ACCOUNT_SYNC');
        rows.forEach(function (r, index) {
          var id = str(r.series_id || r.book_id); if (!validID(id) || id === '0') return;
          var entry = remote[id] || { drama: { series_id: id, title: str(r.book_name || r.series_name || '剧集信息暂未加载'), cover: str(r.thumb_url || r.cover), episode_count: Number(r.episode_cnt || 0) }, liked_videos: [] };
          entry.favorite_at = Number(r.collect_time || Date.now() - index); if (entry.favorite_at < 100000000000) entry.favorite_at *= 1000; remote[id] = entry;
        });
      });
    }
    function pullLikes() {
      var likeOffset = 0, pageCount = 0, seen = {};
      function page() {
        if (pageCount++ >= 1000) return Promise.reject(fail('云端点赞分页未完成', 502, 'ACCOUNT_SYNC'));
        return self.call('/reading/ugc/action/mget/v', 'GET', { object_type_list: '6,15,10', action_type: '3', offset: String(likeOffset), count: '100' }, null).then(function (p) {
          var d = dataOf(p); if (!Object.prototype.hasOwnProperty.call(d, 'mixed_data_list') || d.has_more == null) throw fail('点赞响应缺少完整列表', 502, 'ACCOUNT_SYNC');
          var rows = d.mixed_data_list || []; if (!Array.isArray(rows)) throw fail('点赞列表格式无效', 502, 'ACCOUNT_SYNC');
          if (rows.length) { var digest = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); if (seen[digest]) throw fail('点赞列表返回重复分页', 502, 'ACCOUNT_SYNC'); seen[digest] = true; }
          rows.forEach(function (row) {
            var video = asMap(row && row.video_data), id = str(video.series_id), vid = str(video.vid);
            if (!validID(id) || id === '0' || !validID(vid) || vid === '0') return;
            var detail = asMap(video.video_detail);
            if (detail.series_id_str && str(detail.series_id_str) !== id || detail.series_id && str(detail.series_id) !== id) throw fail('点赞详情身份不匹配', 502, 'ACCOUNT_SYNC');
            detail.series_id_str = id;
            var entry = remote[id] || { drama: normalizeDrama(detail) || { series_id: id, title: '剧集信息暂未加载', cover: str(video.cover), episode_count: Number(video.episode_cnt || 0) }, liked_videos: [] };
            entry.liked_videos = entry.liked_videos || [];
            if (!entry.liked_videos.some(function (liked) { return str(liked.video_id) === vid; })) entry.liked_videos.push({ video_id: vid, episode: Number(video.vid_index || 0), liked_at: Number(video.user_digg_timestamp_ms || 0) || Date.now() - pageCount });
            entry.liked_at = entry.liked_videos.reduce(function (latest, liked) { return Math.max(latest, Number(liked.liked_at) || 0); }, 0); remote[id] = entry;
          });
          if (!(d.has_more === true || d.has_more === 1 || d.has_more === '1' || d.has_more === 'true')) return;
          if (!rows.length) throw fail('点赞分页未完整读取', 502, 'ACCOUNT_SYNC');
          var next = Number(d.next_offset || 0); if (next <= likeOffset) next = likeOffset + 100; likeOffset = next; return page();
        });
      }
      return page();
    }
    function mergeRemote() {
      if (self.generation !== generation || !self.state.profile || self.state.profile.uid !== uid) throw fail('账号已切换，请重新打开页面', 409, 'ACCOUNT_CHANGED');
      var current = self.library(), pending = current.cloud.pending || [], hidden = current.cloud.hidden || {};
      Object.keys(remote).forEach(function (id) {
        if (hidden['history:' + id] || hidden['favorites:' + id] || hidden['likes:' + id]) return;
        var at = current.entries.findIndex(function (entry) { return str(entry.drama && entry.drama.series_id) === id; }), existing = at >= 0 ? current.entries[at] : null, incoming = remote[id], merged = Object.assign({}, existing || {}, incoming);
        if (existing) {
          if (Number(existing.last_played_at) > Number(incoming.last_played_at) || pending.some(function (op) { return op.kind === 'progress' && str(op.series_id) === id; })) Object.assign(merged, { drama: existing.drama, episode: existing.episode, video_id: existing.video_id, position: existing.position, duration: existing.duration, completed: existing.completed, last_played_at: existing.last_played_at });
          if (pending.some(function (op) { return op.kind === 'favorite' && str(op.series_id) === id; })) merged.favorite_at = existing.favorite_at;
          else merged.favorite_at = Number(existing.favorite_at) > Number(incoming.favorite_at) ? existing.favorite_at : incoming.favorite_at;
          if (likeRevision !== self.libraryRevision) { merged.liked_at = existing.liked_at; merged.liked_videos = existing.liked_videos || []; }
          else { merged.liked_at = incoming.liked_at || 0; merged.liked_videos = incoming.liked_videos || []; }
          if (!merged.drama || !merged.drama.title || merged.drama.title === '剧集信息暂未加载') merged.drama = incoming.drama;
        }
        if (at < 0) current.entries.push(merged); else current.entries[at] = merged;
      });
      current.entries = current.entries.filter(function (entry) { return entry.last_played_at || entry.favorite_at || entry.liked_at || entry.liked_videos && entry.liked_videos.length; });
      self.saveLibrary(current);
    }
    function flush() {
      var current = self.library(), pending = current.cloud.pending || []; if (!pending.length) return Promise.resolve();
      var op = pending[0]; return self.uploadMutation(op).then(function () { var updated = self.library(); updated.cloud.pending = (updated.cloud.pending || []).filter(function (item) { return Number(item.sequence) !== Number(op.sequence); }); self.saveLibrary(updated); return flush(); });
    }
    var task = historyPage().then(pullFavorites).then(pullLikes).then(mergeRemote).then(flush).then(function () {
      var current = self.library(); current.cloud.last_sync = Date.now(); current.cloud.sync_error = ''; self.saveLibrary(current); self.syncError = ''; return self.status();
    }).catch(function (error) { if (self.generation === generation) { try { var current = self.library(); current.cloud.sync_error = error.message; self.saveLibrary(current); } catch (ignored) {} self.syncError = error.message; } throw error; });
    this.syncPromise = task.then(function () { if (self.generation === generation) { self.syncing = false; self.syncPromise = null; } return self.status(); }, function (error) { if (self.generation === generation) { self.syncing = false; self.syncPromise = null; } throw error; });
    return this.syncPromise;
  };
  Account.prototype.importHistory = function (body) {
    if (!this.state.profile) return Promise.reject(fail('请先登录', 401, 'ACCOUNT_REQUIRED'));
    if (str(body && body.owner_id) !== this.state.profile.uid) return Promise.reject(fail('账号已切换，请重新打开页面', 409, 'ACCOUNT_CHANGED'));
    var guest = this.readGuestLibrary(), data = this.library(), index = {}, imported = 0;
    (data.entries || []).forEach(function (e, i) { if (e.drama) index[str(e.drama.series_id)] = i; });
    var latest = {}, hidden = data.cloud.hidden || {}, self = this;
    (guest.entries || []).forEach(function (source) {
      var id = str(source.drama && source.drama.series_id);
      if (!source.last_played_at || !validID(str(source.video_id)) || str(source.video_id) === '0' || Number(source.episode) < 1 || Number(source.episode) > 10000 || !validID(id) || id === '0' || hidden['history:' + id]) return;
      if (!latest[id] || Number(source.last_played_at) > Number(latest[id].last_played_at)) latest[id] = source;
    });
    var ids = Object.keys(latest), remaining = 0;
    ids.forEach(function (id) {
      var source = latest[id], at = index[id], target = at == null ? null : data.entries[at];
      if (Number(source.last_played_at) <= Number(target && target.last_played_at || 0)) return;
      if ((data.cloud.pending || []).length >= 2000 && !(data.cloud.pending || []).some(function (op) { return op.kind === 'progress' && str(op.series_id) === id; })) { remaining++; return; }
      var merged = Object.assign({}, source, { drama: source.drama, favorite_at: target && target.favorite_at || 0, liked_at: target && target.liked_at || 0, liked_videos: target && target.liked_videos || [] });
      if (at == null) { index[id] = data.entries.length; data.entries.push(merged); } else data.entries[at] = merged;
      this.queueMutation(data, 'progress', id, false, merged); imported++;
    }, this);
    this.saveLibrary(data); this.libraryRevision++; if (imported) setTimeout(function () { self.sync().catch(function () {}); }, 0);
    return Promise.resolve({ status: this.status(), import_history: { imported: imported, remaining: remaining } });
  };
  function createAccount(options) { return new Account(options); }
  createAccount.registerPlaybackDevice = function (sendRequest) {
    var s = { device_id: '', install_id: '', device: device(), cookies: {} };
    return register(s, sendRequest || requestBuffer).then(function () {
      return { deviceID: s.device_id, installID: s.install_id, cdid: s.device.cdid };
    });
  };
  module.exports = createAccount;
}());
