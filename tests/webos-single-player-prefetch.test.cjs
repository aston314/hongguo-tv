'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const prefetch = require('../core/cmd/hongguotv/ui/episode-prefetch');
const recovery = require('../core/cmd/hongguotv/ui/playback-recovery');
const app = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const calls = [], detail = options.detail || { series_id: '123', vid_list: ['111', '222', '333', '444', '555'] };
  const playback = options.playback || { item: { series_id: '123' }, episode: 1, vid: '111', generation: 1, started: true, stableSince: Date.now() - 6000 };
  const video = { currentTime: 6, duration: 60, paused: false, ended: false };
  const c = vm.createContext({ Promise, AbortController, URLSearchParams, Date, Number, Math, Object,
    HongguoEpisodePrefetch: prefetch, webosShell: true,
    window: { HongguoWebOS: {} }, applicationInBackground: false, qualityPrevious: null, accountEpoch: 1, feedGeneration: 1,
    activePlayback: playback,
    playbackPreferences: { quality: '' }, playbackEngineName: () => 'webos-html5', rangePlaybackEnabled: () => true,
    getDetail: async () => detail, isPlaybackPage: () => true, applicationHidden: () => false,
    document: { createElement() { throw Error('webOS must never create a speculative video'); } },
    fetchData: async (url, options) => { calls.push({ url, signal: options.signal }); return { path: '/minireel-proxy/media/' + new URLSearchParams(url.split('?')[1]).get('vid') + '.mp4', mode: 'range' }; }
  });
  vm.runInContext(app.slice(app.indexOf('  var episodePrefetch ='), app.indexOf('  var applicationInBackground =')), c);
  vm.runInContext(app.slice(app.indexOf('  function maybePrefetchNextEpisode('), app.indexOf('  function holdPlaybackAudio(')), c);
  return { c, calls, video };
}

test('webOS consumes prefetch results over four consecutive episode handoffs without another video', async () => {
  const f = fixture();
  for (let episode = 1; episode < 5; episode++) {
    const old = f.c.activePlayback;
    f.c.maybePrefetchNextEpisode(f.video); await tick();
    const p = f.c.episodePrefetch;
    p.keepFor('123', episode + 1, '', 1, 'range');
    const handoff = p.consume({ series_id: '123', vid: String((episode + 1) * 111), episode: episode + 1, quality: '', owner: 1, mode: 'range' });
    assert(handoff, 'each episode must have a consumable preparation');
    const data = await handoff.promise;
    assert.equal(data.path, '/minireel-proxy/media/' + (episode + 1) * 111 + '.mp4');
    assert.equal(f.video.paused, false, 'network prefetch cannot pause the current video');
    f.c.feedGeneration++;
    f.c.activePlayback = { ...old, episode: episode + 1, vid: String((episode + 1) * 111), generation: f.c.feedGeneration, stableSince: Date.now() - 6000 };
  }
  assert.equal(f.calls.length, 4, 'exactly one prepared request per next episode');
  assert(f.calls.every(call => new URLSearchParams(call.url.split('?')[1]).get('prefetch') === '1'));
});

test('aggregate access count does not suppress prefetch for the immediate fourth episode', async () => {
  const f = fixture({
    detail: { series_id: '123', accessible_episode_cnt: 3, vid_list: ['111', '222', '333', '444'], episodes: [
      { video_id: '111', locked: false }, { video_id: '222', locked: false }, { video_id: '333', locked: false },
      { video_id: '444', locked: true, locked_inferred: true }
    ] },
    playback: { item: { series_id: '123' }, episode: 3, vid: '333', generation: 1, started: true, stableSince: Date.now() - 6000 }
  });
  f.c.maybePrefetchNextEpisode(f.video); await tick();
  assert.equal(f.calls.length, 1);
  const query = new URLSearchParams(f.calls[0].url.split('?')[1]);
  assert.equal(query.get('vid'), '444');
  assert.equal(query.get('prefetch'), '1');
});

test('explicitly locked immediate next episode is not speculatively requested', async () => {
  const f = fixture({
    detail: { series_id: '123', vid_list: ['111', '222'], episodes: [
      { video_id: '111', locked: false }, { video_id: '222', locked: true }
    ] }
  });
  f.c.maybePrefetchNextEpisode(f.video); await tick();
  assert.equal(f.calls.length, 0);
});

test('leaving playback cancels the network prefetch and an old account cannot consume it', async () => {
  const f = fixture(); f.c.maybePrefetchNextEpisode(f.video); await tick();
  f.c.episodePrefetch.cancel();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.c.episodePrefetch.consume({ series_id: '123', vid: '222', episode: 2, quality: '', owner: 2, mode: 'range' }), null);
});

function recoveryFixture() {
  const calls = [], playback = { episode: 2, generation: 5, position: 0, owner: 1 };
  const c = vm.createContext({ webosShell: true, activePlayback: playback, feedGeneration: 5, accountEpoch: 1, applicationInBackground: false,
    applicationHidden: () => false, isPlaybackPage: () => true, playbackRecovery: recovery.create({ maxAttempts: 1 }),
    playbackEngineName: () => 'webos-html5', feedIndex: 0,
    playFeedItem(...args) { calls.push(args); }, Number, Math });
  vm.runInContext(app.slice(app.indexOf('  function recoverPlaybackPreparation('), app.indexOf('  function clearRangeTransitionHint(')), c);
  return { c, calls, playback };
}

test('a webOS source failure refreshes once at the pending episode position, never the old end time', () => {
  const f = recoveryFixture(), error = { code: 'VIDEO_MODEL_EMPTY', status: 502 };
  assert.equal(f.c.recoverPlaybackPreparation(f.playback, error, 5), true);
  assert.deepEqual(f.calls[0].slice(0, 3), [0, 2, 0]);
  assert.equal(f.c.recoverPlaybackPreparation(f.playback, error, 5), false, 'one shared recovery budget');
});

test('preparation recovery rejects permanent errors, cancelled/stale/background work and other platforms', () => {
  for (const error of [{ code: 'VIDEO_MODEL_HTTP', status: 403 }, { code: 'ACCOUNT_REQUIRED', status: 401 },
    { code: 'PROVIDER_ERROR', status: 400 }, { code: 'VIDEO_MODEL_EMPTY', name: 'AbortError' }]) {
    const f = recoveryFixture(); assert.equal(f.c.recoverPlaybackPreparation(f.playback, error, 5), false);
  }
  for (const change of [{ webosShell: false }, { feedGeneration: 6 }, { applicationInBackground: true }, { activePlayback: {} }]) {
    const f = recoveryFixture(); Object.assign(f.c, change);
    assert.equal(f.c.recoverPlaybackPreparation(f.playback, { code: 'VIDEO_MODEL_EMPTY' }, 5), false); assert.equal(f.calls.length, 0);
  }
});
