const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { uiText } = require('./helpers/app-text.cjs');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const slice = (start, end) => source.slice(source.indexOf('  function ' + start + '('), source.indexOf('  function ' + end + '('));

function actionButton() {
  const classes = new Set();
  const label = { textContent: '' };
  const attributes = {};
  return {
    attributes,
    label,
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    querySelector() { return label; },
    setAttribute(name, value) { attributes[name] = value; }
  };
}

test('detail favorite and follow buttons reflect current saved state', () => {
  const favorite = actionButton();
  const follow = actionButton();
  const entry = { favorite_at: 123 };
  const c = vm.createContext({
    currentDetail: { series_id: '42', followed: true, following_update: true, series_status: '0' },
    libraryEntry: () => entry,
    followIsActive(item) { return !!(item.followed || item.following_update); },
    followState() { return 'ongoing'; },
    document: { getElementById(id) { return id === 'detail-favorite' ? favorite : follow; } },
    uiText
  });
  vm.runInContext(slice('updateDetailActions', 'actorButton'), c);

  c.updateDetailActions();
  assert.equal(favorite.attributes['aria-pressed'], 'true');
  assert.equal(favorite.label.textContent, '已收藏');
  assert.equal(follow.attributes['aria-pressed'], 'true');
  assert.equal(follow.label.textContent, '已追更');

  entry.favorite_at = 0;
  c.currentDetail.followed = false;
  c.currentDetail.following_update = false;
  c.updateDetailActions();
  assert.equal(favorite.attributes['aria-pressed'], 'false');
  assert.equal(favorite.label.textContent, '收藏');
  assert.equal(follow.attributes['aria-pressed'], 'false');
  assert.equal(follow.label.textContent, '追更');
});

test('saving a favorite refreshes the open detail dialog after the library write succeeds', async () => {
  let detailRefreshes = 0;
  const c = vm.createContext({
    accountEpoch: 1,
    libraryData: { owner_id: 'local', entries: [] },
    libraryReady: Promise.resolve(),
    libraryQueue: Promise.resolve(),
    detailModalOpen: true,
    currentDetail: { series_id: '42' },
    fetch: async (_url, options) => {
      const change = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ ok: true, data: { owner_id: 'local', entries: [{ drama: change.drama, favorite_at: 123 }] } })
      };
    },
    apiError(_payload, _status, _key, fallback) { return fallback; },
    updateSavedButtons() {},
    updateDetailActions() { detailRefreshes++; },
    updateDetailProgress() {},
    isLibraryPage() { return false; },
    showNotice() {},
    uiText
  });
  vm.runInContext(slice('restoreWatchingReturn', 'showRecommendationPlaceholder') + slice('changeLibrary', 'toggleSaved'), c);

  assert.equal(await c.changeLibrary({ action: 'favorite', drama: { series_id: '42' }, value: true }, true), true);
  assert.equal(detailRefreshes, 1);
});

test('successful follow changes update the open detail model and rerender its actions', async () => {
  const item = { series_id: '42' };
  const currentDetail = { series_id: '42', followed: false, following_update: false };
  const attrs = { 'aria-pressed': 'false' };
  const button = {
    disabled: false,
    getAttribute(name) { return attrs[name]; },
    setAttribute(name, value) { attrs[name] = value; },
    removeAttribute(name) { delete attrs[name]; }
  };
  let detailRefreshes = 0;
  const c = vm.createContext({
    accountData: { logged_in: true },
    featuredItem: item,
    currentDetail,
    followState() { return 'ongoing'; },
    fetchData: async () => ({}),
    updateSavedButtons() {},
    updateDetailActions() { detailRefreshes++; },
    followPager: { loaded: true, reset() {} },
    pageMode() { return 'recommend'; },
    showNotice() {},
    uiText,
    localizedError(error) { return error.message; }
  });
  vm.runInContext(slice('toggleFollow', 'libraryFinished'), c);

  c.toggleFollow(item, button);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(currentDetail.followed, true);
  assert.equal(currentDetail.following_update, true);
  assert.equal(detailRefreshes, 1);
  assert.equal(button.disabled, false);
  assert.equal(attrs['aria-busy'], undefined);
});
