'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var source = fs.readFileSync(path.join(__dirname, 'webos-adapter.js'), 'utf8');
var lunaCalls = [];
var listeners = {};
var documentListeners = {};
var fetchCalls = [];
var lunaOptions = [];
var failNextPingWithTimeout = false;
var healthPayload = { ok: true, ready: true, port: 7655 };
var healthFails = false;
var cacheCalls = [];
var rejectNextCacheUpdate = false;
var updateChecks = 0;
var window = {
  Promise: Promise,
  setTimeout: function (callback, delay) { return delay === 5000 ? null : setTimeout(callback, delay); },
  clearTimeout: clearTimeout,
  Request: function (url, options) { this.url = url; this.options = options; },
  fetch: function (input, options) {
    fetchCalls.push({ input: input, options: options });
    if (String(input).indexOf('/api/v1/health') >= 0) {
      return healthFails ? Promise.resolve({ ok: false, status: 503 }) : Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(healthPayload); } });
    }
    if (String(input).indexOf('/api/v1/webos/update') >= 0) {
      updateChecks++;
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true, data: {
        schema: 1, platform: 'webos', app_id: 'com.aston314.hongguo.webos', version_name: '0.2.117',
        release_tag: 'webos-v0.2.117-test.26', release_url: 'https://github.com/aston314/hongguo-tv-releases/releases/tag/webos-v0.2.117-test.26',
        release_notes: '测试说明', artifact_name: 'hongguo-webos-0.2.117-test.26.ipk', artifact_size: 123, artifact_sha256: 'a'.repeat(64)
      } }); } });
    }
    if (String(input).indexOf('/api/v1/player/cache-session') >= 0) {
      if (options.keepalive) return Promise.reject(new TypeError('Preflight request for request with keepalive specified is currently not supported'));
      var body = JSON.parse(options.body); cacheCalls.push(body);
      if (body.action === 'update' && rejectNextCacheUpdate) {
        rejectNextCacheUpdate = false;
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true, data: { accepted: false } }); } });
      }
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true, data: body.action === 'open' ? { session: 'test-session', accepted: true } : { accepted: true } }); } });
    }
    return Promise.resolve({ ok: true });
  },
  Element: { prototype: { setAttribute: function (name, value) { this[name] = value; }, removeAttribute: function (name) { delete this[name]; if (name === 'src') this._src = ''; } } },
  HTMLMediaElement: function () {},
  HongguoWebOSUpdates: require('./webos-updates'),
  XMLHttpRequest: function () {},
  addEventListener: function (name, callback) { listeners[name] = callback; },
  webOS: { service: { request: function (uri, options) {
    lunaCalls.push(uri);
    lunaOptions.push(options);
    if (options.method === 'ping' && failNextPingWithTimeout) {
      failNextPingWithTimeout = false;
      setTimeout(function () { options.onFailure({ errorCode: 'LUNA_TIMEOUT', errorText: 'Luna 命令响应超时' }); }, 0);
      return {};
    }
    setTimeout(function () { options.onSuccess({ returnValue: true, ok: true, ready: true }); }, 0);
    return {};
  } } }
};
window.HTMLMediaElement.prototype = {};
window.HTMLMediaElement.prototype.setAttribute = function (name, value) { this[name] = value; };
Object.defineProperty(window.HTMLMediaElement.prototype, 'src', {
  configurable: true,
  get: function () { return this._src; },
  set: function (value) { this._src = value; }
});
window.XMLHttpRequest.prototype.open = function (method, url, async) {
  this.method = method;
  this.url = url;
  this.async = async;
  this.readyState = 1;
};
window.XMLHttpRequest.prototype.send = function (body) { this.body = body; this.sent = true; };
var document = {
  hidden: false,
  addEventListener: function (name, callback) { documentListeners[name] = callback; }
};

vm.runInNewContext(source.replace("appVersion: ''", "appVersion: '0.2.117'"), { window: window, document: document, Promise: Promise, Array: Array, Object: Object, String: String, JSON: JSON });

async function run() {
  var media = '/minireel-proxy/media/0123456789abcdef01234567.mp4';
  var absoluteMedia = 'http://127.0.0.1:7655' + media;
  assert(window.HongguoWebOS.sameMediaSource(absoluteMedia, media));
  assert(window.HongguoWebOS.sameMediaSource(media, absoluteMedia));
  assert(window.HongguoWebOS.sameMediaSource(absoluteMedia, absoluteMedia));
  assert(!window.HongguoWebOS.sameMediaSource('http://example.com' + media, media));
  assert(!window.HongguoWebOS.sameMediaSource(absoluteMedia + '?other=1', media));
  assert(!window.HongguoWebOS.sameMediaSource(null, media));
  assert(!window.HongguoWebOS.sameMediaSource('', ''));
  assert.strictEqual(window.HongguoWebOS.mediaPath(absoluteMedia), media);
  assert.strictEqual(window.HongguoWebOS.mediaPath(media), media);
  assert.strictEqual(window.HongguoWebOS.mediaPath('http://example.com' + media), '');
  assert.strictEqual(window.HongguoWebOS.mediaPath(absoluteMedia + '?key=secret'), '');
  var video = new window.HTMLMediaElement();
  video.src = media;
  assert.strictEqual(video.src, absoluteMedia, 'the DOM keeps the real rewritten address');
  assert(window.HongguoWebOS.sameMediaSource(video.src, media));

  var xhr = new window.XMLHttpRequest();
  xhr.open('GET', '/api/v1/status', true);
  assert.strictEqual(xhr.url, 'http://127.0.0.1:7655/api/v1/status');
  xhr.send();
  await new Promise(function (resolve) { setTimeout(resolve, 5); });
  assert.strictEqual(xhr.sent, true, 'XHR send waits for the service ping and then runs');
  assert(lunaCalls.indexOf('luna://com.aston314.hongguo.webos.service') >= 0);
  assert(lunaOptions.some(function (options) { return options.method === 'ping'; }), 'webOS service calls use the compatible method option');

  await window.fetch('/api/v1/lists/recommend');
  assert.strictEqual(fetchCalls[0].input, 'http://127.0.0.1:7655/api/v1/health', 'health is checked after Luna ping');
  assert(fetchCalls.some(function (call) { return call.input === 'http://127.0.0.1:7655/api/v1/lists/recommend'; }));
  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  assert.strictEqual(cacheCalls.filter(function (call) { return call.action === 'open'; }).length, 1);
  assert.strictEqual(cacheCalls[cacheCalls.length - 1].token, '0123456789abcdef01234567', 'playing source has a lease independent of active HTTP requests');
  assert(fetchCalls.filter(function (call) { return String(call.input).indexOf('/api/v1/player/cache-session') >= 0; }).every(function (call) { return !call.options.keepalive; }), 'webOS 6 cache leases must not require unsupported keepalive preflights');
  var second = '/minireel-proxy/media/aaaaaaaaaaaaaaaaaaaaaaaa.mp4';
  video.removeAttribute('src'); video.setAttribute('src', second); video.src = media;
  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  assert.strictEqual(cacheCalls[cacheCalls.length - 1].token, '0123456789abcdef01234567', 'rapid switches keep the newest source');
  video.removeAttribute('src');
  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  assert.strictEqual(cacheCalls[cacheCalls.length - 1].token, '', 'removing the source releases playback even with no media requests');
  video.src = media;
  rejectNextCacheUpdate = true;
  video.src = second;
  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  assert.strictEqual(cacheCalls.filter(function (call) { return call.action === 'open'; }).length, 2, 'service restart renews the active session without waiting for another source change');
  assert.strictEqual(cacheCalls[cacheCalls.length - 1].token, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.strictEqual(window.HongguoWebOS.getDiagnostic().code, 'READY');

  await window.HongguoTVUpdates.check();
  assert.strictEqual(updateChecks, 1);
  assert.strictEqual(JSON.parse(window.HongguoTVUpdates.getStatus()).state, 'current');
  assert.strictEqual(window.HongguoTVUpdates.install, undefined);
  assert.strictEqual(window.HongguoTVUpdates.download, undefined);

  failNextPingWithTimeout = true;
  documentListeners.visibilitychange();
  await window.HongguoWebOS.wakeService();
  assert.strictEqual(window.HongguoWebOS.getDiagnostic().code, 'READY', 'a timed-out cold-start ping is retried once before the service is marked unavailable');
  assert.strictEqual(lunaOptions.filter(function (options) { return options.method === 'ping'; }).length, 3, 'the delayed service is reached by the bounded retry');

  var lunaRequest = window.webOS.service.request;
  window.webOS.service.request = function (uri, options) {
    if (options.method === 'ping') setTimeout(function () { options.onSuccess({ returnValue: false, code: 'EADDRINUSE', stage: 'http_bind', message: 'port is occupied' }); }, 0);
    else lunaRequest(uri, options);
  };
  documentListeners.visibilitychange();
  await new Promise(function (resolve) { setTimeout(resolve, 5); });
  await assert.rejects(window.HongguoWebOS.wakeService(), function (error) {
    return error.code === 'EADDRINUSE' && error.stage === 'http_bind';
  });
  assert.strictEqual(window.HongguoWebOS.getDiagnostic().code, 'EADDRINUSE');

  window.webOS.service.request = lunaRequest;
  healthFails = true;
  await assert.rejects(window.HongguoWebOS.wakeService(), function (error) {
    return error.code === 'HEALTH_HTTP_FAILED' && error.stage === 'http_health';
  });
  assert.strictEqual(window.HongguoWebOS.getDiagnostic().code, 'HEALTH_HTTP_FAILED');
  healthFails = false;

  document.hidden = true;
  documentListeners.visibilitychange();
  await new Promise(function (resolve) { setTimeout(resolve, 5); });
  assert.strictEqual(lunaCalls.indexOf('luna://com.aston314.hongguo.webos.service/shutdown'), -1, 'backgrounding keeps the local media service available');

  document.hidden = false;
  documentListeners.visibilitychange();
  await new Promise(function (resolve) { setTimeout(resolve, 5); });
  assert(lunaOptions.filter(function (options) { return options.method === 'ping'; }).length >= 2);
  listeners.pagehide();
  await new Promise(function (resolve) { setTimeout(resolve, 5); });
  assert(lunaOptions.some(function (options) { return options.method === 'shutdown'; }));
  assert(cacheCalls.some(function (call) { return call.action === 'close'; }), 'page exit releases its session');
  listeners.pageshow();
  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  assert.strictEqual(cacheCalls.filter(function (call) { return call.action === 'open'; }).length, 3, 'restoring a frozen page creates a fresh session');
  console.log('webOS adapter routing, health checks, and error diagnostics: PASS');
}

run().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
