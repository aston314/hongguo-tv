'use strict';
var assert = require('assert');
var createAccount = require('./account');

var calls = [];
function transport(target) {
  calls.push(target);
  if (target.indexOf('log.snssdk.com') >= 0) return Promise.resolve({ status: 444, headers: {}, body: Buffer.alloc(0) });
  return Promise.resolve({
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify({ device_id_str: '7390000000000000001', install_id_str: '7390000000000000002' }))
  });
}

createAccount.registerPlaybackDevice(transport).then(function (device) {
  assert.strictEqual(device.deviceID, '7390000000000000001');
  assert.strictEqual(device.installID, '7390000000000000002');
  assert.strictEqual(calls.length, 2, 'one primary and one fallback registration');
  assert(calls[0].indexOf('log.snssdk.com') >= 0);
  assert(calls[1].indexOf('log5-applog-lq.fqnovel.com') >= 0);
  console.log('webOS playback registration falls back to log5 after HTTP 444: PASS');
}).catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
