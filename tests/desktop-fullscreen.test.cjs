const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { uiText } = require('./helpers/app-text.cjs');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const fn = name => source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'))[0];
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(platform = 'windows') {
  const classes = new Set(), calls = [], notices = [], bounds = [], timers = [];
  const attrs = {}, icon = {}, label = { dataset: {}, removeAttribute() {} };
  const button = { setAttribute: (key, value) => { attrs[key] = value; },
    querySelector: selector => selector === 'use' ? { setAttribute: (key, value) => { icon[key] = value; }, setAttributeNS() {} } : label };
  const state = { mini: false, pending: false };
  const context = vm.createContext({
    desktopShell: ['darwin', 'windows', 'linux', 'preview'].includes(platform),
    androidShell: platform === 'android', webosShell: platform === 'webos', nativeFullscreen: false,
    window: { HongguoDesktop: { platform }, go: { main: { desktopApp: {
      SetFullscreen(enabled) { calls.push(enabled); return Promise.resolve(); }
    } } }, HongguoDesktopMini: { isActive: () => state.mini, isPending: () => state.pending } },
    document: { getElementById: id => id === 'player-menu-fullscreen' ? button : null, querySelector: () => null },
    shell: { classList: { contains: name => classes.has(name), toggle(name, value) { value ? classes.add(name) : classes.delete(name); } } },
    playbackCommandMenu: {}, playbackCommandMenuOpen: true,
    activePlayback: null, featuredItem: null, currentDetail: null,
    playbackCommandMenuSeasonButton: () => null,
    updatePlaybackControls() {}, syncNativePlayerBounds() { bounds.push(classes.has('is-cinema')); },
    setTimeout(callback) { timers.push(callback); }, showNotice: text => notices.push(text), uiText,
    revealControls() {}, hideControls() {}, fullscreenExitKeepsHidden: false,
    autoCinemaCandidate: false, autoCinemaSession: null, autoCinemaGeneration: 0
  });
  vm.runInContext(['hasDesktopFullscreenWindow', 'playbackFullscreenActive', 'setCinema', 'cancelPendingAutoCinema',
    'requestDesktopFullscreen', 'enterCinema', 'exitCinema', 'toggleCinema', 'desktopFullscreenChanged', 'updatePlaybackCommandMenu'].map(fn).join('\n'), context);
  return { context, classes, calls, notices, bounds, timers, attrs, icon, label, state };
}

test('all desktop shells request native fullscreen and wait for its observed state before hiding the sidebar', async () => {
  for (const platform of ['darwin', 'windows', 'linux']) {
    const f = fixture(platform);
    f.context.enterCinema(); await flush();
    assert.deepEqual(f.calls, [true]);
    assert.equal(f.classes.has('is-cinema'), false);
    assert.equal(f.attrs['aria-label'], '全屏');
    f.context.desktopFullscreenChanged(true);
    assert.equal(f.classes.has('is-cinema'), true);
    assert.equal(f.context.playbackFullscreenActive(), true);
    assert.equal(f.attrs['aria-label'], '退出全屏');
    assert.equal(f.icon.href, '#icon-fullscreen-exit');
    f.context.toggleCinema(); await flush();
    assert.deepEqual(f.calls, [true, false]);
    f.context.desktopFullscreenChanged(false);
    assert.equal(f.classes.has('is-cinema'), false);
    assert.equal(f.attrs['aria-label'], '全屏');
    assert.equal(f.icon.href, '#icon-fullscreen');
  }
});

test('native rejection, a missing binding and synchronous errors retain a usable window and retry action', async () => {
  for (const binding of [undefined, () => Promise.reject(Error('refused')), () => { throw Error('unavailable'); }]) {
    const f = fixture(); f.context.window.go.main.desktopApp.SetFullscreen = binding;
    f.context.enterCinema(); await flush();
    assert.equal(f.classes.has('is-cinema'), false);
    assert.equal(f.attrs['aria-label'], '全屏');
    assert.equal(f.notices.length, 1);
  }
  const f = fixture(); f.context.desktopFullscreenChanged(true);
  f.context.window.go.main.desktopApp.SetFullscreen = () => Promise.reject(Error('exit refused'));
  f.context.toggleCinema(); await flush();
  assert.equal(f.classes.has('is-cinema'), true);
  assert.equal(f.attrs['aria-label'], '退出全屏');
});

test('a successful binding call alone cannot fabricate fullscreen, and reentry into an already-fullscreen window restores its layout', async () => {
  const f = fixture(); f.context.enterCinema(); await flush();
  assert.equal(f.context.playbackFullscreenActive(), false, 'binding resolves before the native transition');
  assert.equal(f.classes.has('is-cinema'), false);
  f.context.desktopFullscreenChanged(true); f.context.setCinema(false);
  f.context.enterCinema(); await flush();
  assert.equal(f.classes.has('is-cinema'), true, 'an unchanged native state may not emit another transition');
  f.context.desktopFullscreenChanged(false);
  assert.equal(f.classes.has('is-cinema'), false, 'OS-level Escape restores the sidebar and menu label');
  assert.equal(f.attrs['aria-label'], '全屏');
});

test('TV shells fill the playback area without calling desktop or browser fullscreen', () => {
  for (const platform of ['android', 'webos']) {
    const f = fixture(platform);
    f.context.shell.requestFullscreen = () => assert.fail('TV shells are already immersive');
    f.context.toggleCinema();
    assert.equal(f.classes.has('is-cinema'), true);
    assert.equal(f.attrs['aria-label'], '退出全屏');
    assert.equal(f.bounds[0], true);
    f.context.toggleCinema();
    assert.equal(f.classes.has('is-cinema'), false);
    f.timers.forEach(callback => callback());
    assert.equal(f.bounds.at(-1), false);
    assert.deepEqual(f.calls, []);
  }
});

test('browser preview requests fullscreen in the click turn and recovers from a refusal', async () => {
  const f = fixture('preview'); let browserRequests = 0;
  f.context.shell.requestFullscreen = () => { browserRequests++; return Promise.reject(Error('permission denied')); };
  f.context.enterCinema(); assert.equal(browserRequests, 1);
  await flush();
  assert.equal(f.classes.has('is-cinema'), false);
  assert.equal(f.attrs['aria-label'], '全屏');
  assert.deepEqual(f.calls, []);
});

test('native window monitoring during mini mode records fullscreen without replacing its compact layout', () => {
  const f = fixture(); f.context.desktopFullscreenChanged(true);
  f.state.pending = true; f.context.desktopFullscreenChanged(false);
  assert.equal(f.context.nativeFullscreen, false);
  assert.equal(f.classes.has('is-cinema'), true, 'mini controller owns the in-progress layout');
  f.state.pending = false; f.state.mini = true; f.context.desktopFullscreenChanged(true);
  assert.equal(f.context.nativeFullscreen, true);
  f.state.mini = false; f.context.desktopFullscreenChanged(false);
  assert.equal(f.classes.has('is-cinema'), false);
});
