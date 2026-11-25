'use strict';
// Executed by the real old Node binary in CI, without transpilation/polyfills.
var assert = require('assert'), fs = require('fs'), path = require('path');
var ui = path.resolve(__dirname, '../../../core/cmd/hongguotv/ui');
var api = require(path.join(ui, 'chinese-content.js'));
var input = fs.readFileSync(path.join(ui, 'chinese-content/s2twp.bin'));
var buffer = new ArrayBuffer(input.length), bytes = new Uint8Array(buffer);
for (var i = 0; i < input.length; i++) bytes[i] = input[i];
var converter = api.loadDictionary(buffer, JSON.parse(fs.readFileSync(path.join(ui, 'chinese-content/index.json'), 'utf8'))).converter('s2twp');
var cases = require('./s2twp-cases.json');
cases.forEach(function (row) { assert.strictEqual(converter(row.input), row.expected, row.input); });
assert.strictEqual(converter(fs.readFileSync(path.join(__dirname, 'us_constitution_zhs.txt'), 'utf8')),
  fs.readFileSync(path.join(__dirname, 'us_constitution_zhs.s2twp.txt'), 'utf8'));
assert.strictEqual(converter('电脑鼠标软件自行车'), '電腦滑鼠軟體腳踏車');
console.log(process.version + ': Chinese content dictionary, official cases and golden output PASS');
