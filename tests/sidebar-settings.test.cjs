const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { create, read, write, key } = require('../core/cmd/hongguotv/ui/sidebar-settings.js');

function storage(initial) {
  const values = Object.assign({}, initial);
  return {
    getItem(name) { return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null; },
    setItem(name, value) { values[name] = String(value); },
    values
  };
}

test('sidebar display defaults to expanded and rejects invalid persisted values', () => {
  const empty = storage();
  assert.equal(read(empty), 'expanded');
  assert.equal(read(storage({ [key]: 'compact' })), 'expanded');
});

test('sidebar display selection persists and is restored by a new controller', () => {
  const store = storage();
  const states = [];
  const settings = create({ storage: store, render: state => states.push(state.mode) });
  assert.deepEqual(states, ['expanded']);
  assert.equal(settings.choose('icons'), true);
  assert.equal(settings.mode(), 'icons');
  assert.equal(read(store), 'icons');
  const restored = create({ storage: store });
  assert.equal(restored.mode(), 'icons');
  assert.equal(store.values[key], 'icons');
});

test('storage failures do not report a successful mode change', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(read(broken), 'expanded');
  assert.equal(write(broken, 'icons'), false);
  const states = [];
  const settings = create({ storage: broken, render: state => states.push(state.mode) });
  assert.equal(settings.choose('icons'), false);
  assert.deepEqual(states, ['expanded']);
  const dropped = { getItem() { return null; }, setItem() {} };
  assert.equal(write(dropped, 'expanded'), false);
  assert.equal(write(undefined, 'icons'), false);
});

test('only the two supported display modes can be written', () => {
  const store = storage();
  assert.equal(write(store, 'expanded'), true);
  assert.equal(write(store, 'icons'), true);
  assert.equal(write(store, 'auto'), false);
  assert.equal(read(store), 'icons');
});

test('Android preference survives changing WebView origins without writing browser storage', () => {
  let saved = 'expanded';
  const bridge = {
    readSidebarDisplay: () => saved,
    writeSidebarDisplay: value => { saved = value; }
  };
  const oldOrigin = storage(), newOrigin = storage();
  const settings = create({ bridge, storage: oldOrigin });
  assert.equal(settings.choose('icons'), true);
  assert.equal(create({ bridge, storage: newOrigin }).mode(), 'icons');
  assert.deepEqual(oldOrigin.values, {});
  assert.deepEqual(newOrigin.values, {});
  bridge.writeSidebarDisplay = () => { throw new Error('save failed'); };
  assert.equal(settings.choose('expanded'), false);
  assert.equal(settings.mode(), 'icons');
});

test('settings remote focus moves between display modes, updates and decoding without losing the sidebar return path', () => {
  const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
  const fn = (a, b) => source.slice(source.indexOf('  function ' + a + '('), source.indexOf('  function ' + b + '('));
  const node = (id, classes = []) => ({ id, classList: { contains: c => classes.includes(c) } });
  const expanded = node('expanded', ['sidebar-display-action', 'account-action']);
  const icons = node('icons', ['sidebar-display-action', 'account-action']);
  const locale = node('locale', ['locale-action', 'account-action']);
  const update = node('update', ['app-update-action', 'account-action']);
  const prefetchRange = node('prefetchRange', ['episode-prefetch-action', 'account-action']);
  const prefetchFull = node('prefetchFull', ['episode-prefetch-action', 'account-action']);
  const autoCinema = node('autoCinema', ['auto-cinema-action', 'account-action']);
  const decode = node('decode', ['playback-mode-action', 'account-action']);
  const sidebar = node('sidebar', ['side-item']);
  const nodes = [expanded, icons, locale, autoCinema, update, prefetchRange, prefetchFull, decode, sidebar];
  const zones = { sidebarDisplay: [expanded, icons], localeActions: [locale], appUpdates: [update], autoCinema: [autoCinema], episodePrefetch: [prefetchRange, prefetchFull], playbackModes: [decode], sidebar: [sidebar] };
  let updateVisible = true;
  const c = vm.createContext({
    coreConnectionModalOpen: false,
    scanModalOpen: () => false, supportModalOpen: false, confirmOpen: false,
    rankFilterOpen: false, playerOptionsOpen: false, detailModalOpen: false, discussionOpen: false,
    selectedSidebarDisplay: () => icons, activeSidebar: () => sidebar,
    firstVisible: selector => selector.includes('locale-action') ? locale : selector.includes('app-update') ? updateVisible ? update : null : selector.includes('auto-cinema') ? autoCinema : selector.includes('episode-prefetch') ? prefetchRange : selector.includes('playback-mode') ? decode : null,
    moveWithinZone: (zone, current, direction) => zones[zone][zones[zone].indexOf(current) + (direction === 'left' ? -1 : 1)] || null
  });
  vm.runInContext(fn('zoneOf', 'goFocus') + fn('moveFrom', 'accountKeypadOpen'), c);
  assert.equal(c.zoneOf(icons), 'sidebarDisplay');
  assert.equal(c.moveFrom(expanded, 'right'), icons);
  assert.equal(c.moveFrom(icons, 'left'), expanded);
  assert.equal(c.moveFrom(expanded, 'left'), sidebar);
  assert.equal(c.moveFrom(icons, 'down'), locale);
  assert.equal(c.moveFrom(locale, 'down'), autoCinema);
  assert.equal(c.moveFrom(autoCinema, 'up'), locale);
  assert.equal(c.moveFrom(autoCinema, 'down'), update);
  assert.equal(c.moveFrom(update, 'up'), autoCinema);
  assert.equal(c.moveFrom(update, 'down'), prefetchRange);
  assert.equal(c.moveFrom(prefetchRange, 'right'), prefetchFull);
  assert.equal(c.moveFrom(prefetchRange, 'down'), decode);
  assert.equal(c.moveFrom(decode, 'up'), prefetchRange);
  assert.equal(c.moveFrom(icons, 'right'), null);
  updateVisible = false;
  assert.equal(c.moveFrom(autoCinema, 'down'), prefetchRange);
  assert.equal(c.moveFrom(decode, 'up'), prefetchRange);
});
