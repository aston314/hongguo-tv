'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const create = require('../webos/service/range-head-cache');
const cancel = require('../webos/service/audio-cancel');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = () => ({ length: 128 });

test('network prefetch is bounded and foreground reads use the actual cached bytes', async () => {
  const calls = [], data = Buffer.from(Array.from({ length: 128 }, (_, i) => i));
  const c = create(async (s, start, end) => { calls.push([start, end]); return Buffer.from(data.subarray(start, end + 1)); }, { blockBytes: 16, headBytes: 32 });
  const s = source();
  assert.equal(await c.warm(s), 32);
  assert.deepEqual(calls, [[0, 15], [16, 31]]);
  assert.deepEqual(await c.read(s, 3, 25), data.subarray(3, 26));
  assert.equal(calls.length, 2, 'reading cached bytes must not make another network request');
  assert.deepEqual(await c.read(s, 28, 39), data.subarray(28, 40));
  assert.deepEqual(calls[2], [32, 39], 'only the uncached tail is fetched');
  assert.equal(c.diagnostics(s).media_head_cache_bytes, 32);
});

test('foreground handoff shares an in-flight head block; cancelling prefetch keeps that reader alive', async () => {
  let finish, requests = 0, aborted = false;
  const s = source(), stop = cancel.create();
  const c = create((_, start, end, options) => {
    requests++;
    options.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(resolve => { finish = () => resolve(Buffer.alloc(end - start + 1, 7)); });
  }, { blockBytes: 16, headBytes: 16 });
  const warm = c.warm(s, stop.signal).catch(error => error);
  await tick();
  const read = c.read(s, 0, 15);
  await tick(); stop.abort();
  assert.equal(aborted, false);
  finish();
  assert.deepEqual(await read, Buffer.alloc(16, 7));
  assert.equal((await warm).code, 'WEBOS_AUDIO_CANCELLED');
  assert.equal(requests, 1);
});

test('failed warm block is retried with foreground policy and does not poison the cache', async () => {
  const modes = [], s = source(); let reject;
  const c = create(async (_, start, end, options) => {
    modes.push(options.speculative);
    if (options.speculative) return new Promise((resolve, fail) => { reject = fail; });
    return Buffer.alloc(end - start + 1, 3);
  }, { blockBytes: 16, headBytes: 16 });
  const warm = c.warm(s).catch(error => error);
  await tick(); const read = c.read(s, 1, 3); await tick();
  reject(new Error('speculative timeout'));
  assert.deepEqual(await read, Buffer.alloc(3, 3));
  assert.match((await warm).message, /timeout/);
  assert.deepEqual(modes, [true, false]);
});

test('cancelling the only warmer aborts its request and prevents later blocks', async () => {
  const s = source(), stop = cancel.create(); let requests = 0, aborted = false;
  const c = create((_, start, end, options) => {
    requests++;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(cancel.error(options.signal)); }));
  }, { blockBytes: 16, headBytes: 32 });
  const work = c.warm(s, stop.signal).catch(error => error);
  await tick(); stop.abort(); await work; await tick();
  assert.equal(aborted, true); assert.equal(requests, 1);
  assert.equal(c.diagnostics(s).media_head_cache_bytes, 0);
});

test('head cache has two source slots, expires and never shares across indexed source identities', async () => {
  let now = 1, loads = 0;
  const c = create(async (_, start, end) => { loads++; return Buffer.alloc(end - start + 1); }, { blockBytes: 16, headBytes: 32, now: () => now, ttlMs: 100 });
  const a = source(), b = source(), d = source();
  await c.warm(a); now++; await c.warm(b); now++; await c.warm(d);
  assert.equal(c.diagnostics(a).media_head_cache_bytes, 0, 'oldest source was evicted');
  assert.equal(c.diagnostics(b).media_head_cache_bytes + c.diagnostics(d).media_head_cache_bytes, 64);
  await c.read(source(), 0, 2); assert.equal(loads, 7, 'different source with same shape is never a cache hit');
  now += 101;
  assert.equal(c.diagnostics(b).media_head_cache_bytes, 0);
  assert.equal(c.diagnostics(d).media_head_cache_bytes, 0);
  c.clear();
});

test('two active warmers reserve both cache slots; a third cannot exceed the budget', async () => {
  const finish = [], requests = [];
  const c = create((s, start, end) => { requests.push(s); return new Promise(resolve => finish.push(() => resolve(Buffer.alloc(end - start + 1)))); }, { blockBytes: 16, headBytes: 16 });
  const a = source(), b = source(), d = source();
  const first = c.warm(a), second = c.warm(b); await tick();
  assert.equal(await c.warm(d), 0);
  assert.equal(requests.length, 2);
  finish.forEach(resolve => resolve()); await Promise.all([first, second]);
  assert.equal(c.diagnostics(d).media_head_cache_bytes, 0);
});

test('disconnecting one foreground reader preserves a shared head block until its last consumer leaves',async()=>{
  const s=source(),a=cancel.create(),b=cancel.create();let signal,complete;
  const c=create((src,start,end,options)=>new Promise((resolve,reject)=>{
    signal=options.signal;complete=()=>resolve(Buffer.alloc(end-start+1));signal.addEventListener('abort',()=>reject(cancel.error(signal)));
  }),{blockBytes:16,headBytes:32});
  const warm=cancel.create();const warming=c.warm(s,warm.signal).catch(e=>e);await tick();
  const one=c.read(s,0,15,a.signal).catch(e=>e),two=c.read(s,0,15,b.signal).catch(e=>e);await tick();
  warm.abort();a.abort();await one;assert.equal(signal.aborted,false);
  b.abort();await two;await warming;assert.equal(signal.aborted,true);
});
