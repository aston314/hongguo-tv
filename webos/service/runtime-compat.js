'use strict';

// webOS 3/4 services run Node 0.12.2. Load before the production module graph;
// only supply missing operations used by this service, leaving newer VMs alone.
function define(target, key, value) {
  if (typeof target[key] !== 'function') Object.defineProperty(target, key, {
    value: value, configurable: true, writable: true, enumerable: false
  });
}
define(Buffer, 'from', function (value, encoding) {
  if (typeof value === 'number' || value == null) throw new TypeError('Expected bytes or text');
  return new Buffer(value, encoding);
});
define(Buffer, 'alloc', function (size, fill) {
  if (typeof size !== 'number' || !isFinite(size) || size < 0 || Math.floor(size) !== size) throw new RangeError('Invalid buffer size');
  var result = new Buffer(size);
  result.fill(fill === undefined ? 0 : fill);
  return result;
});
define(Buffer.prototype, 'reverse', function () {
  for (var i = 0, j = this.length - 1; i < j; i++, j--) {
    var value = this[i]; this[i] = this[j]; this[j] = value;
  }
  return this;
});
define(Object, 'assign', function (target) {
  if (target == null) throw new TypeError('Expected assign target');
  var out = Object(target);
  for (var i = 1; i < arguments.length; i++) {
    if (arguments[i] == null) continue;
    var source = Object(arguments[i]), keys = Object.keys(source);
    for (var j = 0; j < keys.length; j++) out[keys[j]] = source[keys[j]];
  }
  return out;
});
function findIndex(predicate, self) {
  if (this == null || typeof predicate !== 'function') throw new TypeError('Expected array and predicate');
  var list = Object(this), length = Math.max(0, Math.min(Math.floor(Number(list.length) || 0), 9007199254740991));
  for (var i = 0; i < length; i++) if (predicate.call(self, list[i], i, list)) return i;
  return -1;
}
define(Array.prototype, 'findIndex', findIndex);
define(Array.prototype, 'find', function (predicate, self) {
  var index = findIndex.call(this, predicate, self);
  return index < 0 ? undefined : this[index];
});
// Call sites use strings (Unicode character limits) and array-like byte lists.
define(Array, 'from', function (value) {
  if (value == null) throw new TypeError('Expected array-like value');
  var out = [], i;
  if (typeof value === 'string') {
    for (i = 0; i < value.length; i++) {
      var ch = value.charAt(i), high = value.charCodeAt(i), low = value.charCodeAt(i + 1);
      if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) ch += value.charAt(++i);
      out.push(ch);
    }
  } else {
    for (i = 0; i < value.length; i++) out.push(value[i]);
  }
  return out;
});
define(Number, 'isFinite', function (value) { return typeof value === 'number' && isFinite(value); });
define(Number, 'isInteger', function (value) { return Number.isFinite(value) && Math.floor(value) === value; });
define(Number, 'isSafeInteger', function (value) { return Number.isInteger(value) && Math.abs(value) <= 9007199254740991; });
