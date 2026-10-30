'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var url = require('url');
var http = require('http');
var createAccount = require('./account');
var createService = require('./service');
var PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJklEQVR4nO3NMQ0AAAwDoPo33arYsQQMkB6LQCAQCAQCgUAg+BIMi1X0pjxKe0gAAAAASUVORK5CYII=';
var UID = '1234567890123456789';
function response(data, headers, status) { return { status: status || 200, headers: headers || {}, body: Buffer.from(JSON.stringify(data)) }; }
function passport(data, headers) { return response({ message: 'success', data: data }, headers); }
function deferred() { var resolve; var promise = new Promise(function (fn) { resolve = fn; }); return { resolve: resolve, promise: promise }; }
async function until(fn) { for (var i = 0; i < 400; i++) { if (fn()) return; await new Promise(function (r) { setTimeout(r, 5); }); } throw new Error('condition timeout'); }
function fixture(t, change, options) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-webos-scan-')), calls = [], polls = 0, starts = 0;
  var account = createAccount(Object.assign({ dataDir: dir, qrPollInterval: 1, requestBuffer: function (target, method, headers, body, limit, control) {
    var parsed = url.parse(target, true), call = { target: target, path: parsed.pathname, query: parsed.query, method: method, headers: headers, body: body, control: control };
    calls.push(call);
    var result = change && change(call, { polls: polls, starts: starts });
    if (result !== undefined) return Promise.resolve(result);
    if (call.path === '/passport/web/get_qrcode/') return Promise.resolve(passport({ token: 'private-token-' + (++starts), qrcode: PNG, expire_time: 60 }, { 'set-cookie': ['qr_csrf=csrf; Path=/; Secure'] }));
    if (call.path === '/passport/web/check_qrconnect/') return Promise.resolve(passport({ status: ++polls === 1 ? 'new' : polls === 2 ? 'scanned' : 'confirmed', redirect_url: '/qr-confirm' }));
    if (call.path === '/qr-confirm') return Promise.resolve(response({}, { 'set-cookie': ['sessionid=private-session; Path=/; Secure', 'install_id=website-install; Path=/'] }));
    if (call.path === '/passport/account/info/v2/') return Promise.resolve(passport({ user_id_str: UID, user_id: UID, name: 'fixture' }));
    if (call.path === '/service/2/device_register/') return Promise.resolve(response({ device_id_str: '1111111111111111', install_id_str: '2222222222222222' }, { 'set-cookie': ['install_id=2222222222222222; Path=/'] }));
    if (call.path === '/reading/bookapi/read_history/list/v') return Promise.resolve(response({ code: 0, data: { data_list: [], has_more: false } }));
    if (call.path === '/reading/bookapi/bookshelf/video/list/v') return Promise.resolve(response({ code: 0, data: { video_shelf_info: [] } }));
    if (call.path === '/reading/ugc/action/mget/v') return Promise.resolve(response({ code: 0, data: { mixed_data_list: [], has_more: false } }));
    return Promise.resolve(response({ code: 0, data: {} }));
  } }, options || {}));
  t.after(function () { account.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { account: account, calls: calls, dir: dir };
}

test('webOS QR confirms, registers an independent app identity, persists and uses the existing account API', async function (t) {
  var f = fixture(t), account = f.account;
  var start = account.startQR(), id = start.qr_login.id;
  assert.equal(start.qr_login_available, true); assert.equal(start.qr_login.state, 'preparing');
  await until(function () { return account.status().logged_in; });
  var status = account.qrStatus(id);
  assert.equal(status.login_method, 'qr'); assert.equal(status.profile.uid, UID);
  assert.equal(status.qr_login.state, 'signed_in'); assert.equal(status.qr_login.image, undefined);
  assert.equal(account.state.session.cookies.install_id, '2222222222222222');
  assert.equal(account.state.session.cookies.sessionid, 'private-session');
  assert(!JSON.stringify(status).match(/private-token|private-session|csrf|website-install/));
  var created = f.calls.find(function (c) { return c.path === '/passport/web/get_qrcode/'; });
  assert.equal(created.query.aid, '513755'); assert.equal(created.query.passport_jssdk_version, '3.4.10');
  var profile = f.calls.find(function (c) { return c.path === '/passport/account/info/v2/'; });
  assert(profile.headers.Cookie.indexOf('private-session') >= 0);
  var registration = f.calls.find(function (c) { return c.path === '/service/2/device_register/'; });
  assert(!registration.headers.Cookie, 'website credentials never accompany anonymous registration');
  var restore = createAccount({ dataDir: f.dir }); t.after(function () { restore.close(); });
  assert.equal(restore.status().logged_in, true); assert.equal(restore.status().login_method, 'qr');
  assert.equal(fs.statSync(path.join(f.dir, 'account.json')).mode & 511, 384);
  assert.equal(fs.statSync(f.dir).mode & 63, 0);
  await account.reserve('12345', true);
  var write = f.calls.find(function (c) { return c.path === '/reading/bookapi/search/uncover_subscribe/v'; });
  assert(write.headers.Cookie.indexOf('sessionid=private-session') >= 0);
  await until(function () { return !account.syncing; });
  assert.equal(account.status().sync.state, 'idle');
  assert.throws(function () { account.startQR(); }, /退出/);
  account.logout(); assert.equal(account.status().logged_in, false);
  assert.equal(account.state.session.cookies.sessionid, undefined);
});

test('refresh and cancellation abort old requests and reject their late confirmations', async function (t) {
  var old = deferred(), held = false, aborted = false;
  var f = fixture(t, function (call) {
    if (call.path === '/passport/web/check_qrconnect/' && !held) {
      held = true; call.control.onCancel(function () { aborted = true; }); return old.promise;
    }
  });
  var first = f.account.startQR().qr_login.id;
  await until(function () { return held; });
  var next = f.account.startQR().qr_login.id;
  f.account.cancelQR(first);
  assert.equal(f.account.qrStatus(next).qr_login.id, next); assert(aborted);
  f.account.cancelQR(next);
  old.resolve(passport({ status: 'confirmed', redirect_url: '/qr-confirm' }));
  await new Promise(function (r) { setTimeout(r, 15); });
  assert.equal(f.account.status().logged_in, false);
  assert.equal(f.account.qrStatus(next).qr_login.state, 'cancelled');
  assert(!f.calls.some(function (c) { return c.path === '/qr-confirm'; }));
  assert.throws(function () { f.account.qrStatus(first); }, /失效/);
  assert(!fs.existsSync(path.join(f.dir, 'account.json')));
});

test('cancel while device registration is pending cannot save or resurrect a login', async function (t) {
  var wait = deferred(), reached = false;
  var f = fixture(t, function (call) { if (call.path === '/service/2/device_register/') { reached = true; return wait.promise; } });
  var id = f.account.startQR().qr_login.id;
  await until(function () { return reached; }); f.account.cancelQR(id);
  wait.resolve(response({ device_id_str: '1111111111111111', install_id_str: '2222222222222222' }));
  await new Promise(function (r) { setTimeout(r, 15); });
  assert.equal(f.account.status().logged_in, false); assert(!fs.existsSync(path.join(f.dir, 'account.json')));
});

test('expired codes and failed confirmation release timers; confirmed codes have a separate completion deadline', async function (t) {
  var expired = fixture(t, function (call) { if (call.path === '/passport/web/get_qrcode/') return passport({ qrcode: PNG, token: 'secret', expire_time: 0 }); });
  expired.account.startQR(); await until(function () { return expired.account.status().qr_login.state === 'expired'; });
  assert(!expired.account.status().qr_login.image);
  var pending = deferred();
  var completion = fixture(t, function (call) {
    if (call.path === '/passport/web/check_qrconnect/') return passport({ status: 'confirmed', redirect_url: '/qr-confirm' });
    if (call.path === '/qr-confirm') return pending.promise;
  }, { qrCompletionTimeout: 15 });
  completion.account.startQR(); await until(function () { return completion.account.status().qr_login.state === 'failed'; });
  assert(!completion.account.status().logged_in);
});

test('network timeouts can recover before expiry without overlapping polls', async function (t) {
  var count = 0, active = 0, peak = 0;
  var f = fixture(t, function (call) {
    if (call.path === '/passport/web/check_qrconnect/' && ++count === 1) {
      active++; peak = Math.max(active, peak); call.control.onCancel(function () { active--; }); return new Promise(function () {});
    }
  }, { qrRequestTimeout: 10 });
  f.account.startQR(); await until(function () { return f.account.status().logged_in; });
  assert.equal(active, 0); assert.equal(peak, 1); assert(count > 1);
});

test('untrusted redirects, malformed images, mismatched IDs, absent sessions and failed registration never persist', async function (t) {
  var cases = [
    function (c) { if (c.path === '/passport/web/get_qrcode/') return passport({ qrcode: 'bad', token: 'secret' }); },
    function (c) { if (c.path === '/passport/web/check_qrconnect/') return passport({ status: 'confirmed', redirect_url: 'https://hongguoduanju.com.evil.test/?token=secret' }); },
    function (c) { if (c.path === '/passport/web/check_qrconnect/') return passport({ status: 'confirmed', redirect_url: 'http://hongguoduanju.com/' }); },
    function (c) { if (c.path === '/qr-confirm') return response({}); },
    function (c) { if (c.path === '/passport/account/info/v2/') return passport({ user_id_str: UID, user_id: '456' }); },
    function (c) { if (c.path === '/service/2/device_register/') return response({ device_id: 0, install_id: 0 }); },
    function (c) { if (c.path === '/qr-confirm') return response({}, { location: '/qr-confirm' }, 302); }
  ];
  for (var change of cases) {
    var f = fixture(t, change); f.account.startQR();
    await until(function () { return f.account.status().qr_login.state === 'failed'; });
    assert.equal(f.account.status().logged_in, false); assert(!fs.existsSync(path.join(f.dir, 'account.json')));
    assert(!JSON.stringify(f.account.status()).match(/secret|private-session|token=/));
    assert(!f.calls.some(function (c) { return c.target.indexOf('evil.test') >= 0; }));
  }
});

test('website cookie domain/path/expiry and deletion rules survive trusted redirect chains', async function (t) {
  var f = fixture(t, function (c) {
    if (c.path === '/qr-confirm') return response({}, { location: 'https://passport.hongguoduanju.com/sub/confirm', 'set-cookie': ['root=parent; Domain=hongguoduanju.com; Path=/', 'path_only=restricted; Path=/private', 'gone=value; Max-Age=0; Path=/'] }, 302);
    if (c.path === '/sub/confirm') {
      assert(c.headers.Cookie.indexOf('root=parent') >= 0); assert(!c.headers.Cookie.match(/qr_csrf|path_only|gone/));
      return response({}, { location: 'https://hongguoduanju.com/done', 'set-cookie': ['child=restricted; Path=/', 'sessionid=private-session; Domain=hongguoduanju.com; Path=/', 'evil=restricted; Domain=evil.test; Path=/'] }, 302);
    }
    if (c.path === '/done') { assert(c.headers.Cookie.indexOf('private-session') >= 0); assert(!c.headers.Cookie.match(/child|evil|path_only|gone/)); return response({}); }
  });
  f.account.startQR(); await until(function () { return f.account.status().logged_in; });
  assert.equal(f.account.state.session.cookies.child, undefined);
  assert.equal(f.account.state.session.cookies.path_only, undefined);
});

test('phone login still finishes; an earlier SMS response cannot replace a newer QR session', async function (t) {
  var held = deferred(), reached = false;
  var f = fixture(t, function (c) {
    if (c.path === '/passport/mobile/sms_login/') { reached = true; return held.promise; }
  });
  var login = f.account.loginSMS('+86', '13800138000', '012345');
  var rejected = assert.rejects(login, /取消/);
  await until(function () { return reached; });
  f.account.startQR();
  held.resolve(passport({ user_id_str: '999', user_id: '999' }, { 'set-cookie': ['sessionid=old-phone; Path=/'] }));
  await rejected;
  await until(function () { return f.account.status().logged_in; });
  assert.equal(f.account.status().profile.uid, UID); assert.equal(f.account.state.session.cookies.sessionid, 'private-session');
  var phone = fixture(t, function (c) { if (c.path === '/passport/mobile/sms_login/') return passport({ user_id_str: '999', user_id: '999', screen_name: 'phone' }, { 'set-cookie': ['sessionid=phone-session; Path=/'] }); });
  await phone.account.loginSMS('+86', '13800138000', '012345');
  assert.equal(phone.account.status().profile.uid, '999'); assert.equal(phone.account.status().login_method, 'phone');
  phone.account.state.login_method = undefined; phone.account.save();
  var legacy = createAccount({ dataDir: phone.dir }); t.after(function () { legacy.close(); });
  assert.equal(legacy.status().login_method, 'phone');
});

test('HTTP QR routes enforce IDs, methods and request size, and Service shutdown cancels pending QR', async function (t) {
  var f = fixture(t, function (c) { if (c.path === '/passport/web/check_qrconnect/') return passport({ status: 'new' }); });
  var service = createService({ account: f.account, provider: {}, port: 0, service: { register: function () {} }, numberInput: { close: function () {} } });
  t.after(function () { return service.shutdown(); }); await service.ensureReady();
  function req(method, pathname, body) {
    return new Promise(function (resolve, reject) {
      var r = http.request({ hostname: '127.0.0.1', port: service.address().port, path: pathname, method: method, headers: { 'Content-Type': 'application/json', Origin: 'null' } }, function (res) {
        var chunks = []; res.on('data', function (c) { chunks.push(c); }); res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      }); r.on('error', reject); r.end(body == null ? undefined : JSON.stringify(body));
    });
  }
  var start = await req('POST', '/api/v1/account/qr/start', {}), id = start.body.data.qr_login.id;
  assert.equal(start.status, 200); assert.equal(start.headers['cache-control'], 'no-store'); assert.equal(start.headers['access-control-allow-origin'], 'null');
  assert.equal((await req('GET', '/api/v1/account/qr/status?id=' + id)).status, 200);
  assert.equal((await req('GET', '/api/v1/account/qr/status?id=old')).status, 409);
  assert.equal((await req('GET', '/api/v1/account/qr/start')).status, 405);
  assert.equal((await req('POST', '/api/v1/account/qr/cancel', { id: 'bad' })).status, 400);
  assert.equal((await req('POST', '/api/v1/account/qr/start', { token: 'bad' })).status, 400);
  assert.equal((await req('POST', '/api/v1/account/qr/start', { id: 'x'.repeat(3000) })).status, 413);
  assert.equal((await req('POST', '/api/v1/account/qr/cancel', { id: id })).body.data.qr_login.state, 'cancelled');
  f.account.startQR(); await service.shutdown(); assert.equal(f.account.status().qr_login.state, 'cancelled');
});

test('phone SMS and MFA parameters remain intact after adding QR', async function (t) {
  var logins = 0;
  var f = fixture(t, function (c) {
    if (c.path === '/passport/mobile/send_code/v1/') return passport({ retry_time: 60 });
    if (c.path === '/passport/mobile/sms_login/') {
      logins++;
      if (logins === 1) return response({ message: 'error', data: { error_code: 1001, encrypt_uid: 'encrypted', sms_code_key: 'key', verify_ways: [{ verify_way: 'upsms', channel_mobile: '1069', sms_content: 'fixture' }] } });
      return passport({ user_id_str: UID, user_id: UID }, { 'set-cookie': ['sessionid=phone-session; Path=/'] });
    }
    if (c.path === '/passport/upsms/verify/') return passport({ ticket: 'verify-ticket' });
  });
  assert.equal((await f.account.sendCode('+86', '13800138000')).sms_state, 'sent');
  assert.equal((await f.account.loginSMS('+86', '13800138000', '012345')).phase, 'mfa');
  var result = await f.account.verify(); assert.equal(result.logged_in, true); assert.equal(result.login_method, 'phone');
  var final = f.calls.filter(function (c) { return c.path === '/passport/mobile/sms_login/'; }).pop();
  var form = require('querystring').parse(final.body.toString());
  assert.equal(form.passport_mfa_retry_tag, '1'); assert.equal(form.verify_ticket, 'verify-ticket');
});

test('failed account persistence leaves the guest session intact', async function (t) {
  var f = fixture(t), original = f.account.state;
  f.account.writeState = function () { throw new Error('fixture disk failure'); };
  f.account.startQR(); await until(function () { return f.account.status().qr_login.state === 'failed'; });
  assert.equal(f.account.state, original); assert.equal(f.account.status().logged_in, false);
  assert(!fs.existsSync(path.join(f.dir, 'account.json')));
  assert(!JSON.stringify(f.account.status()).includes('fixture disk failure'));
});

test('a delayed previous account sync cannot overwrite the new QR account or its sync state', async function (t) {
  var wait = deferred(), reached = false, hold = true;
  var f = fixture(t, function (c) {
    if (c.path === '/reading/bookapi/read_history/list/v' && hold) { reached = true; return wait.promise; }
  });
  f.account.state.session.registered = true; f.account.state.profile = { uid: '999', name: 'old' };
  f.account.state.session.cookies.sessionid = 'old'; f.account.save();
  var oldSync = f.account.sync(), rejected = assert.rejects(oldSync, /切换/);
  await until(function () { return reached; }); hold = false;
  f.account.logout(); f.account.startQR();
  await until(function () { return f.account.status().logged_in && !f.account.syncing; });
  wait.resolve(response({ code: 0, data: { data_list: [], has_more: false } })); await rejected;
  assert.equal(f.account.status().profile.uid, UID); assert.equal(f.account.status().sync.state, 'idle');
  assert.equal(f.account.state.session.cookies.sessionid, 'private-session');
});
