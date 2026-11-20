'use strict';
var assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
var dns = require('dns'), https = require('https');
var root = path.resolve(__dirname, '../..'), service = path.join(root, 'webos/service');
require(path.join(service, 'runtime-compat'));
var fixtureCA = fs.readFileSync(path.join(__dirname, 'webos-tls/ca.pem'), 'utf8');
var moduleState = { exports: {} };
// Use a test-only CA and force the legacy branch even under the modern VM.
// Production root fingerprints and runtime/domain scoping are checked separately.
vm.runInNewContext(fs.readFileSync(path.join(service, 'upstream-tls.js'), 'utf8'), {
  module: moduleState, __dirname: service, Object: Object, process: { versions: { node: '0.12.2' } },
  require: function (name) { return name === 'fs' ? { readFileSync: function () { return fixtureCA; } } : require(name); }
});
var policy = moduleState.exports, originalLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') callback = options;
  if (/^(api5-normal-sinfonline[ab]\.fqnovel\.com|untrusted\.invalid)$/.test(hostname)) {
    return process.nextTick(function () {
      if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    });
  }
  return originalLookup.apply(dns, arguments);
};
function request(host, port, status) {
  return new Promise(function (resolve, reject) {
    var req = https.get(policy({ protocol: 'https:', hostname: host, port: port, path: '/' + status, agent: false }), function (res) {
      assert.strictEqual(res.socket.authorized, true);
      res.resume(); res.on('end', function () { resolve(res.statusCode); });
    });
    req.on('error', reject); req.setTimeout(3000, function () { req.abort(); reject(new Error('TLS test timed out')); });
  });
}
var valid = Number(process.env.WEBOS_TEST_TLS_PORT), expired = Number(process.env.WEBOS_TEST_TLS_EXPIRED_PORT);
var host = 'api5-normal-sinfonlineb.fqnovel.com';
function rejects(promise, pattern) {
  return promise.then(function () { throw new Error('Invalid certificate accepted'); }, function (error) {
    assert(pattern.test(String(error.code) + ' ' + error.message), String(error.code) + ' ' + error.message);
    assert.strictEqual(require(path.join(service, 'network-diagnostic'))(error), 'tls', String(error.code) + ' ' + error.message);
  });
}
Promise.all([200, 404, 503].map(function (status) { return request(host, valid, status).then(function (actual) { assert.strictEqual(actual, status); }); }))
  .then(function () { return rejects(request('api5-normal-sinfonlinea.fqnovel.com', valid, 200), /ALTNAME|altnames|Hostname/); })
  .then(function () { return rejects(request(host, expired, 200), /CERT_HAS_EXPIRED/); })
  .then(function () { return rejects(request('untrusted.invalid', valid, 200), /CERT|ISSUER|SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE/); })
  .then(function () { console.log('webOS TLS ' + process.version + ': 200/404/503, wrong hostname, expiry and untrusted CA PASS'); })
  .catch(function (error) { console.error(error.stack || error); process.exit(1); });
