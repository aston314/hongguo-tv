const { test } = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../core/cmd/hongguotv/ui/tv-layout.js');

test('Shield-sized CSS viewport maps to the 1080p application layout tier', () => {
  const result = layout.read({ innerWidth: 960, innerHeight: 540, devicePixelRatio: 2 });
  assert.equal(result.appWidth, 1920);
  assert.equal(result.appHeight, 1080);
  assert.equal(result.tier, '1080');
});

test('layout tiers use application pixels rather than the panel output mode', () => {
  assert.equal(layout.tier(1280, 720), '720');
  assert.equal(layout.tier(1920, 1080), '1080');
  assert.equal(layout.tier(3840, 2160), '4k');
  assert.equal(layout.tier(960, 540), 'compact');
});

test('layout markers are absent for phones and non-TV previews', () => {
  const names = new Set();
  const root = {
    classList: { toggle(name, enabled) { if (enabled) names.add(name); else names.delete(name); } },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; }
  };
  const document = { documentElement: root };
  layout.apply(document, layout.read({ innerWidth: 960, innerHeight: 540, devicePixelRatio: 2 }), false);
  assert.equal(names.has('tv-layout-1080'), false);
  assert.equal(root['data-tv-layout-tier'], 'not-tv');
  layout.apply(document, layout.read({ innerWidth: 960, innerHeight: 540, devicePixelRatio: 2 }), true);
  assert.equal(names.has('tv-layout-1080'), true);
  assert.equal(root['data-tv-layout-width'], '1920');
});
