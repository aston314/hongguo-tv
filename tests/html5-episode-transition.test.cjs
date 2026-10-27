const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function classes(...initial) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
  };
}

function fixture({ webos = false } = {}) {
  const timers = [];
  const hero = { classList: classes('is-preparing-video', 'is-episode-transition') };
  const cover = { classList: classes(), style: {} };
  const canvas = { classList: classes('is-visible'), width: 320, height: 180 };
  const video = {
    paused: false,
    ended: false,
    seeking: false,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    classList: classes('has-source'),
    getAttribute() { return '/media/episode-2.mp4'; },
  };
  const root = { classList: classes() };
  const document = {
    documentElement: root,
    getElementById(id) {
      if (id === 'hero') return hero;
      if (id === 'hero-video') return video;
      if (id === 'hero-episode-cover') return cover;
      if (id === 'hero-last-frame') return canvas;
      return null;
    },
  };
  const imageInstances = [];
  function ImageMock() { imageInstances.push(this); }
  const playback = {
    item: { series_id: 'series-1' },
    vid: 'vid-2',
    generation: 4,
    owner: 2,
    episodeCoverAllowed: true,
    presentation: { rendered: false, pending: false, revealing: false, revealTimer: null, epoch: 0 },
  };
  const context = vm.createContext({
    document,
    Image: ImageMock,
    Promise,
    Date,
    activePlayback: playback,
    accountEpoch: 2,
    feedGeneration: 4,
    webosShell: webos,
    episodeCoverLoader: null,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {},
    clearRangeStallTimer() {},
    clearRangeTransitionHint() {},
    clearLastPlaybackFrame() { canvas.classList.remove('is-visible'); },
    playbackVideoReady() { return true; },
    waitForPlaybackPaint() { return Promise.resolve(true); },
    releasePresentedAudio() {},
    finishAutoCinema() {},
    setPlayerStatus() {},
    nativePlaybackActive() { return false; },
    isNativeMedia3PlaybackActive() { return false; },
  });
  vm.runInContext(between('  function clearEpisodeCover(', '  function layoutLastPlaybackFrame'), context);
  vm.runInContext(between('  function finishPlaybackPreparation(', '  function markPlaybackStarted'), context);
  return { context, hero, cover, canvas, imageInstances, playback, timers };
}

test('standard HTML5 fades the next episode cover after the real frame is ready', async () => {
  const fixtureState = fixture();
  fixtureState.context.setEpisodeCover({ series_id: 'series-1', vid: 'vid-2' }, { episode_cover: 'https://img.example/episode-2.jpg' });
  fixtureState.imageInstances[0].onload();
  fixtureState.context.finishPlaybackPreparation(fixtureState.playback);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixtureState.hero.classList.contains('is-native-frame-revealing'), true);
  assert.equal(fixtureState.timers[0].delay, 180);
  fixtureState.timers[0].fn();
  assert.equal(fixtureState.hero.classList.contains('is-episode-cover'), false);
  assert.equal(fixtureState.hero.classList.contains('is-preparing-video'), false);
});

test('webOS keeps its existing cover release path', async () => {
  const fixtureState = fixture({ webos: true });
  fixtureState.context.setEpisodeCover({ series_id: 'series-1', vid: 'vid-2' }, { episode_cover: 'https://img.example/episode-2.jpg' });
  fixtureState.imageInstances[0].onload();
  fixtureState.context.finishPlaybackPreparation(fixtureState.playback);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixtureState.timers.length, 0);
  assert.equal(fixtureState.hero.classList.contains('is-episode-cover'), false);
  assert.equal(fixtureState.hero.classList.contains('is-preparing-video'), false);
});
