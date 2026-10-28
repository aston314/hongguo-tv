const {test} = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../core/cmd/hongguotv/ui/episode-prefetch-settings.js');

test('full episode prefetch is available only on Android and desktop shells', () => {
  assert.equal(settings.supports('android'), true);
  assert.equal(settings.supports('desktop'), true);
  assert.equal(settings.supports('webos'), false);
  assert.equal(settings.supports('preview'), false);
});

test('invalid or missing preferences fall back to range', () => {
  assert.equal(settings.normalize(''), 'range');
  assert.equal(settings.normalize('unknown'), 'range');
  assert.equal(settings.normalize('full'), 'full');
  let value = 'unknown';
  const states = [];
  const controller = settings.create({platform: 'webos', read: () => value, write: next => { value = next; }, render: state => states.push(state)});
  assert.equal(controller.mode(), 'range');
  assert.equal(controller.choose('full'), false);
  assert.equal(states.at(-1).mode, 'range');
});

test('a supported shell persists the selected strategy and reports save failures', () => {
  let value = 'range';
  const states = [];
  const controller = settings.create({platform: 'desktop', read: () => value, write: next => { value = next; }, render: state => states.push(state)});
  assert.equal(controller.choose('full'), true);
  assert.equal(value, 'full');
  assert.equal(controller.mode(), 'full');
  assert.equal(states.at(-1).supported, true);
  let failed = settings.create({platform: 'android', read: () => 'range', write: () => false, render: state => states.push(state)});
  assert.equal(failed.choose('full'), false);
  assert.equal(failed.mode(), 'range');
  assert.equal(states.at(-1).message, 'save_failed');
});
