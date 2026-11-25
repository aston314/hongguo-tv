const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { uiText } = require('./helpers/app-text.cjs');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const start = source.indexOf('  function offerFollowAtEnd(');
const end = source.indexOf('  function cancelEndRecommendationAutoplay(', start);
const implementation = source.slice(start, end);

function fixture({ loggedIn = true, status = 'ongoing', following = false, fail = false } = {}) {
  const requests = [];
  const notices = [];
  const nodes = Object.create(null);
  function node(id) {
    return nodes[id] || (nodes[id] = {
      id, textContent: '', disabled: false, attributes: {}, classes: new Set(),
      classList: {
        add(value) { this.owner.classes.add(value); },
        remove(value) { this.owner.classes.delete(value); },
        owner: null
      },
      classNames: null,
      setAttribute(name, value) { this.attributes[name] = value; }
    });
  }
  ['confirm-title', 'confirm-copy', 'confirm-accept', 'confirm-cancel', 'confirm-modal'].forEach(id => {
    const element = node(id);
    element.classList.owner = element;
    element.classList.toggle = function (value, enabled) { enabled ? this.add(value) : this.remove(value); };
  });
  const item = { series_id: 'series-1', title: '测试短剧', series_status: status, followed: following };
  const playback = { item, owner: 4 };
  const context = vm.createContext({
    Promise, Object,
    document: { getElementById: node },
    accountData: { logged_in: loggedIn }, accountEpoch: 4, confirmationGeneration: 0,
    confirmReturnFocus: null, confirmAfterClose: null, confirmOpen: false, confirmOperation: null,
    activePlayback: playback, featuredItem: item, currentDetail: null,
    followPager: { loaded: true },
    canContinuePlayback: value => value === playback, pageMode: () => 'player', isPlaybackPage: () => true,
    followState: value => value.series_status, followIsActive: value => !!value.followed,
    fetchData: async (url, options) => { requests.push([url, JSON.parse(options.body)]); if (fail) throw new Error('network down'); return {}; },
    updateDetailActions() {}, showNotice: value => notices.push(value),
    localizedError: error => error.message, uiText, goFocus() {}
  });
  require('./helpers/app-text.cjs').installContentText(context);
  vm.runInContext(implementation, context);
  return { context, item, playback, requests, notices, nodes };
}

test('the end prompt is only offered for a logged-in ongoing drama not already followed', () => {
  for (const options of [{ loggedIn: false }, { status: 'ended' }, { following: true }]) {
    const f = fixture(options);
    assert.equal(f.context.offerFollowAtEnd(f.playback, {}), false);
    assert.equal(f.context.confirmOpen, false);
  }
  const f = fixture();
  assert.equal(f.context.offerFollowAtEnd(f.playback, { related: [] }, () => {}), true);
  assert.equal(f.context.confirmOpen, true);
  assert.equal(f.nodes['confirm-cancel'].textContent, '暂不追更');
});

test('a prompt captured under another account cannot follow the old playback in the new account', () => {
  const f = fixture();
  f.context.offerFollowAtEnd(f.playback, {});
  f.context.accountEpoch++;
  f.context.confirmOpen = false;
  f.context.confirmOperation = null;
  assert.equal(f.context.offerFollowAtEnd(f.playback, {}), false);
  assert.equal(f.requests.length, 0);
});

test('confirming follow posts to the account API and updates the active drama', async () => {
  const f = fixture();
  f.context.offerFollowAtEnd(f.playback, {});
  assert.equal(await f.context.confirmOperation(), true);
  assert.deepEqual(f.requests, [['/api/v1/follow', { series_id: 'series-1', enabled: true }]]);
  assert.equal(f.item.following_update, true);
  assert.equal(f.item.followed, true);
  assert.equal(f.context.followPager.loaded, false);
  assert.deepEqual(f.notices, ['已加入追更']);
});

test('a failed follow request keeps the prompt open with a retryable error', async () => {
  const f = fixture({ fail: true });
  f.context.offerFollowAtEnd(f.playback, {});
  assert.equal(await f.context.confirmOperation(), false);
  assert.equal(f.context.confirmOpen, true);
  assert.match(f.nodes['confirm-copy'].textContent, /追更未完成：network down/);
  assert.equal(f.item.followed, false);
});
