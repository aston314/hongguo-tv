const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./helpers/app-text.cjs');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const adapter = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/native-player.js'), 'utf8');
function slice(a, b) {
  return source.slice(source.indexOf('  function ' + a + '('), source.indexOf('  function ' + b + '('));
}

test('CSS fullscreen synchronizes real normalized native bounds without a window resize', () => {
  let cinema = false;
  const bounds = [], timers = [];
  const rootClasses = new Set();
  const video = { classList: { toggle() {} }, addEventListener() {} };
  const document = {
    documentElement: { classList: { add: name => rootClasses.add(name) } },
    getElementById: () => video,
    querySelector: () => ({ getBoundingClientRect: () => ({
      left: cinema ? 0 : 250, top: 0, width: cinema ? 960 : 710, height: 540
    }) })
  };
  const c = vm.createContext({ portraitBackdrop: null, document, window: {
    innerWidth: 960, innerHeight: 540, addEventListener() {},
    HongguoNativePlayer: { isAvailable: () => true, engine: () => 'mpv', bounds: (...v) => bounds.push(v) }
  }, shell: { classList: { toggle: (name, value) => { cinema = value; } } },
  updatePlaybackControls() {}, layoutLastPlaybackFrame() {}, setTimeout: fn => timers.push(fn), clearTimeout() {}, isFinite, Promise });
  vm.runInContext(adapter + slice('syncNativePlayerBounds', 'exitCinema'), c);
  c.setCinema(true);
  assert.deepEqual(bounds[0], [0, 0, 1, 1]);
  // Layout retries must use the latest state after a rapid enter/exit.
  c.setCinema(false);
  timers.forEach(fn => fn());
  assert.deepEqual(bounds.at(-1), [250 / 960, 0, 710 / 960, 1]);
  assert.equal(rootClasses.has('native-playback'), true);
});

test('fullscreen remains usable in a browser or standard edition without a native adapter', () => {
  let cinema;
  const c = vm.createContext({ portraitBackdrop: null, window: {}, shell: { classList: { toggle: (n, v) => { cinema = v; } } },
    updatePlaybackControls() {}, layoutLastPlaybackFrame() {}, setTimeout: fn => fn() });
  vm.runInContext(slice('syncNativePlayerBounds', 'exitCinema'), c);
  assert.doesNotThrow(() => c.setCinema(true));
  assert.equal(cinema, true);
});

function focusFixture(height = 1000) {
  const scroll = { id: 'player-diagnostics-scroll', clientHeight: 300, scrollHeight: height, scrollTop: 0 };
  const refresh = { id: 'player-diagnostics-refresh' }, close = { id: 'player-diagnostics-close' };
  const nodes = { [scroll.id]: scroll, [refresh.id]: refresh, [close.id]: close };
  const c = vm.createContext({ document: { getElementById: id => nodes[id] } });
  vm.runInContext(slice('moveDiagnosticFocus', 'renderPlaybackDiagnostics'), c);
  return { c, scroll, refresh, close };
}

test('diagnostics remote scroll is bounded and reaches footer actions at the bottom', () => {
  const f = focusFixture();
  assert.equal(f.c.moveDiagnosticFocus(f.scroll, 'up'), null);
  assert.equal(f.scroll.scrollTop, 0);
  for (let i = 0; i < 4; i++) assert.equal(f.c.moveDiagnosticFocus(f.scroll, 'down'), null);
  assert.equal(f.scroll.scrollTop, 700);
  assert.equal(f.c.moveDiagnosticFocus(f.scroll, 'down'), f.refresh);
  assert.equal(f.c.moveDiagnosticFocus(f.refresh, 'right'), f.close);
  assert.equal(f.c.moveDiagnosticFocus(f.close, 'left'), f.refresh);
  assert.equal(f.c.moveDiagnosticFocus(f.close, 'up'), f.scroll);
  assert.equal(f.scroll.scrollTop, 700);
  f.c.moveDiagnosticFocus(f.scroll, 'up');
  assert.equal(f.scroll.scrollTop, 490);
});

test('diagnostics footer is reachable immediately for short reports or with Right for long reports', () => {
  const short = focusFixture(200);
  assert.equal(short.c.moveDiagnosticFocus(short.scroll, 'down'), short.refresh);
  const long = focusFixture();
  assert.equal(long.c.moveDiagnosticFocus(long.scroll, 'right'), long.refresh);
  assert.equal(long.c.moveDiagnosticFocus(long.refresh, 'left'), long.scroll);
  assert.equal(long.c.moveDiagnosticFocus(long.close, 'right'), null);
});

test('both immediate and asynchronous diagnostic reports preserve scroll when rows are rebuilt', () => {
  const scroll = { scrollTop: 180 };
  const rows = { set innerHTML(v) { scroll.scrollTop = 0; }, appendChild() {} };
  const nodes = { 'player-diagnostics-scroll': scroll, 'player-diagnostics-rows': rows,
    'player-diagnostics-summary': {}, 'player-diagnostics-time': {} };
  const c = vm.createContext({ window: { HongguoPlaybackDiagnostics: { report: s => s } },
    document: { getElementById: id => nodes[id], createElement: () => ({ appendChild() {} }) } });
  vm.runInContext(slice('renderPlaybackDiagnostics', 'refreshPlaybackDiagnostics'), c);
  for (const capturedAt of ['12:00:00', '12:00:01']) {
    c.renderPlaybackDiagnostics({ summary: '测试', rows: [{ label: '状态', value: '播放中' }], capturedAt });
    assert.equal(scroll.scrollTop, 180);
    assert.equal(nodes['player-diagnostics-time'].textContent, '快照 ' + capturedAt);
  }
});
