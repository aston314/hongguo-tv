'use strict';
var assert = require('assert');
var https = require('https');
var EventEmitter = require('events');
var PassThrough = require('stream').PassThrough;
var catalog = require('./update-manifest');
var createChecker = require('./updates');
var createBridge = require('../app/webos-updates').create;
function sample(version) {
  version = version || '0.2.118';
  return { schema: 1, platform: 'webos', app_id: 'com.aston314.hongguo.webos', version_name: version,
    release_tag: 'webos-v' + version + '-test.26', release_url: 'https://github.com/aston314/hongguo-tv-releases/releases/tag/webos-v' + version + '-test.26',
    release_notes: '更新说明', artifact_name: 'hongguo-webos-' + version + '-test.26.ipk', artifact_size: 123,
    artifact_sha256: 'a'.repeat(64) };
}
function sampleChannel(version, suffix) {
  return Object.assign(sample(version), {
    release_tag: 'webos-v' + version + '-' + suffix,
    release_url: 'https://github.com/aston314/hongguo-tv-releases/releases/tag/webos-v' + version + '-' + suffix,
    artifact_name: 'hongguo-webos-' + version + '-' + suffix + '.ipk'
  });
}
function fixture() {
  var stored = {}, time = 1000000000, calls = 0, value = sample(), error = false;
  function bridge() { return createBridge({ version: '0.2.117', storage: { getItem: function (k) { return stored[k]; }, setItem: function (k,v) { stored[k] = v; } },
    now: function () { return time; }, check: function () { calls++; return error ? Promise.reject(new Error('offline')) : Promise.resolve(value); } }); }
  return { bridge: bridge, calls: function () { return calls; }, advance: function (ms) { time += ms; }, value: function (v) { value = v; }, fail: function (v) { error = v; } };
}
async function run() {
  assert(catalog.compare('0.2.100', '0.2.99') > 0);
  assert(catalog.compare('0.3.0', '0.2.999') > 0);
  assert(catalog.compare('1.0.0', '0.99.99') > 0);
  assert.throws(function () { catalog.validate(Object.assign(sample(), { platform: 'android' })); });
  assert.throws(function () { catalog.validate(Object.assign(sample(), { release_url: 'javascript:alert(1)' })); });
  assert.throws(function () { catalog.validate(Object.assign(sample(), { version_name: '0.02.118' })); });
  assert.strictEqual(catalog.validate(sampleChannel('0.2.118', 'test.27')).release_tag, 'webos-v0.2.118-test.27');
  assert.throws(function () { catalog.validate(sampleChannel('0.2.118', 'test.28')); });
  assert.throws(function () { catalog.validate(Object.assign(sampleChannel('0.2.118', 'test.27'), { artifact_name: 'hongguo-webos-0.2.118-test.26.ipk' })); });
  var routes = [];
  var checker = createChecker({ requestJSON: function (target) {
    routes.push(target);
    return routes.length < 5 ? Promise.reject(new Error('route down')) : Promise.resolve(sample());
  } });
  var same = await Promise.all([checker.check(), checker.check()]);
  assert.strictEqual(same[0].version_name, '0.2.118'); assert.strictEqual(routes.length, 5);
  assert.strictEqual(routes[4].split('?')[0], 'https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/webos-update.json');
  assert(/\?check=\d+$/.test(routes[4]));
  await assert.rejects(createChecker({ requestJSON: function () { return Promise.resolve({ platform: 'android' }); } }).check());

  var f = fixture(), b = f.bridge();
  assert.strictEqual(b.download, undefined); assert.strictEqual(b.install, undefined);
  await b.automatic(); await b.automatic(); await f.bridge().automatic();
  assert.strictEqual(f.calls(), 1, 'automatic check persists its daily limit across restarts');
  assert.strictEqual(JSON.parse(b.getStatus()).state, 'available');
  assert.strictEqual(JSON.parse(b.getStatus()).prompt_allowed, false);
  b.setPromptAllowed(true); assert.strictEqual(JSON.parse(b.getStatus()).prompt_allowed, true);
  b.markNotified('0.2.118'); assert.strictEqual(JSON.parse(f.bridge().getStatus()).notified, true);
  f.advance(86400000); await b.automatic(); assert.strictEqual(f.calls(), 2);
  await b.check(); assert.strictEqual(f.calls(), 3, 'manual retry remains available within a day');
  f.fail(true); await b.check();
  assert.strictEqual(JSON.parse(b.getStatus()).state, 'error');
  assert.strictEqual(JSON.parse(b.getStatus()).latest_version, '0.2.118', 'failed checks keep last known release details');
  assert.strictEqual(JSON.parse(f.bridge().getStatus()).state, 'error', 'restart does not turn a failed check into up-to-date');
  f.fail(false); f.value(sample('0.2.117')); await b.check();
  assert.strictEqual(JSON.parse(b.getStatus()).state, 'error', 'stale proxy catalog does not erase a known newer version');
  var equal = fixture(); equal.value(sample('0.2.117'));
  var current = equal.bridge(); await current.check(); assert.strictEqual(JSON.parse(current.getStatus()).state, 'current');
  var failed = fixture(); failed.fail(true); var failBridge = failed.bridge();
  await failBridge.automatic(); await failBridge.automatic();
  assert.strictEqual(failed.calls(), 1); assert.strictEqual(JSON.parse(failBridge.getStatus()).state, 'error');
  var broken = createBridge({ version: '0.2.117', storage: { getItem: function () { throw Error('denied'); }, setItem: function () { throw Error('denied'); } }, check: function () { return Promise.resolve(sample()); } });
  await broken.check(); assert.strictEqual(JSON.parse(broken.getStatus()).state, 'available');

  // Exercise the real HTTPS reader with deterministic transport responses.
  var original = https.get, seen = 0;
  https.get = function (target, callback) {
    var request = new EventEmitter(); request.destroy = function () {};
    process.nextTick(function () {
      var response = new PassThrough(); response.headers = {}; response.statusCode = 200;
      seen++; callback(response);
      response.end(seen === 1 ? Buffer.alloc(65537, 32) : seen === 2 ? '<html>error</html>' : JSON.stringify(sample()));
    });
    return request;
  };
  try { assert.strictEqual((await createChecker().check()).version_name, '0.2.118'); assert.strictEqual(seen, 3); }
  finally { https.get = original; }
  console.log('webOS update catalog, bounded transport, daily/manual checks, failure and notification persistence: PASS');
}
run().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
