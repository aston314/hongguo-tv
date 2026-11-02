const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { create, normalize, key } = require('../core/cmd/hongguotv/ui/startup-page.js');
const app = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');

function storage(initial) {
  const values = { ...initial };
  return { values, getItem: name => values[name] || null, setItem: (name, value) => { values[name] = value; } };
}

test('new installations and unknown settings keep recommendation as the startup page', () => {
  for (const value of [undefined, null, '', 'settings', 'player', '__proto__', {}, 1]) {
    assert.equal(normalize(value), 'recommend');
    assert.equal(create({ storage: storage({ [key]: value }) }).page(), 'recommend');
  }
});

for (const page of ['recommend', 'rank', 'new', 'history', 'favorites']) {
  test(page + ' persists and restores without touching other preferences', () => {
    const store = storage({ other: 'keep' });
    const rendered = [];
    const settings = create({ storage: store, render: state => rendered.push(state.page) });
    assert.equal(settings.choose(page), true);
    assert.equal(settings.page(), page);
    assert.equal(create({ storage: store }).page(), page);
    assert.deepEqual(store.values, { other: 'keep', [key]: page });
    assert.deepEqual(rendered, ['recommend', page]);
    assert.equal(settings.choose('player'), false);
    assert.equal(settings.page(), page);
  });
}

test('failed or unconfirmed saves retain the previous selected page', () => {
  for (const store of [
    undefined,
    { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } },
    { getItem: () => 'recommend', setItem() {} }
  ]) {
    const rendered = [];
    const settings = create({ storage: store, render: state => rendered.push(state.page) });
    assert.equal(settings.choose('history'), false);
    assert.equal(settings.page(), 'recommend');
    assert.deepEqual(rendered, ['recommend']);
  }
});

test('Android startup preference survives port changes and never falls back to a different browser value after a native save failure', () => {
  let saved = 'recommend';
  const bridge = { readStartupPage: () => saved, writeStartupPage: value => { saved = value; } };
  const firstOrigin = storage(), nextOrigin = storage({ [key]: 'favorites' });
  const settings = create({ bridge, storage: firstOrigin });
  assert.equal(settings.choose('history'), true);
  const restarted = create({ bridge, storage: nextOrigin });
  assert.equal(restarted.page(), 'history');
  bridge.writeStartupPage = () => { throw new Error('native write failed'); };
  assert.equal(restarted.choose('new'), false);
  assert.equal(restarted.page(), 'history');
  assert.deepEqual(firstOrigin.values, {});
  assert.deepEqual(nextOrigin.values, { [key]: 'favorites' });
});

function startup({ page, home = '', bridgeError = false, accountReady = true, missingPage = false } = {}) {
  const calls = [], store = storage({ [key]: page });
  const pages = Object.fromEntries(['rank', 'new', 'history', 'favorites'].map(name => [name, { dataset: { page: name } }]));
  let active = { dataset: { page: 'recommend' } };
  const c = vm.createContext({
    JSON, window: { HongguoTVHome: { consumeHomeProgram() { if (bridgeError) throw new Error('unavailable'); return home; } } },
    document: { querySelector(selector) { const match = selector.match(/data-page="([^"]+)"/); return missingPage ? null : pages[match && match[1]]; } },
    startupPageSettings: create({ storage: store }),
    accountStatusInitialized: accountReady, pendingAccountHomeProgram: null,
    uiText: (key, fallback) => fallback,
    activatePage(target) { active = target; calls.push(['page', target.dataset.page]); },
    activeSidebar: () => active,
    goFocus: target => calls.push(['focus', target.dataset.page]),
    loadCatalog: () => calls.push(['recommend']),
    pollAccount: () => calls.push(['account']),
    startPlayer: item => calls.push(['play', item.series_id])
  });
  const homeStart = app.indexOf('  function openHomeProgram(');
  const homeEnd = app.indexOf('\n  window.HongguoTV =', homeStart);
  const start = app.indexOf('  function openStartupPage(');
  const end = app.indexOf('\n  updateWebOSAudioSettings();', start);
  assert.ok(homeStart >= 0 && homeEnd > homeStart && start >= 0 && end > start);
  vm.runInContext(app.slice(homeStart, homeEnd) + app.slice(start, end), c);
  c.window.HongguoTV = { openHomeProgram: c.openHomeProgram };
  return { c, calls };
}

for (const page of ['rank', 'new', 'history', 'favorites']) {
  test('cold start enters ' + page + ' directly without starting recommendations or playback', () => {
    const f = startup({ page });
    f.c.openStartupPage();
    assert.deepEqual(f.calls, [['page', page], ['focus', page]]);
  });
}

test('default and invalid settings start recommendations once', () => {
  for (const page of ['recommend', 'unknown', undefined]) {
    const f = startup({ page }); f.c.openStartupPage();
    assert.deepEqual(f.calls, [['recommend']]);
  }
});

test('an unavailable saved page safely falls back to recommendations', () => {
  const f = startup({ page: 'history', missingPage: true }); f.c.openStartupPage();
  assert.deepEqual(f.calls, [['recommend']]);
});

test('TV home card playback takes priority over the selected startup page', () => {
  const f = startup({ page: 'history', home: JSON.stringify({ series_id: '123', title: '指定剧' }) });
  f.c.openStartupPage();
  assert.deepEqual(f.calls, [['play', '123']]);
});

test('a cold home card waits for the account without falling through to the startup page', () => {
  const f = startup({ page: 'rank', home: JSON.stringify({ series_id: '123' }), accountReady: false });
  f.c.openStartupPage();
  assert.deepEqual(f.calls, [['account']]);
  f.c.accountStatusInitialized = true; f.c.startPendingAccountHomeProgram();
  assert.deepEqual(f.calls, [['account'], ['play', '123']]);
});

test('invalid home links and bridge errors retain the configured startup page', () => {
  for (const options of [{ home: '{bad' }, { home: JSON.stringify({ series_id: '0' }) }, { bridgeError: true }]) {
    const f = startup({ page: 'favorites', ...options }); f.c.openStartupPage();
    assert.deepEqual(f.calls, [['page', 'favorites'], ['focus', 'favorites']]);
  }
});

test('startup selection is applied only at initialization, never on foreground resume or settings click', () => {
  assert.equal((app.match(/\bopenStartupPage\(\);/g) || []).length, 1);
  const resume = app.slice(app.indexOf('  function resumeFromBackground('), app.indexOf('  function resetPlayerUI('));
  assert.doesNotMatch(resume, /openStartupPage|startupPageSettings|activatePage\(/);
  const click = app.lastIndexOf("  document.querySelectorAll('.startup-page-action').forEach");
  assert.ok(click >= 0);
  const handler = app.slice(click, app.indexOf('  renderLocaleSettings();', click));
  assert.match(handler, /startupPageSettings.choose/);
  assert.doesNotMatch(handler, /activatePage\(|openStartupPage\(/);
});
