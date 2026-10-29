const { test } = require('node:test');
const assert = require('node:assert/strict');
const engagement = require('../core/cmd/hongguotv/ui/engagement.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('prewarm caches the next episode stats and cover without rendering it', async () => {
  const reply = deferred();
  const renders = [];
  let requests = 0;
  const api = engagement.create({
    request() { requests += 1; return { abort() {}, promise: reply.promise }; },
    render(target, data) { renders.push({ target, data }); },
  });
  const pending = api.prewarm({ series_id: 'series-1', vid: 'vid-2' });
  reply.resolve({ series_id: 'series-1', vid: 'vid-2', likes: 4, favorites: 2, comments: 1, episode_cover: '/cover-2.jpg' });
  assert.deepEqual(await pending, { likes: 4, favorites: 2, comments: 1, episode_cover: '/cover-2.jpg' });
  assert.equal(requests, 1);
  assert.equal(renders.length, 0);
  assert.deepEqual(await api.prewarm({ series_id: 'series-1', vid: 'vid-2' }), { likes: 4, favorites: 2, comments: 1, episode_cover: '/cover-2.jpg' });
  assert.equal(requests, 1);
});

test('cancel invalidates an in-flight prewarm and ignores its late response', async () => {
  const reply = deferred();
  let aborted = 0;
  const api = engagement.create({
    request() { return { abort() { aborted += 1; }, promise: reply.promise }; },
    render() {},
  });
  const pending = api.prewarm({ series_id: 'series-1', vid: 'vid-2' });
  api.clear();
  reply.resolve({ series_id: 'series-1', vid: 'vid-2', episode_cover: '/late.jpg' });
  assert.equal(await pending, null);
  assert.equal(aborted, 1);
});
