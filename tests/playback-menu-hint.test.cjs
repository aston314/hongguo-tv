const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const css = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'), 'utf8');
const html = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');

test('menu hint labels use readable fixed sizes instead of shrinking with the SVG', () => {
  assert.match(css, /\.playback-menu-hint-label\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /\.playback-menu-hint-menu-title\s*\{[^}]*font-size:\s*19px/);
  assert.match(css, /\.playback-menu-hint-card\s*>\s*p\s*\{[^}]*font-size:\s*18px/);
  assert.match(css, /\.playback-menu-hint-card\s*>\s*p\s*\+\s*p\s*\{[^}]*font-size:\s*16px/);
  assert.doesNotMatch(css, /\.playback-menu-hint-label\s*\{[^}]*font-size:\s*\d+(?:\.\d+)?%/);
});

test('the Android shell hides the right-side playback menu', () => {
  assert.match(css, /html\.android-shell\s+#playback-command-menu\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(app, /document\.documentElement\.classList\.toggle\('android-shell',\s*androidShell\)/);
});

test('send-danmaku follows the danmaku toggle in the shared playback controls', () => {
  const danmaku = html.indexOf('data-action="danmaku"');
  const send = html.indexOf('data-action="send-danmaku"');
  const fullscreen = html.indexOf('data-action="fullscreen"', send);
  const episodes = html.indexOf('data-action="episodes"');
  assert.ok(danmaku >= 0 && send > danmaku && fullscreen > send);
  assert.ok(episodes >= 0 && episodes < send);
  assert.equal((html.match(/data-action="send-danmaku"/g) || []).length, 1);
});

function functionSource(name, nextName) {
  const start = app.indexOf('  function ' + name + '(');
  const end = app.indexOf('\n  function ' + nextName + '(', start);
  assert.ok(start >= 0 && end > start, 'expected function boundaries for ' + name);
  return app.slice(start, end);
}

test('first loaded recommendation arms the one-time menu hint before autoplay', () => {
  const context = vm.createContext({
    playbackMenuHintAvailable: true,
    playbackMenuHintSeen: false,
    playbackMenuHintCandidate: false,
    feedItems: [{ series_id: '123' }],
    pageMode: () => 'recommend'
  });
  vm.runInContext(functionSource('armPlaybackMenuHint', 'showPlaybackMenuHint'), context);
  assert.equal(context.armPlaybackMenuHint(), true);
  assert.equal(context.playbackMenuHintCandidate, true);

  const renderFeed = functionSource('renderFeed', 'isAutoCinemaCardLaunch');
  assert.ok(renderFeed.indexOf('armPlaybackMenuHint();') < renderFeed.indexOf('playFeedItem(startIndex,'));
});

test('autoplayed recommendation can show the hint after playback starts', () => {
  const classes = new Set(['is-hidden']);
  const timers = [];
  const hint = {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const context = vm.createContext({
    playbackMenuHintAvailable: true,
    playbackMenuHintSeen: false,
    playbackMenuHintCandidate: true,
    playbackMenuHintTimer: 0,
    isPlaybackPage: () => true,
    pageMode: () => 'recommend',
    savePlaybackMenuHintSeen() { this.playbackMenuHintSeen = true; },
    updatePlaybackMenuHintCopy() {},
    document: { getElementById(id) { return id === 'playback-menu-hint' ? hint : null; } },
    clearTimeout() {},
    closePlaybackMenuHint() {},
    setTimeout(fn, delay) { timers.push({ fn, delay }); return 1; }
  });
  vm.runInContext(functionSource('showPlaybackMenuHint', 'notificationAccountKey'), context);

  assert.equal(context.showPlaybackMenuHint({ episode: 1 }), true);
  assert.equal(context.playbackMenuHintSeen, true);
  assert.equal(classes.has('is-hidden'), false);
  assert.equal(hint.attributes['aria-hidden'], 'false');
  assert.equal(timers[0].delay, 10000);
});

test('menu hint remains unavailable after it has already been seen', () => {
  const context = vm.createContext({
    playbackMenuHintAvailable: true,
    playbackMenuHintSeen: true,
    playbackMenuHintCandidate: true,
    isPlaybackPage: () => true
  });
  vm.runInContext(functionSource('showPlaybackMenuHint', 'notificationAccountKey'), context);
  assert.equal(context.showPlaybackMenuHint({ episode: 1 }), false);
});

test('recommendation autoplay exposes the playback menu only after a media source exists', () => {
  const video = { source: '', getAttribute(name) { return name === 'src' ? this.source : null; } };
  const context = vm.createContext({
    pageMode: () => 'recommend',
    activePlayback: null,
    document: { getElementById(id) { return id === 'hero-video' ? video : null; } }
  });
  vm.runInContext(functionSource('playbackCommandMenuAvailable', 'playbackCommandMenuSeasonButton'), context);
  assert.equal(context.playbackCommandMenuAvailable(), false);
  context.activePlayback = { vid: 'video-1' };
  assert.equal(context.playbackCommandMenuAvailable(), false);
  video.source = '/minireel-proxy/media/video-1.mp4';
  assert.equal(context.playbackCommandMenuAvailable(), true);
});

test('dedicated player page keeps the playback menu available during source preparation', () => {
  const context = vm.createContext({
    pageMode: () => 'player',
    activePlayback: null,
    document: { getElementById() { return null; } }
  });
  vm.runInContext(functionSource('playbackCommandMenuAvailable', 'playbackCommandMenuSeasonButton'), context);
  assert.equal(context.playbackCommandMenuAvailable(), true);
});

test('Android menu key focuses the existing bottom playback controls', () => {
  const classes = new Set();
  const focused = [];
  const button = {
    classList: { contains(name) { return classes.has(name); } },
    getClientRects() { return [{}]; }
  };
  const context = vm.createContext({
    androidShell: true,
    playbackCommandMenuAvailable: () => true,
    detailModalOpen: false, confirmOpen: false, discussionOpen: false,
    supportModalOpen: false, rankFilterOpen: false, detailCastOpen: false,
    playerOptionsOpen: false, scanModalOpen: () => false,
    actorWorksOpen: false, endRecommendations: { isOpen: () => false },
    revealControls() { focused.push('reveal'); },
    remoteFocusTarget: () => null,
    document: { activeElement: {}, getElementById() { return null; } },
    zoneOf: () => 'feed',
    lastPlaybackControl: null,
    firstVisible(selector) { return selector === '[data-action="pause"]' ? button : null; },
    goFocus(target) { focused.push(target); }
  });
  vm.runInContext(functionSource('focusAndroidPlaybackControls', 'togglePlaybackCommandMenu'), context);
  assert.equal(context.focusAndroidPlaybackControls(), true);
  assert.deepEqual(focused, ['reveal', button]);
});
