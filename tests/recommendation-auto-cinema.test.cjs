const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { create } = require('../core/cmd/hongguotv/ui/recommendation-auto-cinema.js');
const { create: createCardCinema } = require('../core/cmd/hongguotv/ui/auto-cinema.js');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const slice = (a, b) => source.slice(source.indexOf('  function ' + a + '('), source.indexOf('  function ' + b + '('));

function preferences({ platform = 'android', television = true, initial = 'disabled' } = {}) {
  const values = { recommendation: initial, card: 'enabled' };
  const states = [];
  const bridge = {
    readRecommendationAutoCinema: () => values.recommendation,
    writeRecommendationAutoCinema(value) { values.recommendation = value; },
    readAutoCinema: () => values.card,
    writeAutoCinema(value) { values.card = value; }
  };
  const options = { platform, diagnostics: { isTelevision: () => television }, bridge, render: state => states.push(state) };
  return { controller: create(options), values, bridge, options, states };
}

test('recommendation fullscreen is opt-in and persists independently of card fullscreen', () => {
  const f = preferences();
  const cards = createCardCinema({ platform: 'android', bridge: f.bridge });
  assert.equal(f.controller.enabled(), false);
  assert.equal(f.states[0].supported, true);
  assert.equal(cards.enabled(), true);
  assert.equal(f.controller.choose('enabled'), true);
  assert.equal(f.controller.enabled(), true);
  assert.equal(create(f.options).enabled(), true, 'a new WebView origin reads the native choice');
  assert.equal(cards.choose('disabled'), true);
  assert.equal(create(f.options).enabled(), true);
  assert.equal(f.controller.choose('disabled'), true);
  assert.equal(create(f.options).enabled(), false);
});

test('desktop, webOS, previews and Android phones cannot enable the TV-only behavior', () => {
  for (const flags of [{ platform: 'desktop' }, { platform: 'webos' }, { platform: 'preview' }, { television: false }]) {
    const f = preferences({ ...flags, initial: 'enabled' });
    assert.equal(f.states[0].supported, false);
    assert.equal(f.controller.enabled(), false);
    assert.equal(f.controller.choose('enabled'), false);
  }
});

test('missing or failing TV detection and old native bridges leave the setting disabled', () => {
  for (const diagnostics of [undefined, {}, { isTelevision() { throw Error('unavailable'); } }]) {
    const f = preferences();
    const controller = create({ ...f.options, diagnostics });
    assert.equal(controller.enabled(), false);
    assert.equal(controller.choose('enabled'), false);
  }
  const oldShell = create({ platform: 'android', diagnostics: { isTelevision: () => true }, bridge: {} });
  assert.equal(oldShell.enabled(), false);
  assert.equal(oldShell.choose('enabled'), false);
  for (const initial of [undefined, null, '', 'invalid']) assert.equal(preferences({ initial }).controller.enabled(), false);
});

test('failed or unconfirmed saves preserve the effective choice and show a retry message', () => {
  for (const initial of ['disabled', 'enabled']) {
    for (const throws of [false, true]) {
      const f = preferences({ initial });
      f.bridge.writeRecommendationAutoCinema = () => { if (throws) throw Error('storage full'); };
      assert.equal(f.controller.choose(initial === 'enabled' ? 'disabled' : 'enabled'), false);
      assert.equal(f.controller.enabled(), initial === 'enabled');
      assert.equal(f.states.at(-1).message, 'save_failed');
      assert.equal(f.controller.choose('invalid'), false);
    }
  }
});

function playbackFixture(flags = {}) {
  const pref = preferences(flags);
  if (flags.enabled !== false) pref.controller.choose('enabled');
  const classes = new Set();
  const feed = { id: 'hero-feed-focus' };
  const video = { paused: false, ended: false };
  const heroClasses = new Set();
  const calls = [];
  const timers = [];
  const state = { page: 'recommend', zone: 'feed', ready: true, hidden: false };
  const document = {
    activeElement: feed,
    getElementById(id) {
      return id === 'hero-video' ? video : id === 'hero-feed-focus' ? feed :
        id === 'hero' ? { classList: { contains: name => heroClasses.has(name) } } : null;
    }
  };
  const context = vm.createContext({
    recommendationAutoCinemaPreferences: pref.controller,
    document,
    shell: { classList: { contains: name => classes.has(name), add: name => classes.add(name), toggle(name, value) { value ? classes.add(name) : classes.delete(name); } } },
    controlsTimer: 1,
    activePlayback: { started: true, presentation: {} },
    applicationInBackground: false,
    applicationHidden: () => state.hidden,
    coreConnectionModalOpen: false,
    scanModalOpen: () => false,
    supportModalOpen: false,
    accountCountryModalOpen: false,
    accountKeypadOpen: () => false,
    detailModalOpen: false,
    actorWorksOpen: false,
    detailCastOpen: false,
    rankFilterOpen: false,
    confirmOpen: false,
    playerOptionsOpen: false,
    playbackCommandMenuOpen: false,
    discussionOpen: false,
    endRecommendations: { isOpen: () => false },
    pageMode: () => state.page,
    isPlaybackPage: () => ['recommend', 'player'].includes(state.page),
    zoneOf: () => state.zone,
    goFocus(target) { document.activeElement = target; state.zone = 'feed'; },
    playbackVideoReady: () => state.ready,
    clearTimeout() {},
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
    updatePlaybackControls() { calls.push('update-controls'); },
    syncNativePlayerBounds() { calls.push('sync-bounds'); },
    enterCinema() { context.setCinema(true); }
  });
  vm.runInContext(slice('hideControls', 'clearPrefetchedEpisodeHint') + slice('setCinema', 'cancelPendingAutoCinema'), context);
  return { context, classes, state, calls, timers, video, heroClasses, pref, feed };
}

test('clearing a playing recommendation reuses fullscreen bounds and keeps controls hidden', () => {
  const f = playbackFixture();
  f.context.hideControls();
  assert.equal(f.classes.has('is-controls-hidden'), true);
  assert.equal(f.classes.has('is-cinema'), true);
  assert.equal(f.context.document.activeElement, f.feed);
  assert.deepEqual(f.calls, ['update-controls', 'sync-bounds']);
  assert.deepEqual(f.timers.map(timer => timer.delay), [0, 120], 'only the existing bounds callbacks run; no countdown');
  f.timers.forEach(timer => timer.callback());
  assert.equal(f.calls.filter(call => call === 'sync-bounds').length, 3);
  f.context.hideControls();
  f.classes.delete('is-controls-hidden');
  f.context.hideControls();
  assert.equal(f.calls.filter(call => call === 'update-controls').length, 1, 'already-fullscreen clear cycles do not reenter');
});

test('default-off, other pages and unsupported devices retain the current clear-screen behavior', () => {
  for (const flags of [{ enabled: false }, { television: false }, { platform: 'desktop' }, { platform: 'webos' }]) {
    const f = playbackFixture(flags);
    f.context.hideControls();
    assert.equal(f.classes.has('is-controls-hidden'), true);
    assert.equal(f.classes.has('is-cinema'), false);
    assert.deepEqual(f.calls, []);
  }
  const singleDrama = playbackFixture();
  singleDrama.state.page = 'player';
  singleDrama.context.hideControls();
  assert.equal(singleDrama.classes.has('is-cinema'), false);
});

test('paused, preparing, buffering, failed or background playback cannot auto fullscreen', () => {
  const cases = [
    f => { f.video.paused = true; },
    f => { f.video.ended = true; },
    f => { f.context.activePlayback = null; },
    f => { f.context.activePlayback.continuationPending = true; },
    f => { f.state.ready = false; },
    f => { f.heroClasses.add('is-preparing-video'); },
    f => { f.context.applicationInBackground = true; },
    f => { f.state.hidden = true; }
  ];
  for (const change of cases) {
    const f = playbackFixture(); change(f); f.context.hideControls();
    assert.equal(f.classes.has('is-cinema'), false);
  }
});

test('sidebar focus and modal interaction do not enter fullscreen', () => {
  for (const key of ['coreConnectionModalOpen', 'supportModalOpen', 'accountCountryModalOpen', 'detailModalOpen',
    'actorWorksOpen', 'detailCastOpen', 'rankFilterOpen', 'confirmOpen', 'playerOptionsOpen', 'playbackCommandMenuOpen', 'discussionOpen']) {
    const f = playbackFixture(); f.context[key] = true; f.context.hideControls();
    assert.equal(f.classes.has('is-cinema'), false, key);
  }
  for (const key of ['scanModalOpen', 'accountKeypadOpen']) {
    const f = playbackFixture(); f.context[key] = () => true; f.context.hideControls();
    assert.equal(f.classes.has('is-cinema'), false, key);
  }
  const f = playbackFixture(); f.state.zone = 'sidebar'; f.context.hideControls();
  assert.equal(f.classes.has('is-controls-hidden'), false);
  assert.equal(f.classes.has('is-cinema'), false);
});

test('the new settings toggle has a two-way remote path without changing other platforms', () => {
  function navigation(visible) {
    const selectors = new Set(visible);
    const c = vm.createContext({
      coreConnectionModalOpen: false,
      endRecommendations: null,
      detailModalOpen: false, actorWorksOpen: false, confirmOpen: false, playerOptionsOpen: false,
      discussionOpen: false, accountCountryModalOpen: false, supportModalOpen: false, rankFilterOpen: false,
      scanModalOpen: () => false, accountKeypadOpen: () => false,
      zoneOf: node => node.zone,
      firstVisible: selector => selectors.has(selector) ? selector : null,
      activeSidebar: () => 'sidebar',
      moveWithinZone: () => null
    });
    vm.runInContext(slice('moveFrom', 'accountKeypadFocus'), c);
    return (zone, direction) => c.moveFrom({ zone }, direction);
  }
  const tv = navigation(['.auto-cinema-action', '.recommendation-auto-cinema-action', '.portrait-background-action']);
  assert.equal(tv('autoCinema', 'down'), '.recommendation-auto-cinema-action');
  assert.equal(tv('recommendationAutoCinema', 'up'), '.auto-cinema-action');
  assert.equal(tv('recommendationAutoCinema', 'down'), '.portrait-background-action');
  assert.equal(tv('portraitBackground', 'up'), '.recommendation-auto-cinema-action');
  assert.equal(tv('recommendationAutoCinema', 'left'), 'sidebar');
  assert.equal(tv('recommendationAutoCinema', 'right'), null);
  const oldTV = navigation(['.auto-cinema-action', '.recommendation-auto-cinema-action', '.danmaku-region-action']);
  assert.equal(oldTV('recommendationAutoCinema', 'down'), '.danmaku-region-action');
  assert.equal(oldTV('danmakuRegion', 'up'), '.recommendation-auto-cinema-action');
  const webos = navigation(['.auto-cinema-action', '.webos-audio-action']);
  assert.equal(webos('autoCinema', 'down'), '.webos-audio-action');
});
