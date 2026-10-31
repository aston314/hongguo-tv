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

test('settings remote focus follows the visible card order and keeps version updates last', () => {
  const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
  const fn = (a, b) => source.slice(source.indexOf('  function ' + a + '('), source.indexOf('  function ' + b + '('));
  const node = (id, classes = []) => ({ id, classList: { contains: c => classes.includes(c) } });
  const expanded = node('expanded', ['sidebar-display-action', 'account-action']);
  const icons = node('icons', ['sidebar-display-action', 'account-action']);
  const locale = node('locale', ['locale-action', 'account-action']);
  const directionAll = node('directionAll', ['recommendation-direction-action', 'account-action']);
  const directionLandscape = node('directionLandscape', ['recommendation-direction-action', 'account-action']);
  const update = node('update', ['app-update-action', 'account-action']);
  const prefetchRange = node('prefetchRange', ['episode-prefetch-action', 'account-action']);
  const prefetchFull = node('prefetchFull', ['episode-prefetch-action', 'account-action']);
  const autoCinema = node('autoCinema', ['auto-cinema-action', 'account-action']);
  const webosAudio = node('webosAudio', ['webos-audio-action', 'account-action']);
  const portraitBlack = node('portraitBlack', ['portrait-background-action', 'account-action']);
  const portraitBlur = node('portraitBlur', ['portrait-background-action', 'account-action']);
  const decode = node('decode', ['playback-mode-action', 'account-action']);
  const sidebar = node('sidebar', ['side-item']);
  const zones = { sidebarDisplay: [expanded, icons], localeActions: [locale], recommendationDirection: [directionAll, directionLandscape], appUpdates: [update], autoCinema: [autoCinema], webosAudio: [webosAudio], portraitBackground: [portraitBlack, portraitBlur], episodePrefetch: [prefetchRange, prefetchFull], playbackModes: [decode], sidebar: [sidebar] };
  const visible = { update: true, autoCinema: true, webosAudio: true, portrait: false, prefetch: true, decode: true };
  const c = vm.createContext({
    coreConnectionModalOpen: false,
    scanModalOpen: () => false, supportModalOpen: false, confirmOpen: false,
    rankFilterOpen: false, playerOptionsOpen: false, detailModalOpen: false, discussionOpen: false,
    selectedSidebarDisplay: () => icons, activeSidebar: () => sidebar,
    firstVisible: selector => selector.includes('recommendation-direction-action') ? directionAll : selector.includes('locale-action') ? locale : selector.includes('app-update') ? visible.update ? update : null : selector.includes('auto-cinema') ? visible.autoCinema ? autoCinema : null : selector.includes('webos-audio') ? visible.webosAudio ? webosAudio : null : selector.includes('portrait-background') ? visible.portrait ? portraitBlack : null : selector.includes('episode-prefetch') ? visible.prefetch ? prefetchRange : null : selector.includes('playback-mode') ? visible.decode ? decode : null : null,
    moveWithinZone: (zone, current, direction) => zones[zone][zones[zone].indexOf(current) + (direction === 'left' ? -1 : 1)] || null
  });
  vm.runInContext(fn('zoneOf', 'goFocus') + fn('moveFrom', 'accountKeypadOpen'), c);
  assert.equal(c.zoneOf(icons), 'sidebarDisplay');
  assert.equal(c.moveFrom(expanded, 'right'), icons);
  assert.equal(c.moveFrom(icons, 'left'), expanded);
  assert.equal(c.moveFrom(expanded, 'left'), sidebar);
  assert.equal(c.moveFrom(icons, 'down'), locale);
  assert.equal(c.moveFrom(locale, 'down'), directionAll);
  assert.equal(c.moveFrom(directionAll, 'right'), directionLandscape);
  assert.equal(c.moveFrom(directionAll, 'left'), sidebar);
  assert.equal(c.moveFrom(directionAll, 'up'), locale);
  assert.equal(c.moveFrom(directionAll, 'down'), autoCinema);
  assert.equal(c.moveFrom(autoCinema, 'up'), directionAll);
  assert.equal(c.moveFrom(autoCinema, 'down'), webosAudio);
  assert.equal(c.moveFrom(webosAudio, 'up'), autoCinema);
  assert.equal(c.moveFrom(webosAudio, 'down'), prefetchRange);
  assert.equal(c.moveFrom(prefetchRange, 'up'), webosAudio);
  assert.equal(c.moveFrom(prefetchRange, 'right'), prefetchFull);
  assert.equal(c.moveFrom(prefetchRange, 'down'), decode);
  assert.equal(c.moveFrom(decode, 'up'), prefetchRange);
  assert.equal(c.moveFrom(decode, 'down'), update);
  assert.equal(c.moveFrom(update, 'up'), decode);
  assert.equal(c.moveFrom(icons, 'right'), null);
  visible.portrait = true;
  assert.equal(c.zoneOf(portraitBlack), 'portraitBackground');
  assert.equal(c.moveFrom(webosAudio, 'down'), portraitBlack);
  assert.equal(c.moveFrom(portraitBlack, 'up'), webosAudio);
  assert.equal(c.moveFrom(portraitBlack, 'right'), portraitBlur);
  assert.equal(c.moveFrom(portraitBlur, 'left'), portraitBlack);
  assert.equal(c.moveFrom(portraitBlack, 'left'), sidebar);
  assert.equal(c.moveFrom(portraitBlack, 'down'), prefetchRange);
  assert.equal(c.moveFrom(prefetchRange, 'up'), portraitBlack);
  visible.webosAudio = false;
  assert.equal(c.moveFrom(autoCinema, 'down'), portraitBlack);
  assert.equal(c.moveFrom(portraitBlack, 'up'), autoCinema);
  visible.portrait = false; visible.webosAudio = true;
  visible.decode = false;
  assert.equal(c.moveFrom(prefetchRange, 'down'), update);
  visible.webosAudio = false;
  assert.equal(c.moveFrom(autoCinema, 'down'), prefetchRange);
  visible.webosAudio = false;
  visible.autoCinema = false;
  assert.equal(c.moveFrom(prefetchRange, 'up'), directionAll);
});
