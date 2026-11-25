const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./helpers/app-text.cjs');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const render = source.slice(source.indexOf('  function renderDetailSocial('), source.indexOf('  function loadSeriesSeasons('));

function fixture(related) {
  function element(tag) {
    return {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      attributes: {},
      className: '',
      textContent: '',
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(type, handler) { this.handlers = this.handlers || {}; this.handlers[type] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      classList: { add() {}, remove() {}, contains() { return false; } }
    };
  }
  const list = element('div');
  Object.defineProperty(list, 'innerHTML', { set() { list.children = []; } });
  const tab = element('button'); tab.id = 'detail-tab-related';
  const message = element('div');
  const document = {
    createElement: element,
    getElementById(id) { return id === 'detail-related-list' ? list : id === 'detail-related-message' ? message : tab; }
  };
  const c = vm.createContext({
    document,
    currentDetail: { related },
    detailTab: 'related',
    setCover(image, item) { image.cover = item.cover; },
    dramaPoster(image) { const poster = element('span'); poster.appendChild(image); return poster; },
    firstVisible(selector) { return selector === '.related-card' ? list.children[0] || null : null; },
    goFocus(node) { c.focused = node; }
  });
  require('./helpers/app-text.cjs').installContentText(c);
  vm.runInContext(render, c);
  return { c, list, message, tab };
}

test('series detail recommendations render as selectable poster cards', () => {
  const related = [
    { series_id: '1001', title: '推荐短剧一', cover: 'https://example.test/one.jpg', episode_count: 12 },
    { series_id: '1002', title: '推荐短剧二', cover: 'https://example.test/two.jpg', episode_count: 24 }
  ];
  const f = fixture(related);

  f.c.renderDetailSocial('related');

  assert.equal(f.list.children.length, 2);
  assert.equal(f.list.children[0].className, 'related-card');
  assert.equal(f.list.children[0].children[1].textContent, '推荐短剧一');
  assert.equal(f.list.children[0].children[0].children[0].cover, 'https://example.test/one.jpg');
  assert.equal(typeof f.list.children[0].handlers.click, 'function');
  assert.equal(f.message.textContent, '');
  assert.equal(f.c.focused, f.list.children[0]);
});

test('empty recommendation response explains the empty state instead of leaving a blank panel', () => {
  const f = fixture([]);

  f.c.renderDetailSocial('related');

  assert.equal(f.list.children.length, 0);
  assert.equal(f.message.textContent, '暂无相关推荐。');
  assert.equal(f.c.focused, f.tab);
});

test('detail actor strip limits the first row and exposes the remaining cast in a separate list', () => {
  const actorStart = source.indexOf('  function actorButton(');
  const actorEnd = source.indexOf('  function renderActorWorks(', actorStart);
  const actorSource = source.slice(actorStart, actorEnd);
  const nodes = {};
  function element(tag) {
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, disabled: false,
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(type, handler) { this.handlers = this.handlers || {}; this.handlers[type] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      classList: {
        add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); }
      }
    };
  }
  ['detail-cast', 'detail-cast-strip', 'detail-cast-more', 'detail-cast-all'].forEach(id => { nodes[id] = element('div'); });
  nodes['detail-cast-more'].classList.add('is-hidden');
  Object.defineProperty(nodes['detail-cast-strip'], 'innerHTML', { set() { this.children = []; } });
  Object.defineProperty(nodes['detail-cast-all'], 'innerHTML', { set() { this.children = []; } });
  const context = vm.createContext({
    document: { createElement: element, getElementById(id) { return nodes[id]; } },
    openActorWorks(item) { context.openedActor = item; }
  });
  vm.runInContext(actorSource, context);

  const actors = Array.from({ length: 7 }, (_, index) => ({ id: String(100 + index), name: '演员' + index }));
  context.renderDetailActors(actors);

  assert.equal(nodes['detail-cast-strip'].children.length, 5);
  assert.equal(nodes['detail-cast-all'].children.length, 7);
  assert.equal(nodes['detail-cast-more'].textContent, '全部 7 位');
  assert.equal(nodes['detail-cast-more'].classList.contains('is-hidden'), false);
  nodes['detail-cast-strip'].children[0].handlers.click();
  assert.equal(context.openedActor.actor_id, '100');
  assert.equal(context.openedActor.title, '演员0');

  context.renderDetailActors([]);
  assert.equal(nodes['detail-cast'].classList.contains('is-hidden'), true);
  assert.equal(nodes['detail-cast-strip'].children.length, 0);
});

test('actor modal focus keeps its ring inside the nested scrollport on old WebViews', () => {
  const actorStart = source.indexOf('  function keepDetailCastFocusVisible(');
  const actorEnd = source.indexOf('  function renderActorWorks(', actorStart);
  const actorSource = source.slice(actorStart, actorEnd);
  const css = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'), 'utf8');

  assert.match(actorSource, /function keepDetailCastFocusVisible\(button\)/);
  assert.match(actorSource, /var inset = 6/);
  assert.match(actorSource, /rect\.top < top/);
  assert.match(actorSource, /rect\.bottom > bottom/);
  assert.match(actorSource, /scrollHeight[\s\S]*clientHeight/);
  assert.match(actorSource, /className === 'detail-cast-modal-item'[\s\S]*?addEventListener\('focus'/);
  assert.match(actorSource, /keepDetailCastFocusVisible\(button\)/);
  assert.match(css, /.detail-cast-all\s*\{[^}]*overflow-y:\s*auto;[^}]*padding:\s*8px 5px/);
});

test('actor works dialog is a top-level overlay above the detail dialog', () => {
  const indexSource = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');
  const sectionTags = /<section\b[^>]*>|<\/section>/g;
  const ancestors = [];
  let match;
  while ((match = sectionTags.exec(indexSource))) {
    const tag = match[0];
    if (tag.startsWith('</')) ancestors.pop();
    else if (tag.includes('class="actor-works-modal')) {
      assert.equal(ancestors.some(parent => parent.includes('class="detail-modal')), false);
      break;
    } else ancestors.push(tag);
  }
  assert.match(fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'), 'utf8'), /\.actor-works-modal\s*\{[^}]*z-index:\s*31/);
  assert.match(source, /function closeActorWorks\(restore\)[\s\S]*?actorWorksReturnFocus && document\.contains\(actorWorksReturnFocus\)[\s\S]*?if \(restore !== false\) \{\s*if \(!restoreSearchSuggestionFocus\(\)\) goFocus\(target\)/);
});
