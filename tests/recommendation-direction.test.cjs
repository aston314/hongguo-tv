const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const direction = require('../core/cmd/hongguotv/ui/recommendation-direction.js');
const app = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const helperSource = app.slice(app.indexOf('  function newRecommendationOrientationContext('), app.indexOf('  function rememberRecommendation('));

function storage(initial) {
  const values = Object.assign({}, initial);
  return { values, getItem(key) { return values[key] || null; }, setItem(key, value) { values[key] = String(value); } };
}

test('direction matching accepts unknown dimensions without filtering', () => {
  assert.equal(direction.matches('all', 0, 0), true);
  assert.equal(direction.matches('landscape', 0, 720), null);
  assert.equal(direction.matches('portrait', 720, 720), null);
  assert.equal(direction.matches('landscape', 1280, 720), true);
  assert.equal(direction.matches('portrait', 720, 1280), true);
});

test('candidate search is bounded and keeps the current order', () => {
  assert.equal(direction.nextCandidateIndex(0, 5, 0, 8), 1);
  assert.equal(direction.nextCandidateIndex(3, 5, 0, 8), 4);
  assert.equal(direction.nextCandidateIndex(4, 5, 0, 8), -1);
  assert.equal(direction.nextCandidateIndex(0, 5, 8, 8), -1);
});

test('setting defaults to all, persists supported choices, and hides unsupported previews', () => {
  const store = storage({ key: 'portrait' });
  const states = [];
  const controller = direction.create({ platform: 'android', storage: store, key: 'key', render: state => states.push(state) });
  assert.equal(controller.mode(), 'portrait');
  assert.equal(controller.choose('landscape'), true);
  assert.equal(store.values.key, 'landscape');
  assert.equal(states.at(-1).supported, true);

  const previewStates = [];
  const preview = direction.create({ platform: 'unknown', storage: store, render: state => previewStates.push(state) });
  assert.equal(preview.mode(), 'all');
  assert.equal(previewStates[0].supported, false);
  assert.equal(preview.choose('portrait'), false);
});

test('Android setting prefers the native bridge so it survives WebView origin changes', () => {
  let saved = 'portrait';
  const bridge = {
    readRecommendationDirection() { return saved; },
    writeRecommendationDirection(value) { saved = value; }
  };
  const oldOrigin = storage(), newOrigin = storage();
  const controller = direction.create({ platform: 'android', bridge, storage: oldOrigin });
  assert.equal(controller.mode(), 'portrait');
  assert.equal(controller.choose('landscape'), true);
  assert.equal(direction.create({ platform: 'android', bridge, storage: newOrigin }).mode(), 'landscape');
  assert.deepEqual(oldOrigin.values, {});
  assert.deepEqual(newOrigin.values, {});
  bridge.writeRecommendationDirection = () => { throw new Error('save failed'); };
  assert.equal(controller.choose('all'), false);
  assert.equal(controller.mode(), 'landscape');
});

function orientationFixture({ mode = 'landscape', index = 0, total = 4, checked = 0, limit = 2 } = {}) {
  const calls = [];
  const context = vm.createContext({
    window: { HongguoRecommendationDirection: direction },
    recommendationDirectionSettings: { mode: () => mode }, recommendationOrientationCheckLimit: limit,
    feedIndex: index, feedItems: Array.from({ length: total }, (_, i) => ({ series_id: String(i) })),
    playFeedItem(...args) { calls.push(args); }
  });
  vm.runInContext(helperSource, context);
  return { context, calls };
}

test('orientation setting skips known mismatches and leaves unknown dimensions alone', () => {
  const f = orientationFixture();
  const playback = { orientationContext: { direction: 'landscape', checked: 0, limit: 2 }, orientationChecked: false };
  assert.equal(f.context.maybeSkipRecommendationOrientation(playback, 0, 0), false);
  assert.equal(playback.orientationChecked, false);
  assert.equal(f.context.maybeSkipRecommendationOrientation(playback, 720, 1280), true);
  assert.equal(playback.orientationChecked, true);
  assert.equal(f.calls[0][0], 1);
  assert.equal(f.calls[0][6].checked, 1);
});

test('orientation search is bounded and falls back to the last checked recommendation', () => {
  const f = orientationFixture({ index: 1, checked: 1, limit: 2 });
  const playback = { orientationContext: { direction: 'landscape', checked: 1, limit: 2 }, orientationChecked: false };
  assert.equal(f.context.maybeSkipRecommendationOrientation(playback, 720, 1280), false);
  assert.equal(playback.orientationChecked, true);
  assert.equal(f.calls.length, 0);
});
