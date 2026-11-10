const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
function functions(from, to) {
  return source.slice(source.indexOf('  function ' + from + '('), source.indexOf('  function ' + to + '('));
}

test('statistics never drain the hidden history pager and history pagination resumes after closing', () => {
  let statsOpen = true, visible = false, loads = 0;
  const pager = {
    loaded: true, busy: false, error: '', hasMore: () => true,
    load: () => { loads++; },
    container: {
      getClientRects: () => visible ? [{}] : [],
      querySelectorAll: () => [{getBoundingClientRect: () => ({bottom: visible ? 500 : 0})}],
      closest: () => null
    }
  };
  const context = vm.createContext({
    discussionOpen: false, detailModalOpen: false, confirmOpen: false, playerOptionsOpen: false,
    pageMode: () => 'history', isLibraryPage: () => true,
    watchStatisticsView: {isOpen: () => statsOpen}, libraryPager: pager,
    mainSurface: {getBoundingClientRect: () => ({bottom: 540})}
  });
  const block = functions('visiblePager', 'listBoundary');
  vm.runInContext(block.slice(0, block.indexOf('  function queueTailCheck(')) + block.slice(block.indexOf('  function checkListTail(')), context);
  for (let i = 0; i < 20; i++) context.checkListTail();
  assert.equal(context.visiblePager(), null);
  assert.equal(loads, 0);
  statsOpen = false;
  context.checkListTail();
  assert.equal(loads, 0, 'a hidden container never looks like a visible list tail');
  visible = true;
  context.checkListTail();
  assert.equal(context.visiblePager(), pager);
  assert.equal(loads, 1, 'normal history loading resumes once its container is visible');
});

test('focus validation skips hidden cached cards without resolving their styles', () => {
  function node(visible, style, modal) {
    return {disabled: false, style, closest: selector => selector === '#detail-modal' && modal ? {} : null,
      getClientRects: () => visible ? [{}] : []};
  }
  const hiddenCards = Array.from({length: 400}, () => node(false));
  const day = node(true, {display: 'block', visibility: 'visible'});
  const invisible = node(true, {display: 'block', visibility: 'hidden'});
  const disabled = node(true); disabled.disabled = true;
  const modal = node(true, {display: 'block', visibility: 'visible'}, true);
  const reads = [];
  const context = vm.createContext({
    zoneSelectors: {statistics: '.watch-stat-action'},
    document: {querySelectorAll: () => hiddenCards.concat(day, invisible, disabled, modal)},
    window: {getComputedStyle: element => { reads.push(element); assert.ok(element.style); return element.style; }},
    coreConnectionModalOpen: false, scanModalOpen: () => false, accountCountryModalOpen: false,
    accountKeypadOpen: () => false, supportModalOpen: false, rankFilterOpen: false,
    detailCastOpen: false, confirmOpen: false, playerOptionsOpen: false,
    discussionOpen: false, endRecommendations: null, detailModalOpen: false
  });
  vm.runInContext(functions('focusables', 'firstVisible'), context);
  assert.deepEqual(Array.from(context.focusables()), [day]);
  assert.deepEqual(reads, [day, invisible]);
  reads.length = 0;
  context.detailModalOpen = true;
  assert.deepEqual(Array.from(context.focusables()), [modal]);
  assert.deepEqual(reads, [modal], 'modal focus containment is unchanged');
});
