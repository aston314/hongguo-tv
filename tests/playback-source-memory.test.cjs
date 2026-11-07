'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const create = require('../webos/service/playback-source-memory');
const normal = ['video_tab','multi_video_model','video_model'];

test('series plans expire, stay local and immutable, and never rank other series', () => {
  let now = 0;
  const memory = create(() => now), first = memory.plan('series');
  first.observe('video_model',true);
  assert.deepEqual(first.order,normal);
  assert.deepEqual(memory.plan('series').order,['video_model','video_tab','multi_video_model']);
  assert.deepEqual(memory.plan('other').order,normal);
  assert.deepEqual(memory.plan('').order,normal);
  now = 30 * 60 * 1000;
  assert.deepEqual(memory.plan('series').order,normal);
  first.observe('video_model',true);
  for (let i = 0; i < 128; i++) memory.plan('other' + i).observe('multi_video_model',true);
  assert.deepEqual(memory.plan('series').order,normal,'memory must evict old hints');
});

test('older jobs cannot overwrite newer success or resurrect an invalidated route', () => {
  const memory = create(), old = memory.plan('series'), next = memory.plan('series');
  next.observe('video_model',true);
  old.observe('multi_video_model',true);
  old.observe('video_model',false);
  assert.equal(memory.plan('series').order[0],'video_model');
  memory.plan('series').observe('video_model',false);
  next.observe('video_model',true);
  assert.deepEqual(memory.plan('series').order,normal);
});

test('service shutdown clears hints and prevents late writes from its old plans', () => {
  const memory = create(), old = memory.plan('series');
  old.observe('video_model',true);
  memory.clear();
  old.observe('video_model',true);
  assert.deepEqual(memory.plan('series').order,normal);
});
