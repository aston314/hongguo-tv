// SPDX-License-Identifier: GPL-3.0-only
// Playback-only v5 protocol port from N3urda/hongguoTV 18c37c2;
// Signer.kt/AesV3.kt/V5Constants.kt (derived from drpys 22261ad).
'use strict';
var crypto = require('crypto');
var passport = require('./passport-sign');
var constants = require('./playback-v5-constants.json');
var carrier = require('./playback-v5-carrier');
var MAGIC = Buffer.from(constants.magic, 'hex'),
  KEY = Buffer.from(constants.key, 'hex');
var started = Date.now(),
  processNonce = crypto
    .randomBytes(18)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
function le32(n) {
  var b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function rol(x, n) {
  n &= 31;
  return ((x << n) | (x >>> ((32 - n) & 31))) >>> 0;
}
function rol8(x, n) {
  return ((x << n) | (x >>> (8 - n))) & 255;
}
function md5(b) {
  return crypto.createHash('md5').update(b).digest();
}
function f13(q, m, ts) {
  var seed = 0x9d4a97c2,
    count = (seed + ts) >>> 0,
    pad = Buffer.from([0xfa, 0x45, 0x61, 0xd7]);
  for (var i = 0; i < 4; i++) pad[i] = (pad[i] * 257) >>> ((count + 2) & 7);
  var data = Buffer.concat([q, m, le32(ts), pad, Buffer.from('00000000000001a0', 'hex')]),
    words = new Array(128);
  for (i = 0; i < 16; i++) words[i] = data.readUInt32BE(i * 4);
  for (i = 0; i < 112; i++) {
    var x = words[i + 1],
      y = words[i + 14];
    words[i + 16] =
      (words[i] +
        words[i + 9] +
        ((rol(x, 14) ^ rol(x, 25) ^ (x >>> 3)) >>> 0) +
        ((rol(y, 13) ^ rol(y, 15) ^ (y >>> 10)) >>> 0)) >>>
      0;
  }
  var initial = [
    0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f, 984304912, 3005047866, 2874125293, 2152413264
  ].map(function (n) {
    return rol(n, -(count & 31));
  });
  var d = initial.slice();
  for (i = 0; i < 96; i++) {
    var base = (seed + i) >>> 0,
      n1 = (((d[4] ^ d[0]) & d[1]) ^ d[4]) >>> 0;
    var n2 = (rol(d[1], 26) ^ rol(d[1], 21) ^ rol(d[1], 7)) >>> 0;
    var n4 =
      (words[base & 127] +
        n1 +
        n2 +
        rol(constants.hashTable[base & 63], -((count + 1) & 31)) +
        d[6]) >>>
      0;
    var n5 = (rol(d[3], 30) ^ rol(d[3], 19) ^ rol(d[3], 10)) >>> 0;
    var n6 = ((d[3] & d[5]) | ((d[3] | d[5]) & d[2])) >>> 0,
      old = d[7];
    d.unshift(d.pop());
    d[7] = (n5 + n6 + n4) >>> 0;
    d[0] = (old + n4) >>> 0;
  }
  var ret = Buffer.alloc(32),
    out = Buffer.alloc(20);
  for (i = 0; i < 8; i++) ret.writeUInt32BE((d[i] + initial[i]) >>> 0, i * 4);
  for (i = 0; i < 16; i++) out[i] = ret[i] ^ ret[i + 16];
  var check = 0x20220420;
  for (i = 0; i < 12; i++)
    check =
      (i & 1
        ? (check >>> 5) ^ check ^ ~(out[i] | (check << 11))
        : (check >>> 3) ^ check ^ out[i] ^ (check << 7)) >>> 0;
  out.writeUInt32LE((((check | 4) ^ 0x1000000) | 0x20) >>> 0, 16);
  return out;
}
function varint(out, n) {
  while (n > 127) {
    out.push(n % 128 | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
}
function sint(out, tag, n) {
  varint(out, tag * 8);
  varint(out, n < 0 ? -n * 2 - 1 : n * 2);
}
function blob(out, tag, value) {
  if (!value.length) return;
  varint(out, tag * 8 + 2);
  varint(out, value.length);
  for (var i = 0; i < value.length; i++) out.push(value[i]);
}
function text(out, tag, value) {
  blob(out, tag, Buffer.from(value));
}
function proto(values, ts, nonce, q, hash, process) {
  var device = [],
    env = [],
    counters = [],
    p = [];
  sint(device, 1, 1);
  sint(device, 2, 2);
  text(device, 3, '8662');
  text(device, 4, values.device_id);
  text(device, 5, process.nonce);
  text(device, 6, '!noperm!');
  text(device, 12, 'Asia/Shanghai,8');
  text(device, 13, 'zh_CN');
  text(device, 22, values.os_version);
  sint(device, 25, process.started);
  text(device, 30, values.device_type);
  text(device, 31, 'HONOR');
  text(device, 32, values.device_type);
  text(device, 34, 'HONOR');
  text(env, 6, 'v04.10.03.04-bugfix');
  text(env, 8, values.channel);
  blob(env, 12, device);
  text(env, 14, values.version_name);
  [1, 2, 3, 5].forEach(function (n) {
    sint(counters, n, 1);
  });
  blob(p, 1, MAGIC);
  sint(p, 2, 5);
  sint(p, 3, nonce);
  text(p, 4, '8662');
  text(p, 5, values.device_id);
  text(p, 6, '646637794');
  text(p, 7, values.version_name);
  text(p, 8, 'v04.10.03-ml-android');
  sint(p, 9, 0x040a0300);
  blob(p, 10, Buffer.alloc(8));
  sint(p, 12, ts);
  blob(p, 13, hash);
  blob(p, 14, q.slice(0, 6));
  blob(p, 15, counters);
  sint(p, 17, ts);
  text(p, 20, 'none');
  // v04.10.03 uses wire value 738; 754 receives HTTP 200 / an empty body.
  sint(p, 21, 369);
  blob(p, 23, env);
  text(
    p,
    24,
    '{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}'
  );
  return Buffer.from(p);
}
function medusa(values, ts, q, m, n, process) {
  var hash = f13(q, m, ts),
    message = proto(values, ts, n[0], q, hash, process);
  var key = passport.sm3(Buffer.concat([KEY, le32(n[1]), KEY])),
    high = (n[1] >>> 16) & 255;
  var seed = le32(~(((high << 11) | (n[1] >>> 24)) ^ (high >>> 5) ^ high));
  var transformed = Buffer.concat([Buffer.alloc(8), xmxor(message, key)]).reverse();
  for (var i = 0; i < transformed.length; i++) transformed[i] ^= seed[~i & 3];
  var check = (0x18000001 | ((q[0] & 63) << 14) | ((hash[0] & 63) << 8)) >>> 0;
  var packed = Buffer.concat([
    Buffer.from([0xca]),
    le32(n[2]),
    le32(check),
    transformed,
    le32(n[1]).slice(2)
  ]);
  var encrypted = carrier(packed, ts, md5(KEY.slice(0, 16)), md5(KEY.slice(16)));
  var prefix = Buffer.concat([le32(5), MAGIC]),
    timestamp = le32(ts);
  for (i = 0; i < prefix.length; i++) prefix[i] ^= timestamp[i & 3];
  return Buffer.concat([prefix, le32(n[1]).slice(0, 2), Buffer.from([0, 1]), encrypted]).toString(
    'base64'
  );
}
function tune(values, body, stamp) {
  return tuneKeys(values, body, stamp, [
    'aid',
    'app_name',
    'version_code',
    'version_name',
    'manifest_version_code',
    'channel',
    'device_platform',
    'device_type',
    'os_version',
    'update_version_code',
    'iid',
    'cdid',
    'device_id',
    '_rticket'
  ]);
}
function tuneKeys(values, body, stamp, keys) {
  for (var offset = 0; offset < 1024; offset++) {
    var query = keys
      .map(function (key) {
        var value = key === '_rticket' ? String(stamp + offset) : values[key];
        return (
          key +
          '=' +
          encodeURIComponent(value).replace(/[!'()*]/g, function (c) {
            return '%' + c.charCodeAt(0).toString(16).toUpperCase();
          })
        );
      })
      .join('&');
    var b = passport.branch(query, body, Math.floor(stamp / 1000));
    if ((b.iv & 15) === 12) return { query: query, q: b.q, m: b.m };
  }
  throw new Error('unable to select v5 signature branch');
}
function sign(values, body, stamp) {
  return signKeys(values, body, stamp, [
    'aid',
    'app_name',
    'version_code',
    'version_name',
    'manifest_version_code',
    'channel',
    'device_platform',
    'device_type',
    'os_version',
    'update_version_code',
    'iid',
    'cdid',
    'device_id',
    '_rticket'
  ]);
}
function signKeys(values, body, stamp, keys) {
  var tuned = tuneKeys(values, body, stamp, keys),
    ts = Math.floor(stamp / 1000) >>> 0;
  var n = [0, 0, 0, 0].map(function () {
    return crypto.randomBytes(4).readUInt32LE(0);
  });
  return {
    query: tuned.query,
    headers: {
      'X-Khronos': String(ts),
      'X-Helios': helios(ts, n[3]),
      'X-Medusa': medusa(values, ts, tuned.q, tuned.m, n, {
        nonce: processNonce,
        started: started
      }),
      'X-SS-STUB': tuned.m.toString('hex').toUpperCase()
    }
  };
}
function pair(lo, hi) {
  return { lo: lo >>> 0, hi: hi >>> 0 };
}
function pairReadLE(b, o) {
  return pair(b.readUInt32LE(o), b.readUInt32LE(o + 4));
}
function pairWriteLE(b, o, x) {
  b.writeUInt32LE(x.lo >>> 0, o);
  b.writeUInt32LE(x.hi >>> 0, o + 4);
}
function pairXor(a, b) {
  return pair(a.lo ^ b.lo, a.hi ^ b.hi);
}
function pairAdd(a, b) {
  var lo = (a.lo + b.lo) >>> 0;
  return pair(lo, (a.hi + b.hi + (lo < a.lo ? 1 : 0)) >>> 0);
}
function pairRotl(a, n) {
  n &= 63;
  if (!n) return pair(a.lo, a.hi);
  if (n === 32) return pair(a.hi, a.lo);
  if (n < 32) return pair((a.lo << n) | (a.hi >>> (32 - n)), (a.hi << n) | (a.lo >>> (32 - n)));
  n -= 32;
  return pair((a.hi << n) | (a.lo >>> (32 - n)), (a.lo << n) | (a.hi >>> (32 - n)));
}
function pairRotr(a, n) {
  return pairRotl(a, 64 - (n & 63));
}
function helios(ts, nonce) {
  var key = md5(Buffer.concat([le32(nonce), Buffer.from('8662')]));
  var raw = Buffer.from(key.toString('hex'));
  var k = pairReadLE(raw, 0),
    pending = [pairReadLE(raw, 8), pairReadLE(raw, 16), pairReadLE(raw, 24)],
    rounds = [k];
  for (var i = 0; i < 33; i++) {
    var x = pairXor(pairAdd(pairRotr(pending[0], 8), k), pair(i, 0));
    pending = [pending[1], pending[2], x];
    k = pairXor(x, pairRotl(k, 3));
    rounds.push(k);
  }
  var text = Buffer.from(String(ts) + '-646637794-8662'),
    pad = 16 - (text.length % 16),
    plain = Buffer.concat([text, Buffer.alloc(pad, pad)]),
    out = Buffer.concat([le32(nonce), Buffer.alloc(plain.length)]);
  for (var at = 0; at < plain.length; at += 16) {
    var a = pairReadLE(plain, at),
      b = pairReadLE(plain, at + 8);
    for (i = 0; i < rounds.length; i++) {
      b = pairXor(rounds[i], pairAdd(a, pairRotr(b, 8)));
      a = pairXor(b, pairRotl(a, 3));
    }
    pairWriteLE(out, 4 + at, a);
    pairWriteLE(out, 12 + at, b);
  }
  return out.toString('base64');
}

function xmxor(data, key) {
  var out = Buffer.alloc(data.length);
  for (var i = 0; i < data.length; i++) {
    var k = (i * 4) & 28,
      a = key[k],
      b = key[k + 1],
      v = (~(rol8(data[i], 4) + a) ^ b) & 255;
    v = (rol8(v, 3) + b) & 255;
    out[out.length - 1 - i] = ~(v ^ a) & 255;
  }
  var flag = out[out.length - 1] ^ out[out.length - 2],
    old = out[0];
  out[0] = (out[0] + ~flag) & 255;
  out[1] = (out[1] + (out[0] ^ out[out.length - 1] ^ 254)) & 255;
  out[2] = (out[2] + ((flag - old) ^ rol8(out[1], 3) ^ 2)) & 255;
  for (i = 0; i < out.length - 4; i++)
    out[i + 3] = (out[i + 3] + ~(rol8(out[i + 2], 3) ^ out[i + 1] ^ (i + 3))) & 255;
  out[out.length - 1] ^= out[out.length - 2];
  var sum = 0;
  for (i = 1; i < out.length; i++) sum = (sum + out[i]) & 255;
  out[0] = ((out[0] ^ out[1]) + sum) & 255;
  return out;
}

module.exports = { sign: sign, signKeys: signKeys, tune: tune, tuneKeys: tuneKeys, f13: f13, medusa: medusa, helios: helios };
