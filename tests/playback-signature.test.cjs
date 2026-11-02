'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const signer = require('../webos/service/passport-sign');

test('playback signs the transmitted query and body with an isolated version profile', () => {
  const identity = { device_id: '7000000000000000001', iid: '7000000000000000002', cdid: 'test-cdid', version_name: '7.1.3.32', aid: '8662' };
  const original = { ...identity };
  const body = Buffer.from('{"mixed_video_id_map":{"1004":["123"]}}');
  // Exercise a ticket tuned across a second boundary as well as each AES branch.
  for (const stamp of [1800000000999, 1800000001999, 1800000002999, 1800000003999]) {
    const signed = signer.signPlayback(identity, body, stamp, identity.device_id);
    const params = new URLSearchParams(signed.query), ts = Math.floor(stamp / 1000);
    assert.deepEqual(identity, original, 'signing must not mutate caller/shared identity');
    assert.equal(params.get('ts'), String(ts));
    assert.equal(signed.headers['X-Khronos'], String(ts));
    assert.equal(signed.headers['X-SS-Req-Ticket'], params.get('_rticket'));
    assert.equal(Buffer.from(signed.headers['X-Argus'], 'base64').readUInt32LE(), ts);
    assert.equal(Buffer.from(signed.headers['X-Ladon'], 'base64').readUInt32BE(), ts);
    assert.equal(signed.headers['X-SS-STUB'], crypto.createHash('md5').update(body).digest('hex').toUpperCase());
    assert.equal(signed.headers.Cookie, undefined);
    assert.equal(signed.headers['X-Tt-Token'], undefined);
    const nonce = Buffer.from(signed.headers['X-Gorgon'], 'hex').readUInt16LE(2);
    assert.equal(signed.headers['X-Gorgon'], signer.gorgon(signed.query, body, ts, nonce));
    assert.notEqual(signed.headers['X-Gorgon'], signer.gorgon(signed.query, Buffer.concat([body, Buffer.from(' ')]), ts, nonce));
    const b = signer.branch(signed.query, body, ts);
    assert.equal((b.iv & 15) % 3, 2);
    const f13 = signer.passportF13(b.iv, ts, b.q, b.m);
    const playback = signer.passportProto(signed.query, ts, 1, identity.device_id, b.q, b.m, f13, identity.version_name);
    const account = signer.passportProto(signed.query, ts, 1, identity.device_id, b.q, b.m, f13);
    assert.equal(playback.toString().split('7.1.3.32').length - 1, 2);
    assert.equal(playback.includes(Buffer.from('7.3.5.32')), false);
    assert.equal(account.toString().split('7.3.5.32').length - 1, 2);
    assert.equal(account.includes(Buffer.from('7.1.3.32')), false);
  }
});

test('playback retry regenerates signatures and preserves the established account vectors', () => {
  const vector = require('../core/cmd/hongguotv/testdata/passport-vectors.json');
  const body = Buffer.from(vector.body), b = signer.branch(vector.query, body, vector.ts);
  assert.equal(signer.medusa(vector.query, vector.ts, 0x12345678, 0x87654321, 0x33445566, '7000000000000000001', b.iv, b.q, b.m).toString('base64'), vector.medusa);
  const params = { aid: '8662', device_id: '7000000000000000001', version_name: '7.1.3.32' };
  const one = signer.signPlayback(params, body, vector.ts * 1000, params.device_id);
  const two = signer.signPlayback(params, body, vector.ts * 1000, params.device_id);
  assert.notEqual(one.headers['X-Medusa'], two.headers['X-Medusa']);
});
