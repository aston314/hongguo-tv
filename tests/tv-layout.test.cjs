const { test } = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../core/cmd/hongguotv/ui/tv-layout.js');

function documentMock() {
  const names = new Set();
  const root = {
    classList: { toggle(name, enabled) { if (enabled) names.add(name); else names.delete(name); } },
    setAttribute(name, value) { this[name] = value; }
  };
  return { document: { documentElement: root }, names, root };
}

test('Shield narrow TV viewport selects the base short-viewport path', () => {
  const view = layout.read({ innerWidth: 960, innerHeight: 540 });
  assert.equal(view.narrow, true);
  const mock = documentMock();
  layout.apply(mock.document, view, true);
  assert.equal(mock.names.has('tv-layout-base'), true);
  assert.deepEqual(layout.describe(), { state: 'applied', width: 960, height: 540 });
});

test('wide TV and unrecognized devices keep the original path', () => {
  const mock = documentMock();
  layout.apply(mock.document, layout.read({ innerWidth: 1280, innerHeight: 646 }), true);
  assert.equal(mock.names.has('tv-layout-base'), false);
  assert.equal(layout.describe().state, 'not-narrow');
  layout.apply(mock.document, layout.read({ innerWidth: 960, innerHeight: 540 }), false);
  assert.equal(mock.names.has('tv-layout-base'), false);
  assert.equal(layout.describe().state, 'not-television');
});

test('only the narrow landscape TV viewport selects the compact sidebar path', () => {
  assert.equal(layout.read({ innerWidth: 1025, innerHeight: 540 }).narrow, false);
  assert.equal(layout.read({ innerWidth: 960, innerHeight: 700 }).narrow, false);
  assert.equal(layout.read({ innerWidth: 960, innerHeight: 600 }).narrow, false);
  assert.equal(layout.read({ innerWidth: 960, innerHeight: 540 }).narrow, true);
});
