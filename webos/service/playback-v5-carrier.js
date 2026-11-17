// SPDX-License-Identifier: GPL-3.0-only
// v5 carrier; see playback-v5-sign.js for provenance. Not standard AES.
'use strict';
var constants = require('./playback-v5-constants.json');
module.exports = function (data, ts, key, iv) {
  if (data.length < 248 || key.length !== 16 || iv.length !== 16)
    throw new Error('signature payload is too short');
  var branch = ts & 3,
    box = Buffer.from(constants.sbox, 'hex').slice(branch * 256, (branch + 1) * 256),
    con = [
      [2, 0, 3, 1],
      [1, 3, 2, 0],
      [3, 2, 1, 0],
      [2, 3, 1, 0]
    ][branch],
    orders = [
      [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
      [0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7],
      [0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7],
      [0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7]
    ][branch],
    init = [0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9][branch],
    mk = Buffer.alloc(48),
    r = 8;
  for (var j = 0; j < 16; j++) mk[j] = key[j] ^ ((init >>> ((j % 4) * 8)) & 255);
  for (j = 4; j < 12; j++) {
    var prev = Buffer.from(mk.slice(j * 4 - 4, j * 4));
    if (j % 4 === 0)
      prev = Buffer.from([
        ((init >>> (r & 24)) & 255) ^ box[prev[1]],
        box[prev[2]],
        box[prev[3]],
        box[prev[0]]
      ]);
    r += 2;
    for (var k = 0; k < 4; k++) mk[j * 4 + k] = prev[k] ^ mk[j * 4 + k - 16];
  }
  function block(src) {
    var b = Buffer.from(src),
      prev,
      z,
      index,
      col,
      aa,
      cc,
      dd,
      ee,
      t;
    function add(base) {
      for (z = 0; z < b.length; z++) b[z] ^= mk[base + Math.floor(z / 4) * 4 + con[z % 4]];
    }
    add(0);
    for (var round = 1; round <= 2; round++) {
      prev = Buffer.from(b);
      for (z = 0; z < b.length; z++) {
        index = orders[z];
        b[z] = box[prev[con[Math.floor(index / 4)] * 4 + (index % 4)]];
      }
      if (round === 1) {
        prev = Buffer.from(b);
        for (z = 0; z < b.length; z++) b[z] = prev[Math.floor(z / 4) * 4 + con[z % 4]];
        function xt(x) {
          return x & 128 ? ((x << 1) ^ 0x1b) & 255 : (x << 1) & 255;
        }
        for (col = 0; col < 4; col++) {
          aa = b[col];
          cc = b[4 + col];
          dd = b[8 + col];
          ee = b[12 + col];
          t = aa ^ cc ^ dd ^ ee;
          b[col] ^= t ^ xt(aa ^ cc);
          b[4 + col] ^= t ^ xt(cc ^ dd);
          b[8 + col] ^= t ^ xt(dd ^ ee);
          b[12 + col] ^= t ^ xt(ee ^ aa);
        }
      }
      add(round * 16);
    }
    for (z = 0; z < b.length; z++) b[z] ^= mk[16 + z];
    return b;
  }
  var wire = [6, 5, 3, 4, 2, 7, 1, 0],
    compact = [1, 7, 3, 6, 2, 0, 4, 5],
    plain = Buffer.alloc(32);
  for (j = 0; j < 31; j++)
    for (k = 0; k < 8; k++) plain[j] |= ((data[j * 8 + k] >>> wire[k]) & 1) << compact[k];
  plain[31] = 1;
  var previous = Buffer.from(iv),
    encrypted = Buffer.alloc(32);
  for (j = 0; j < 32; j += 16) {
    for (k = 0; k < 16; k++) plain[j + k] ^= previous[k];
    previous = block(plain.slice(j, j + 16));
    previous.copy(encrypted, j);
  }
  var out = Buffer.concat([Buffer.from([encrypted[31]]), data]);
  for (j = 0; j < 31; j++)
    for (k = 0; k < 8; k++) {
      var at = 1 + j * 8 + k;
      out[at] = (out[at] & ~(1 << wire[k])) | (((encrypted[j] >>> compact[k]) & 1) << wire[k]);
    }
  return out;
};
