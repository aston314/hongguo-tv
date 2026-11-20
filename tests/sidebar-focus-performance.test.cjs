const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const slice = (a, b) => source.slice(source.indexOf('  function ' + a + '('), source.indexOf('  function ' + b + '('));

function fixture(cardCount) {
  const reads = {content: 0, sidebar: 0, queries: [], mutations: 0, moves: 0};
  let context;
  function node(id, zone = 'sidebar') {
    const classes = new Set([zone === 'sidebar' ? 'side-item' : 'library-card']);
    return {
      id, zone, tagName: 'BUTTON', disabled: false, visible: true, modal: '', connected: true,
      classList: {
        contains: name => classes.has(name),
        add(name) { reads.mutations++; classes.add(name); },
        remove(name) { reads.mutations++; classes.delete(name); }
      },
      matches: () => true,
      closest(selector) { return this.modal === selector ? this : null; },
      getClientRects() { reads[zone]++; return this.visible && this.connected ? [{}] : []; },
      focus() {
        reads.moves++; context.document.activeElement = this;
        // The native target flag and paint also run synchronously on focusin.
        assert.equal(context.isFocusTarget(this), true);
        context.markFocus(this);
      }
    };
  }
  const items = [node('recommend'), node('search'), node('disabled'), node('hidden'), node('history'), node('continue'), node('settings')];
  items[2].disabled = true; items[3].visible = false;
  const cards = Array.from({length: cardCount}, (_, i) => node('card-' + i, 'content'));
  context = vm.createContext({
    focusSelector: '.side-item, .watching-return, .library-card', paintedFocus: null,
    zoneSelectors: {sidebar: '.side-item, .watching-return'},
    document: {
      activeElement: null, body: {},
      querySelectorAll(selector) {
        reads.queries.push(selector);
        return selector === '.side-item, .watching-return' ? items : items.concat(cards);
      }
    },
    window: {getComputedStyle(element) { reads[element.zone]++; return {display: 'block', visibility: 'visible'}; }},
    coreConnectionModalOpen: false, scanModalOpen: () => false, accountCountryModalOpen: false,
    accountKeypadOpen: () => false, supportModalOpen: false, rankFilterOpen: false,
    actorWorksOpen: false, detailCastOpen: false, confirmOpen: false, playbackCommandMenuOpen: false,
    playerOptionsOpen: false, discussionOpen: false, endRecommendations: null, detailModalOpen: false,
    androidShell: true, lastPageFocus: {}, pageMode: () => 'history',
    zoneOf: element => element.zone, firstContentFocus: () => cards[0],
    revealSidebarFocus() {}
  });
  vm.runInContext(slice('focusables', 'revealSidebarFocus') + slice('goFocus', 'firstContentFocus') +
    slice('moveWithinZone', 'moveGrid') + slice('moveFrom', 'accountKeypadOpen'), context);
  context.document.activeElement = items[0]; context.paintFocus(items[0]);
  return {context, items, cards, reads};
}

test('sidebar routing stays local as content grows, skips unavailable entries and preserves boundaries', () => {
  const costs = [];
  for (const cardCount of [40, 400]) {
    const f = fixture(cardCount), c = f.context;
    const targets = [];
    for (const direction of ['up', 'down', 'down', 'down', 'down', 'down', 'up', 'left', 'right']) {
      const target = c.moveFrom(c.remoteFocusTarget(), direction);
      if (target) c.goFocus(target);
      targets.push(c.document.activeElement.id);
    }
    assert.deepEqual(targets, ['recommend', 'search', 'history', 'continue', 'settings', 'settings', 'continue', 'continue', 'card-0']);
    assert.equal(f.reads.moves, 6, 'one focus call per successful move, including Right back to content');
    assert.ok(f.reads.content <= 4, 'only the explicit Right destination may be measured');
    assert.ok(f.reads.queries.every(selector => selector === '.side-item, .watching-return'), 'no full-page focus query');
    costs.push(f.reads.sidebar);
  }
  assert.equal(costs[0], costs[1], 'sidebar work does not grow with the number of cards');
});

test('focus eligibility preserves all modal boundaries and revalidates hidden, disabled or removed targets', () => {
  const f = fixture(0), c = f.context, item = f.items[0];
  const modals = {
    coreConnectionModalOpen: '#core-connection-modal', accountCountryModalOpen: '#account-country-modal',
    supportModalOpen: '#support-modal', rankFilterOpen: '#rank-filter-modal', actorWorksOpen: '#actor-works-modal',
    detailCastOpen: '#detail-cast-modal', confirmOpen: '#confirm-modal', playbackCommandMenuOpen: '#playback-command-menu',
    playerOptionsOpen: '#player-options', discussionOpen: '#discussion-panel', detailModalOpen: '#detail-modal'
  };
  function checkModal(selector, set) {
    set(true);
    item.modal = ''; assert.equal(c.isFocusTarget(item), false, selector + ' excludes background controls');
    item.modal = selector; assert.equal(c.isFocusTarget(item), true);
    set(false); item.modal = '';
  }
  Object.entries(modals).forEach(([flag, selector]) => checkModal(selector, value => { c[flag] = value; }));
  checkModal('#search-scan-modal', value => { c.scanModalOpen = () => value; });
  checkModal('#account-keypad-modal', value => { c.accountKeypadOpen = () => value; });
  checkModal('#end-recommendations', value => { c.endRecommendations = {isOpen: () => value}; });
  for (const selector of ['#detail-modal', '#playback-command-menu', '#discussion-panel', '#end-recommendations']) {
    item.modal = selector; assert.equal(c.isFocusTarget(item), false, 'closed panel is ineligible');
  }
  item.modal = '';
  for (const property of ['disabled', 'visible', 'connected']) {
    const before = item[property]; item[property] = !before;
    assert.equal(c.isFocusTarget(item), false, property + ' is checked without a cached list');
    item[property] = before;
  }
  item.matches = () => false; assert.equal(c.isFocusTarget(item), false, 'non-controls are not remote targets');
  assert.equal(c.isFocusTarget(null), false);
});

test('focusin followed by goFocus paint does not remove and re-add the same highlight', () => {
  const f = fixture(0), c = f.context;
  const before = f.reads.mutations;
  c.goFocus(f.items[1]);
  assert.equal(f.reads.mutations - before, 2, 'only old and new highlights change');
  c.markFocus(f.items[1]);
  assert.equal(f.reads.mutations - before, 2, 'repeated paint does no work');
  c.paintFocus(null);
  assert.equal(f.items[1].classList.contains('is-focused'), false, 'pointer leave still clears its highlight');
});
