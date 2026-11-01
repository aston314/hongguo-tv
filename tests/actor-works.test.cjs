const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./helpers/app-text.cjs');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');

function element(tag) {
  return {
    tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, className: '', textContent: '',
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, handler) { this.handlers = this.handlers || {}; this.handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    classList: { add() {}, remove() {}, contains() { return false; } }
  };
}

test('ranking actor rows expose a selectable works action instead of starting playback', () => {
  const rows = [];
  const rankList = element('div');
  Object.defineProperty(rankList, 'innerHTML', { set() { rankList.children = []; } });
  const update = element('span');
  const c = vm.createContext({
    rankItems: [], rankList, rankSelection: { rank: 'ranklist_celebrity' },
    document: {
      createElement: element,
      getElementById(id) { return id === 'rank-list-update' ? update : element('span'); }
    },
    rankLabel: () => '演员榜', dramaMeta: () => '演员简介', setCover() {},
    openActorWorks(item) { c.openedActor = item; }, startPlayer() { c.played = true; },
    openDetail() {}, goFocus() {}, firstRankRow() {},
    tryScrollIntoView() {}, rows
  });
  const start = source.indexOf('  function renderRank(');
  const end = source.indexOf('  function renderNew(', start);
  vm.runInContext(source.slice(start, end), c);
  const actor = { series_id: 'actor-1234567890123456789', actor_id: '1234567890123456789', title: '测试演员', cover: 'https://avatar' };
  c.renderRank([actor], false);

  assert.equal(rankList.children.length, 1);
  const row = rankList.children[0];
  const action = row.children[3].children[0];
  assert.equal(action.className, 'rank-row-actor');
  action.handlers.click({ stopPropagation() {} });
  assert.equal(c.openedActor.actor_id, actor.actor_id);
  assert.equal(c.played, undefined);
});

test('actor works modal traps focus, restores its opener on Back, and retries without replacing the opener', () => {
  const focusBlock = source.slice(source.indexOf('  function focusables('), source.indexOf('  function firstVisible('));
  const modalMove = source.slice(source.indexOf('  function moveModalFrom('), source.indexOf('  function moveFrom('));
  const actorBlock = source.slice(source.indexOf('  function renderActorWorks('), source.indexOf('  function applyRankFilter('));
  assert.match(source, /if \(typeof actorWorksOpen !== 'undefined' && actorWorksOpen && !event\.target\.closest\('#actor-works-modal'\)\)/);
  assert.match(source, /if \(typeof actorWorksOpen !== 'undefined' && actorWorksOpen\) \{\s*if \(key === 'Escape' \|\| key === 'Backspace'\) handleBack\(\);/);
  assert.match(actorBlock, /openActorWorks\(actorWorksItem, true\)/);
  assert.match(actorBlock, /\/api\/v1\/actors\/works\?actor_id=/);
  assert.match(actorBlock, /actorWorksReturnFocus = arguments\.length > 2 && arguments\[2\] \? arguments\[2\] : document\.activeElement/);
  assert.match(actorBlock, /goFocus\(target\)/);
  assert.match(actorBlock, /if \(!restoreSearchSuggestionFocus\(\)\) goFocus\(target\)/);
  assert.match(source, /\['#actor-works-modal', function \(\) \{ return typeof actorWorksOpen !== 'undefined' && actorWorksOpen; \}\]/);
  assert.match(focusBlock, /var root = activeModalRoot\(\);[\s\S]*if \(root\) \{ if \(!element\.closest\(root\)\) return; \}/);
  assert.match(modalMove, /if \(zone === 'actorWorks'\)/);
  assert.match(source, /rank-row-play, \.rank-row-detail, \.rank-row-actor/);
});
