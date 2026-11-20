'use strict';
// Deliberately ES5: this file is executed by the actual Node 0.12.2 binary.
var assert = require('assert'), fs = require('fs'), path = require('path');
var http = require('http'), net = require('net'), vm = require('vm'), Module = require('module');
var root = path.resolve(__dirname, '../..'), serviceRoot = path.join(root, 'webos/service');
var originals = [Buffer.from, Buffer.alloc, Buffer.prototype.reverse, Object.assign, Array.from, Array.prototype.find, Array.prototype.findIndex, Number.isSafeInteger];
function scan(directory) {
  fs.readdirSync(directory).forEach(function (name) {
    var file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) return scan(file);
    if (/\.js$/.test(name) && !/\.test\.js$/.test(name)) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  });
}
scan(serviceRoot);
var handlers = {}, originalLoad = Module._load;
Module._load = function (name) {
  if (name === 'webos-service') return function () {
    this.register = function (method, handler) { handlers[method] = handler; };
  };
  return originalLoad.apply(this, arguments);
};
var instance, timer = setTimeout(function () { console.error('Legacy service probe timed out'); process.exit(1); }, 12000);
function failed(error) { console.error(error.stack || error); process.exit(1); }
function method(name) { return new Promise(function (resolve) { handlers[name]({ respond: resolve }); }); }
function get(route) {
  return new Promise(function (resolve, reject) {
    http.get('http://127.0.0.1:' + instance.address().port + route, function (res) {
      var text = ''; res.on('data', function (chunk) { text += chunk; });
      res.on('end', function () { resolve({ status: res.statusCode, data: JSON.parse(text) }); });
      res.on('error', reject);
    }).on('error', reject);
  });
}
// Allocate a local ephemeral port without touching the developer's running app.
var reservation = net.createServer();
reservation.listen(0, '127.0.0.1', function () {
  process.env.HONGGUO_WEBOS_PORT = String(reservation.address().port);
  reservation.close(function () {
    try {
      // Actual packaged entry and complete production graph; only the LG-only
      // Luna binding is replaced. Provider/account/signers/storage are real.
      instance = require(path.join(serviceRoot, require(path.join(serviceRoot, 'package.json')).main));
      Module._load = originalLoad;
      var current = [Buffer.from, Buffer.alloc, Buffer.prototype.reverse, Object.assign, Array.from, Array.prototype.find, Array.prototype.findIndex, Number.isSafeInteger];
      originals.forEach(function (value, index) { if (value) assert.strictEqual(current[index], value, 'native API replaced'); });
      assert.deepEqual(Object.keys(handlers).sort(), ['getDiagnostics', 'ping', 'shutdown']);
      assert.strictEqual(instance.address(), null);
      assert.strictEqual(Buffer.alloc(32).toString('hex'), new Array(65).join('0'));
      assert.strictEqual(Buffer.alloc(4, 0xab).toString('hex'), 'abababab');
      var source = Buffer.from([1, 2, 3]), copy = Buffer.from(source); copy[0] = 9;
      assert.strictEqual(source[0], 1); assert.strictEqual(copy.reverse(), copy);
      assert.strictEqual(copy.toString('hex'), '030209');
      assert.throws(function () { Buffer.from(16); }, TypeError);
      assert.strictEqual(Array.from('剧😂\ud800').length, 3);
      assert.strictEqual([1, 2, 3].find(function (v) { return v === 2; }), 2);
      assert.strictEqual([1, 2, 3].findIndex(function (v) { return v === 3; }), 2);
      assert.strictEqual(Object.keys(Array.prototype).indexOf('find'), -1);
      assert.strictEqual(Number.isSafeInteger(9007199254740992), false);
      assert.strictEqual(Number.isFinite('12'), false);
      require(path.join(serviceRoot, 'passport-sign.test.js'));
      var signer = require(path.join(serviceRoot, 'playback-v5-sign'));
      var carrier = require(path.join(serviceRoot, 'playback-v5-carrier'));
      var profile = require(path.join(serviceRoot, 'mobile-playback-v5'));
      var vectors = function (name) { return require(path.join(root, 'core/cmd/hongguotv/testdata/signing-v5-' + name + '.json')); };
      vectors('f13').forEach(function (v) { assert.strictEqual(signer.f13(Buffer.from(v.query, 'hex'), Buffer.from(v.body, 'hex'), v.ts).slice(0, 16).toString('hex'), v.digest); });
      vectors('carrier').forEach(function (v) { assert.strictEqual(carrier(Buffer.from(v.source, 'hex'), v.ts, Buffer.from(v.key, 'hex'), Buffer.from(v.iv, 'hex')).toString('hex'), v.encrypted); });
      vectors('wire').forEach(function (v) {
        var values = profile.query({ deviceID: '123', installID: '456', cdid: 'synthetic' });
        var tuned = signer.tune(values, Buffer.from(v.body, 'hex'), v.ts * 1000);
        assert.strictEqual(tuned.query, v.query);
        assert.strictEqual(signer.medusa(values, v.ts, tuned.q, tuned.m, [0x80000000, 0x80000000, 0x80000000], { nonce: 'synthetic', started: 1800000000000 }), v.medusa);
        assert.strictEqual(signer.helios(v.ts, 0x80000000), v.helios);
      });
      // International signer previously used String#padStart on this path.
      var international = require(path.join(serviceRoot, 'passport-sign')).signInternational({ aid: '8662' }, Buffer.alloc(0), 1800000000000);
      assert(/^00-[a-f0-9]{26}-[a-f0-9]{16}-01$/.test(international.headers['X-TT-Trace-Id']));
    } catch (error) { failed(error); return; }
    Promise.all([method('ping'), method('ping')]).then(function (replies) {
      replies.forEach(function (reply) { assert.strictEqual(reply.returnValue, true); assert.strictEqual(reply.ready, true); });
      return Promise.all(['/api/v1/health', '/api/v1/status', '/api/v1/diagnostics'].map(get));
    }).then(function (responses) {
      responses.forEach(function (res) { assert.strictEqual(res.status, 200); assert.strictEqual(res.data.ready, true); });
      return method('getDiagnostics');
    }).then(function (reply) {
      assert.strictEqual(reply.status.ready, true);
      return method('shutdown');
    }).then(function (reply) {
      assert.strictEqual(reply.returnValue, true); assert.strictEqual(instance.address(), null);
      clearTimeout(timer); console.log('webOS runtime ' + process.version + ': syntax, production bootstrap, signing, HTTP health/status and shutdown PASS');
    }).catch(failed);
  });
});
