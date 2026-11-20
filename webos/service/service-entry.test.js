'use strict';

var assert = require('assert');
var fs = require('fs');
var http = require('http');
var path = require('path');
var vm = require('vm');
var createService = require('./service');
var entry = require('./package.json').main;
var handlers = {};
var starts = 0;
var instance;
var loaded = { exports: {} };
function loader(name) {
  if (name === './runtime-compat') return require(name);
  assert.strictEqual(name, './service');
  return function () {
    starts++;
    instance = createService({
      service: { register: function (name, handler) { handlers[name] = handler; } },
      provider: {}, account: {}, numberInput: { close: function () {} }, port: 0
    });
    return instance;
  };
}
// A TV launcher requires the package entry; the entry is not require.main.
loader.main = { filename: '/usr/palm/services/jsservicelauncher/bootstrap-node.js' };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, entry), 'utf8'), {
  require: loader, module: loaded, console: console, process: process,
  Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout, Buffer: Buffer
}, { filename: entry });

async function run() {
  try {
    assert.strictEqual(starts, 1, 'requiring the packaged entry must construct the service');
    assert.deepStrictEqual(Object.keys(handlers).sort(), ['getDiagnostics', 'ping', 'shutdown']);
    assert.strictEqual(instance.address(), null, 'HTTP starts lazily on ping');
    function ping() { return new Promise(function (resolve) { handlers.ping({ respond: resolve }); }); }
    var replies = await Promise.all([ping(), ping()]);
    assert(replies.every(function (reply) { return reply.returnValue && reply.ready; }));
    assert.strictEqual(starts, 1, 'concurrent pings share the same instance');
    var health = await new Promise(function (resolve, reject) {
      http.get('http://127.0.0.1:' + instance.address().port + '/api/v1/health', function (response) {
        var body = '';
        response.on('data', function (chunk) { body += chunk; });
        response.on('end', function () { resolve({ status: response.statusCode, body: JSON.parse(body) }); });
      }).on('error', reject);
    });
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ready, true);
    console.log('webOS packaged bootstrap entry registers Luna methods and starts HTTP on ping: PASS');
  } finally {
    if (instance) await instance.shutdown();
  }
}
run().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
