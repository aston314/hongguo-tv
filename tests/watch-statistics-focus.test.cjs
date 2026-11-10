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

test('statistics focus reveals the full preference panel and falls back to the action in a short workspace', () => {
  const workspace = {scrollTop:0,clientTop:0,clientHeight:468,parentElement:null,style:{overflowY:'auto'},getBoundingClientRect:()=>({top:72})};
  const panel = {offsetHeight:340,parentElement:workspace,getBoundingClientRect:()=>({top:650-workspace.scrollTop,bottom:650-workspace.scrollTop+panel.offsetHeight})};
  const action = {tagName:'BUTTON',disabled:false,parentElement:panel,classList:{contains:name=>name==='watch-stat-action'},
    getClientRects:()=>[{}],hasAttribute:name=>name==='data-stat-kind',closest:()=>panel,
    getBoundingClientRect:()=>({top:710-workspace.scrollTop,bottom:744-workspace.scrollTop}),focus(){context.document.activeElement=action;}};
  const context = vm.createContext({document:{activeElement:null},libraryPage:workspace,androidShell:false,
    window:{getComputedStyle:node=>node.style||{visibility:'visible'}},coreConnectionModalOpen:false,
    markFocus(){},zoneOf:()=> 'watchStatistics',pageMode:()=> 'history',accountCountryModalOpen:false,
    scanModalOpen:()=>false,accountKeypadOpen:()=>false,detailModalOpen:false,confirmOpen:false,
    playerOptionsOpen:false,discussionOpen:false,lastPageFocus:{}});
  vm.runInContext(functions('revealSidebarFocus','zoneOf')+functions('goFocus','firstContentFocus'),context);
  context.goFocus(action);
  assert.equal(context.document.activeElement,action);
  assert.ok(panel.getBoundingClientRect().top>=78 && panel.getBoundingClientRect().bottom<=534,'panel fits inside the workspace with focus clearance');
  workspace.scrollTop=0;panel.offsetHeight=700;
  context.goFocus(action);
  assert.ok(action.getBoundingClientRect().top>=78 && action.getBoundingClientRect().bottom<=534,'an oversized panel still keeps its action visible');
});

test('genre navigation follows four, two or one columns after resizing and keeps incomplete-row boundaries', () => {
  let columns = 4;
  const kind = {hasAttribute: name => name === 'data-stat-kind'}, sidebar = {};
  const items = Array.from({length:11}, (_,index) => ({
    hasAttribute: name => name === 'data-stat-preference',
    getBoundingClientRect: () => ({left:index % columns * 220,top:Math.floor(index / columns) * 56,width:196,height:34})
  }));
  const context = vm.createContext({
    focusables: () => items,
    firstVisible: selector => selector === '[data-stat-kind][aria-pressed="true"]' ? kind : null,
    activeSidebar: () => sidebar
  });
  const route = source.slice(source.indexOf("    if (zone === 'watchStatistics')"),source.indexOf("    if (zone === 'libraryActions')"));
  vm.runInContext(functions('moveGrid', 'moveModalFrom') + 'function route(current,direction){var zone="watchStatistics";'+route+'}',context);
  for (columns of [4,2,1]) {
    items.forEach((item,index) => {
      const column = index % columns, row = Math.floor(index / columns);
      assert.equal(context.route(item,'left'),column ? items[index-1] : sidebar);
      assert.equal(context.route(item,'right'),column < columns-1 && index+1 < items.length ? items[index+1] : null,'Right never wraps into a different row');
      assert.equal(context.route(item,'up'),row ? items[index-columns] : kind);
      assert.equal(context.route(item,'down'),row < Math.floor((items.length-1)/columns) ? items[Math.min(index+columns,items.length-1)] : null,'Down uses the closest item in a partial last row, then stops');
    });
  }
});
