'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var sign = require('./passport-sign');
var vector = JSON.parse(fs.readFileSync(path.join(__dirname, '../../core/cmd/hongguotv/testdata/passport-vectors.json'), 'utf8'));
var body = Buffer.from(vector.body);
var branch = sign.branch(vector.query, body, vector.ts);
assert.strictEqual(branch.iv, vector.iv);
assert.strictEqual(branch.q.toString('hex'), vector.sm3);
assert.strictEqual(sign.passportF13(branch.iv, vector.ts, branch.q, branch.m).toString('hex'), vector.f13);
assert.strictEqual(sign.passportProto(vector.query, vector.ts, 0x12345678, '7000000000000000001', branch.q, branch.m, Buffer.from(vector.f13, 'hex')).toString('hex'), vector.proto);
assert.strictEqual(sign.helios(vector.ts, 0x12345678), vector.helios);
assert.strictEqual(sign.gorgon(vector.query, body, vector.ts, 0x4567), vector.gorgon);
assert.strictEqual(sign.medusa(vector.query, vector.ts, 0x12345678, 0x87654321, 0x33445566, '7000000000000000001', branch.iv, branch.q, branch.m).toString('base64'), vector.medusa);
vector.aes_v3.forEach(function (expected, index) {
  var data = Buffer.alloc(256);
  for (var i = 0; i < data.length; i++) data[i] = i;
  assert.strictEqual(sign.aesV3(data, vector.ts + index).toString('hex'), expected);
});
console.log('webOS Passport signature vectors: PASS');

// Match the Go client: an absent request body must omit the checksum header.
// Sending X-SS-STUB: "" makes the reservation endpoint return HTTP 200 empty.
var empty = sign.sign({ aid: '8662' }, Buffer.alloc(0), vector.ts * 1000, '7000000000000000001');
assert.strictEqual(Object.prototype.hasOwnProperty.call(empty.headers, 'X-SS-STUB'), false);
var posted = sign.sign({ aid: '8662' }, body, vector.ts * 1000, '7000000000000000001');
assert.strictEqual(posted.headers['X-SS-STUB'], require('crypto').createHash('md5').update(body).digest('hex').toUpperCase());
console.log('webOS empty-body signature headers match Go: PASS');
