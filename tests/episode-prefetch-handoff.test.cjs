const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const start = source.indexOf('  function waitForPlaybackPrefetch(');
const end = source.indexOf('\n  function recoverPlaybackAfterError(', start);
const waitForPlaybackPrefetch = source.slice(start, end).trim();
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(prefetchMode) {
  let timerCallback;
  let cancelled = 0;
  let resolveSource;
  const fetchCalls = [];
  const context = vm.createContext({
    feedGeneration: 7,
    fetch(path, options) { fetchCalls.push({path, options}); return Promise.resolve({ok: true}); },
    playbackDebug() {},
    setTimeout(callback, delay) {
      assert.equal(delay, 1200);
      timerCallback = callback;
      return 1;
    },
    clearTimeout() {}
  });
  vm.runInContext(waitForPlaybackPrefetch + '\nthis.waitForPlaybackPrefetch = waitForPlaybackPrefetch;', context);
  const handoff = {
    prefetchMode,
    promise: new Promise(resolve => { resolveSource = resolve; }),
    cancel() { cancelled++; }
  };
  return {
    context,
    handoff,
    get cancelCount() { return cancelled; },
    fetchCalls,
    resolveSource,
    fireTimeout() { timerCallback(); }
  };
}

test('full-file handoff timeout cancels the unfinished speculative download', async () => {
  const f = fixture('full');
  const result = f.context.waitForPlaybackPrefetch(f.handoff, 7, null);
  f.fireTimeout();
  assert.equal(await result, null);
  assert.equal(f.cancelCount, 1);
  f.resolveSource({path: '/late.mp4'});
  await tick();
  assert.equal(f.cancelCount, 1);
});

test('Range handoff timeout leaves the shared preparation alive for the foreground resolver', async () => {
  const f = fixture('range');
  const result = f.context.waitForPlaybackPrefetch(f.handoff, 7, null);
  f.fireTimeout();
  assert.equal(await result, null);
  assert.equal(f.cancelCount, 0);
});

test('a completed handoff wins before the timeout and does not cancel', async () => {
  const f = fixture('full');
  const result = f.context.waitForPlaybackPrefetch(f.handoff, 7, null);
  f.resolveSource({path: '/prepared.mp4'});
  assert.deepEqual(await result, {path: '/prepared.mp4'});
  assert.equal(f.cancelCount, 0);
  assert.equal(f.fetchCalls.length, 1);
  assert.equal(f.fetchCalls[0].path, '/prepared.mp4');
  assert.equal(f.fetchCalls[0].options.method, 'HEAD');
});

test('a full-file cache entry removed by LRU is rejected before the player adopts it', async () => {
  const f = fixture('full');
  f.context.fetch = () => Promise.resolve({ok: false, status: 404});
  const result = f.context.waitForPlaybackPrefetch(f.handoff, 7, null);
  f.resolveSource({path: '/evicted.mp4'});
  assert.equal(await result, null);
  assert.equal(f.cancelCount, 0);
});

test('Range handoffs do not add a media HEAD request', async () => {
  const f = fixture('range');
  const result = f.context.waitForPlaybackPrefetch(f.handoff, 7, null);
  f.resolveSource({path: '/range.mp4'});
  assert.deepEqual(await result, {path: '/range.mp4'});
  assert.equal(f.fetchCalls.length, 0);
});
