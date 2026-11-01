const { test } = require('node:test');
const assert = require('node:assert/strict');
const viewport = require('../core/cmd/hongguotv/ui/tv-viewport.js');

function mockWindow(width, height, television) {
  const meta = {
    content: 'width=device-width, initial-scale=1',
    setAttribute(name, value) { if (name === 'content') this.content = value; }
  };
  return {
    innerWidth: width,
    innerHeight: height,
    document: { querySelector(selector) { return selector === 'meta[name="viewport"]' ? meta : null; } },
    meta,
    HongguoTVDiagnostics: { isTelevision() { return television; } },
    setTimeout(callback) { callback(); }
  };
}

test('uses the measured narrow WebView viewport on Android TV', () => {
  const view = mockWindow(960, 540, true);
  assert.equal(viewport.apply(view), true);
  assert.equal(view.meta.content, 'width=1280, initial-scale=0.75');
  assert.deepEqual(viewport.describe(), { state: 'applied', beforeWidth: 960, beforeHeight: 540, targetWidth: 1280, scale: 0.75 });
});

test('preserves the existing media-query viewport on Zidoo-like 1280px Android TVs', () => {
  const view = mockWindow(1280, 646, true);
  assert.equal(viewport.apply(view), false);
  assert.equal(view.meta.content, 'width=device-width, initial-scale=1');
  assert.equal(viewport.describe().state, 'viewport-unchanged');
});

test('does not change a narrow non-TV viewport', () => {
  const view = mockWindow(960, 540, false);
  assert.equal(viewport.apply(view), false);
  assert.equal(view.meta.content, 'width=device-width, initial-scale=1');
  assert.equal(viewport.describe().state, 'not-television');
});

test('rejects portrait and unusually short viewport shapes', () => {
  assert.equal(viewport.classify({ innerWidth: 960, innerHeight: 900 }, { isTelevision() { return true; } }).state, 'viewport-unchanged');
  assert.equal(viewport.classify({ innerWidth: 960, innerHeight: 400 }, { isTelevision() { return true; } }).state, 'viewport-unchanged');
  assert.equal(viewport.classify({ innerWidth: 0, innerHeight: 0 }, { isTelevision() { return true; } }).state, 'viewport-pending');
});

test('waits briefly for the Android bridge, then applies after it is available', () => {
  const view = mockWindow(960, 540, true);
  view.navigator = { userAgent: 'HongguoTV-Android' };
  view.HongguoTVDiagnostics = null;
  let timer;
  view.setTimeout = callback => { timer = callback; };
  viewport.install(view);
  assert.equal(viewport.describe().state, 'bridge-pending');
  view.HongguoTVDiagnostics = { isTelevision() { return true; } };
  timer();
  assert.equal(viewport.describe().state, 'applied');
  assert.equal(view.meta.content, 'width=1280, initial-scale=0.75');
});

test('does not start the Android viewport correction on desktop or webOS pages', () => {
  const view = mockWindow(960, 540, true);
  view.navigator = { userAgent: 'HongguoTV-webOS' };
  viewport.install(view);
  assert.equal(viewport.describe().state, 'unsupported-platform');
  assert.equal(view.meta.content, 'width=device-width, initial-scale=1');
});
