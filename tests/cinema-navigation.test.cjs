const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');

function slice(a, b) {
  return source.slice(source.indexOf('  function ' + a + '('), source.indexOf('  function ' + b + '('));
}

test('card auto cinema keeps playback controls visible until the normal clear timer', () => {
  const player = {};
  const calls = [];
  const c = vm.createContext({
    autoCinemaCandidate: true,
    autoCinemaSession: player,
    autoCinemaPlatform: 'android',
    autoCinemaEnabled: true,
    document: { activeElement: player, getElementById: () => player },
    window: { HongguoAutoCinema: { shouldEnter: options => {
      assert.equal(options.page, 'player');
      assert.equal(options.firstFrame, true);
      assert.equal(options.focusedOnPlayer, true);
      return true;
    } } },
    pageMode: () => 'player',
    cancelPendingAutoCinema() { this.autoCinemaCandidate = false; calls.push('cancel'); },
    setCinema(value) { calls.push('cinema:' + value); },
    revealControls() { calls.push('reveal-controls'); },
    hideControls() { calls.push('hide-controls'); }
  });
  vm.runInContext(slice('finishAutoCinema', 'exitCinema'), c);

  assert.equal(c.finishAutoCinema(player), true);
  assert.deepEqual(calls, ['cancel', 'cinema:true', 'reveal-controls']);
});

test('Back exits sidebar-free playback, reveals controls and focuses the active sidebar item', () => {
  for (const initiallyHidden of [false, true]) {
    const sidebar = { id: 'current-sidebar-item' };
    const calls = [];
    const state = { cinema: true, hidden: initiallyHidden, focused: null };
    const c = vm.createContext({
      coreConnectionModalOpen: false,
      autoCinemaCandidate: false,
      endRecommendations: { close: () => false },
      searchSuggestionOpen: false,
      closeSearchSuggestions() {},
      searchScanOpen: false,
      danmakuScanOpen: false,
      accountCountryModalOpen: false,
      accountKeypadOpen: () => false,
      supportModalOpen: false,
      followNotificationViewOpen: false,
      rankFilterOpen: false,
      actorWorksOpen: false,
      detailCastOpen: false,
      confirmOpen: false,
      playerOptionsOpen: false,
      detailModalOpen: false,
      discussionOpen: false,
      accountData: null,
      document: { activeElement: { id: 'player-control' } },
      shell: { classList: { contains: name => name === 'is-cinema' ? state.cinema : name === 'is-controls-hidden' ? state.hidden : false } },
      pageMode: () => 'player',
      isPlaybackPage: () => true,
      zoneOf: () => 'controls',
      activeSidebar: () => sidebar,
      cancelPendingAutoCinema() {},
      exitCinema(keepHidden) { calls.push(['exit', keepHidden]); state.cinema = false; },
      revealControls() { calls.push('reveal'); state.hidden = false; },
      goFocus(element) { state.focused = element; calls.push(['focus', element]); },
      hideControls() { calls.push('hide'); },
      leavePlayer() { calls.push('leave-player'); }
    });
    vm.runInContext(slice('handleBack', 'handleMediaCommand'), c);

    assert.equal(c.handleBack(), true);
    assert.equal(state.cinema, false);
    assert.equal(state.hidden, false);
    assert.equal(state.focused, sidebar);
    assert.deepEqual(calls, [['exit', false], 'reveal', ['focus', sidebar]]);
  }
});

test('version update settings are the last settings card', () => {
  const settings = html.slice(html.indexOf('id="settings-page"'), html.indexOf('id="support-page"'));
  const cards = [...settings.matchAll(/<div class="settings-card app-update-card(?: is-hidden)?" id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(cards[cards.length - 1], 'app-update-card');
  assert.equal(cards.filter(id => id === 'app-update-card').length, 1);
});
