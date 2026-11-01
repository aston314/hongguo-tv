const { test } = require('node:test');
const assert = require('node:assert/strict');
const viewport = require('../core/cmd/hongguotv/ui/tv-viewport.js');

function documentWithViewport() {
  const meta = { content: 'width=device-width, initial-scale=1', setAttribute(name, value) { if (name === 'content') this.content = value; } };
  return { meta, querySelector(selector) { return selector === 'meta[name="viewport"]' ? meta : null; } };
}

test('recognized 1080p high-density TVs use the shared 1280px design viewport', () => {
  const doc = documentWithViewport();
  assert.equal(viewport.apply(doc, { layoutViewportWidth() { return 1280; } }, 2), true);
  assert.equal(doc.meta.content, 'width=1280, initial-scale=0.75');
  const highDensity = documentWithViewport();
  assert.equal(viewport.apply(highDensity, { layoutViewportWidth() { return 1280; } }, 3), true);
  assert.equal(highDensity.meta.content, 'width=1280, initial-scale=0.5');
});

test('unrecognized and already-normalized devices keep the original viewport', () => {
  const unknown = documentWithViewport();
  assert.equal(viewport.apply(unknown, null), false);
  assert.equal(unknown.meta.content, 'width=device-width, initial-scale=1');
  const zidoo = documentWithViewport();
  assert.equal(viewport.apply(zidoo, { layoutViewportWidth() { return 0; } }), false);
  assert.equal(zidoo.meta.content, 'width=device-width, initial-scale=1');
});
