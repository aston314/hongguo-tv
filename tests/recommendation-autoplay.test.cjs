const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const helperSource = source.slice(
  source.indexOf('  function lastAutoRecommendationSeries('),
  source.indexOf('  function rememberRecommendation('),
);
const renderSource = source.slice(
  source.indexOf('  function renderFeed('),
  source.indexOf('  function startPlayer('),
);
const markSource = source.slice(
  source.indexOf('  function markPlaybackStarted('),
  source.indexOf('  function checkPlaybackProgress('),
);

function storage(initial) {
  let value = initial || '';
  return {
    getItem() { return value; },
    setItem(key, next) { assert.equal(key, 'hongguo.lastAutoRecommendationSeries'); value = String(next); },
    value() { return value; },
  };
}

function renderFixture(previous) {
  const calls = [];
  const localStorage = storage(previous);
  const context = vm.createContext({
    window: { localStorage },
    feedItems: [],
    feedIndex: -1,
    featuredItem: null,
    recommendationAutoplayPending: false,
    feedPager: { hasMore: () => false },
    syncHomeChannel() {},
    armPlaybackMenuHint() {},
    updateFeedCounter() {},
    updateSeasonControl() {},
    showRecommendationPlaceholder() {},
    playFeedItem(index) { calls.push(index); feedIndex = index; recommendationAutoplayPending = false; },
  });
  vm.runInContext(`var lastAutoRecommendationSeriesMemory = '';${helperSource}${renderSource}`, context);
  return { context, calls, localStorage };
}

function markFixture({ autoRecommendation = true, paused = false } = {}) {
  const localStorage = storage();
  const video = { paused, ended: false, seeking: false, readyState: 4 };
  const hero = { classList: { contains() { return false; } } };
  const context = vm.createContext({
    window: { localStorage },
    document: { getElementById(id) { return id === 'hero-video' ? video : hero; } },
    applicationInBackground: false,
    applicationHidden() { return false; },
    currentPlaybackPresentation() { return true; },
    clearRangeStallTimer() {},
    finishPlaybackPreparation() {},
    setPlayerStatus() {},
    updatePlaybackControls() {},
    scheduleControlsHide() {},
    saveProgress() {},
    playbackTiming: [],
  });
  vm.runInContext(`var lastAutoRecommendationSeriesMemory = '';${helperSource}${markSource}`, context);
  const playback = {
    item: { series_id: 'series-1' },
    presentation: { failed: false, waiting: true },
    autoRecommendation: autoRecommendation,
    autoRecommendationRecorded: false,
    started: false,
    timing: { reported: true },
  };
  return { context, playback, localStorage };
}

test('recommendation autoplay skips the last successful series while preserving feed order', () => {
  const fixture = renderFixture('series-1');
  fixture.context.renderFeed([{ series_id: 'series-1' }, { series_id: 'series-2' }, { series_id: 'series-3' }]);
  assert.deepEqual(fixture.calls, [1]);
});

test('recommendation autoplay still starts when every candidate is the previous series', () => {
  const fixture = renderFixture('series-1');
  fixture.context.renderFeed([{ series_id: 'series-1' }]);
  assert.deepEqual(fixture.calls, [0]);
  assert.equal(fixture.context.feedIndex, 0);
});

test('a missing previous series starts the first recommendation', () => {
  const fixture = renderFixture('');
  fixture.context.renderFeed([{ series_id: 'series-1' }, { series_id: 'series-2' }]);
  assert.deepEqual(fixture.calls, [0]);
});

test('only a successfully started automatic recommendation is remembered', () => {
  const fixture = markFixture();
  fixture.context.markPlaybackStarted(fixture.playback);
  assert.equal(fixture.localStorage.value(), 'series-1');
  assert.equal(fixture.playback.started, true);
});

test('manual playback and failed playback do not change the recommendation memory', () => {
  const manual = markFixture({ autoRecommendation: false });
  manual.context.markPlaybackStarted(manual.playback);
  assert.equal(manual.localStorage.value(), '');

  const failed = markFixture({ paused: true });
  failed.context.markPlaybackStarted(failed.playback);
  assert.equal(failed.localStorage.value(), '');
  assert.equal(failed.playback.started, false);
});
