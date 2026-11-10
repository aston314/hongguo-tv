const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { describe, create } = require('../core/cmd/hongguotv/ui/next-season-hint.js');

const seasons = Array.from({ length: 5 }, (_, index) => ({
  series_id: String(index + 1), season_index: index + 1, vid: String(100 + index),
  title: '系列剧 · 第' + (index + 1) + '季', episode_count: 2, playable: true
}));

test('the season position identifies the upcoming season, with a total only for a complete numbered catalog', () => {
  assert.deepEqual(describe(seasons, '2'), { next: seasons[2], current: 2, season: 3, total: 5 });
  assert.equal(describe(seasons.slice(1), '2').total, 0, 'missing first season is not a four-season total');
  assert.equal(describe([seasons[1], seasons[2], seasons[4]], '2').total, 0);
  assert.equal(describe([...seasons, { series_id: '6' }], '2').total, 0);
  const announced = seasons.map(row => row.season_index === 5 ? { ...row, upcoming: true, playable: false, vid: '' } : row);
  assert.equal(describe(announced, '2').total, 5, 'the official catalog includes announced seasons');
});

test('unavailable, missing, conflicting and unnumbered successors never advertise an automatic next season', () => {
  for (const rows of [null, [], seasons.filter(row => row.series_id !== '2'), seasons.filter(row => row.series_id !== '3'),
    [...seasons, { ...seasons[1], series_id: '22' }], [...seasons, { ...seasons[2], series_id: '33' }]]) {
    assert.equal(describe(rows, '2'), null);
  }
  for (const override of [{ playable: false }, { upcoming: true }, { vid: '' }, { episode_count: 0 }, { season_index: 0 }]) {
    assert.equal(describe(seasons.map(row => row.series_id === '3' ? { ...row, ...override } : row), '2'), null);
  }
  assert.equal(describe(seasons, '5'), null);
});

function fixture() {
  const calls = [];
  const controller = create({ show: model => calls.push(['show', model]), hide: () => calls.push(['hide']) });
  const playback = { item: { series_id: '2', episode_count: 2, vid_list: ['a', 'b'] }, episode: 2, started: true };
  const video = { duration: 100, currentTime: 96, paused: false, ended: false, seeking: false };
  return { controller, playback, video, calls, update(allowed = true, items = seasons) { return controller.update(playback, video, items, allowed); } };
}

test('only the final three media seconds of the last episode show a card, without repeated DOM renders', () => {
  const f = fixture();
  assert.equal(f.update(), false);
  f.video.currentTime = 97;
  assert.equal(f.update(), true);
  for (let time = 97.1; time < 100; time += .1) { f.video.currentTime = time; assert.equal(f.update(), true); }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].season, 3);
  f.video.currentTime = 100;
  assert.equal(f.update(), false);
  assert.deepEqual(f.calls.at(-1), ['hide']);
  assert.equal(f.update(), false);
  assert.equal(f.calls.length, 2);
});

test('ordinary episodes, incomplete episode metadata and invalid media clocks cannot show a card', () => {
  for (const change of [f => f.playback.episode = 1, f => f.playback.started = false,
    f => f.playback.item.episode_count = 5, f => f.playback.item.vid_list.push('c'),
    f => f.video.duration = Infinity, f => f.video.duration = NaN,
    f => f.video.currentTime = NaN, f => f.video.currentTime = 101]) {
    const f = fixture(); f.video.currentTime = 98; change(f);
    assert.equal(f.update(), false);
    assert.deepEqual(f.calls, []);
  }
});

test('pause, seek, buffering/background/page guards and resets clear immediately; stale clocks do not re-show', () => {
  for (const action of ['paused', 'seeking', 'ended', 'guard', 'reset', 'metadata']) {
    const f = fixture(); f.video.currentTime = 98; f.update();
    if (['paused', 'seeking', 'ended'].includes(action)) { f.video[action] = true; f.update(); }
    else if (action === 'reset') f.controller.reset();
    else f.update(action !== 'guard', action === 'metadata' ? [] : seasons);
    assert.deepEqual(f.calls.at(-1), ['hide']);
  }
  const f = fixture(); f.video.currentTime = 98; f.update();
  f.controller.update(null, f.video, seasons, false);
  assert.deepEqual(f.calls.at(-1), ['hide']);
  f.video.currentTime = 50; assert.equal(f.update(), false);
  f.video.currentTime = 98; assert.equal(f.update(), true);
});

test('the app only consumes account-scoped cached data on the current fullscreen playback', () => {
  const app = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
  const calls = [];
  const playback = { item: { series_id: '2' }, owner: 1, generation: 9 };
  const flags = { cinema: true, page: true, ready: true, hidden: false };
  const context = vm.createContext({
    nextSeasonHint: { update: (...args) => calls.push(args) }, activePlayback: playback,
    accountEpoch: 1, feedGeneration: 9, seasonCatalogCache: { '2': { epoch: 1, items: seasons } },
    shell: { classList: { contains: () => flags.cinema } }, isPlaybackPage: () => flags.page,
    applicationInBackground: false, applicationHidden: () => flags.hidden,
    seasonSwitchRequest: null, detailModalOpen: false, playerOptionsOpen: false, playbackCommandMenuOpen: false,
    discussionOpen: false, confirmOpen: false, scanModalOpen: () => false, supportModalOpen: false,
    endRecommendations: { isOpen: () => false }, playbackVideoReady: () => flags.ready
  });
  vm.runInContext(app.slice(app.indexOf('  function updateNextSeasonHint('), app.indexOf('  function offerEndRecommendations(')), context);
  const video = {};
  context.updateNextSeasonHint(video);
  assert.deepEqual(calls.at(-1), [playback, video, seasons, true]);
  for (const flag of ['cinema', 'page', 'ready']) {
    flags[flag] = false; context.updateNextSeasonHint(video); assert.equal(calls.at(-1)[3], false); flags[flag] = true;
  }
  for (const key of ['applicationInBackground', 'detailModalOpen', 'playerOptionsOpen', 'playbackCommandMenuOpen', 'discussionOpen', 'confirmOpen', 'supportModalOpen', 'seasonSwitchRequest']) {
    context[key] = true; context.updateNextSeasonHint(video); assert.equal(calls.at(-1)[3], false); context[key] = false;
  }
  playback.owner = 2; context.updateNextSeasonHint(video); assert.equal(calls.at(-1)[3], false);
  playback.owner = 1; context.accountEpoch = 2; context.updateNextSeasonHint(video); assert.equal(calls.at(-1)[2], false);
});
