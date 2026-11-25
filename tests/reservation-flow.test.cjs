const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./helpers/app-text.cjs');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
test('reservation separates an accepted write from cloud list confirmation', () => {
  assert.equal(source.includes('hongguo-tv-reservation-mode'), false);
  assert.match(source, /function writeReservation\(item, reserved, signal\)/);
  assert.match(source, /if \(!result\.accepted\) throw new Error/);
  assert.match(source, /function reservationPendingMessage\(\)/);
  assert.equal((source.match(/if \(!result\.confirmed\)/g) || []).length, 3);
  assert.match(source, /uiText\('ui\.reservationPending'/);
  assert.match(source, /showNotice\(uiText\('content\.reserved'/);
  assert.match(source, /uiText\('content\.nextSeasonReserved'/);
  assert.match(source, /seriesMessage\(reserved \? uiText\('ui\.reservationSuccess'/);
});

test('an accepted but unconfirmed reservation remains pending', async () => {
  const context = vm.createContext({
    Promise,
    fetchData: async () => ({ accepted: true, confirmed: false }),
    uiText: (_, fallback) => fallback
  });
  let calls = 0;
  context.fetchData = async () => { calls++; return { accepted: true, confirmed: false }; };
  const start = source.indexOf('  function writeReservation(');
  const end = source.indexOf('  function applyReservationOverride(', start);
  require('./helpers/app-text.cjs').installContentText(context);
  vm.runInContext(source.slice(start, end), context);
  const result = await context.writeReservation({ reservation_id: 'season-2' }, true);
  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, false);
  assert.equal(calls, 1, 'an accepted write must not trigger a list readback loop');
  assert.match(context.reservationPendingMessage(), /尚未确认/);
});

test('reservation confirmation bridges eventual consistency without becoming permanent', () => {
  const context = vm.createContext({
    Date,
    Object,
    Array,
    reservationOverrides: Object.create(null),
    reservationOverrideTTL: 300000,
    reservationCounts: { online: null, upcoming: 8 },
    document: { querySelectorAll() { return []; } }
  });
  const start = source.indexOf('  function rememberReservationOverride(');
  const end = source.indexOf('  function genderParam(', start);
  require('./helpers/app-text.cjs').installContentText(context);
  vm.runInContext(source.slice(start, end), context);
  const item = { reservation_id: 'season-2', series_id: 'series-2', title: '待上线剧', upcoming: true };
  context.rememberReservationOverride(item, true);
  assert.equal(context.applyReservationOverride({ reservation_id: 'season-2', reserved: false }).reserved, true);
  assert.deepEqual(context.prepareReservationItems([], false, null)[0].title, '待上线剧');
  context.updateReservationCounts({ offline_total_count: 7 });
  assert.equal(context.reservationCounts.upcoming, 8);
  context.reservationCounts.upcoming = null;
  context.reservationOverrides['season-2'].seen = false;
  context.updateReservationCounts({ offline_total_count: 7 });
  assert.equal(context.reservationCounts.upcoming, 8);
  context.reservationOverrides['season-2'].expires = Date.now() - 1;
  assert.equal(context.prepareReservationItems([], false, null).length, 0);
});

function reservationConfirmationFixture({ fail = false } = {}) {
  const calls = [];
  let remembered = 0;
  const nodes = {};
  function node(id) {
    return nodes[id] || (nodes[id] = {
      id,
      textContent: '',
      disabled: false,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}
    });
  }
  const playback = { item: { series_id: 'series-1' } };
  const item = { reservation_id: 'season-2', season_index: 2, label: '第2季', title: '测试剧' };
  const context = vm.createContext({
    Promise,
    document: { activeElement: node('confirm-cancel'), getElementById: node },
    confirmOpen: false,
    confirmationGeneration: 0,
    confirmReturnFocus: null,
    confirmOperation: null,
    accountEpoch: 7,
    activePlayback: playback,
    accountData: { logged_in: true },
    reservationPager: { loaded: true },
    calendarPager: { loaded: true },
    reservationCounts: { upcoming: 0 },
    canContinuePlayback: () => true,
    isPlaybackPage: () => true,
    updateReservationCounts() {},
    updateSeasonReservation() {},
    updateSeriesRows() {},
    rememberReservationOverride() { remembered++; },
    applyReservationOverride(item) { return item; },
    showNotice(message) { calls.push(['notice', message]); },
    reservationPendingMessage: () => '预约请求已提交，尚未确认',
    goFocus() {},
    writeReservation: async (target, reserved) => {
      calls.push(['request', '/api/v1/reservation', { item_id: target.reservation_id, reserved }]);
      if (fail) throw new Error('测试预约失败');
      return { accepted: true, confirmed: false };
    }
  });
  const start = source.indexOf('  function offerNextSeasonReservation(');
  const end = source.indexOf('  function refreshDetailAfterSeason(', start);
  require('./helpers/app-text.cjs').installContentText(context);
  vm.runInContext(source.slice(start, end), context);
  context.offerNextSeasonReservation(playback, item, 7);
  return { context, calls, item, playback, copy: node('confirm-copy'), remembered: () => remembered };
}

test('an accepted next-season request stays pending until the cloud list shows it', async () => {
  const f = reservationConfirmationFixture();
  assert.equal(await f.context.confirmOperation(), true);
  assert.deepEqual(f.calls[0], ['request', '/api/v1/reservation', { item_id: 'season-2', reserved: true }]);
  assert.equal(f.item.reserved, undefined);
  assert.equal(f.remembered(), 0);
  assert.deepEqual(f.calls.slice(1), [['notice', '预约请求已提交，尚未确认']]);
});

test('an already reserved next season reports the state without opening a second prompt', () => {
  const f = reservationConfirmationFixture();
  f.context.confirmOpen = false;
  f.context.confirmOperation = null;
  f.item.reserved = true;
  f.context.offerNextSeasonReservation(f.playback, f.item, 7);
  assert.deepEqual(f.calls, [['notice', '您已预约第2季，敬请期待']]);
  assert.equal(f.context.confirmOperation, null);
});

test('a failed reservation keeps the season unreserved and leaves a retryable error', async () => {
  const f = reservationConfirmationFixture({ fail: true });
  assert.equal(await f.context.confirmOperation(), false);
  assert.equal(f.item.reserved, undefined);
  assert.match(f.copy.textContent, /预约未确认成功：测试预约失败/);
  assert.equal(f.calls.length, 1);
});

test('a stale playback context cannot close the reservation prompt as a false success', async () => {
  const f = reservationConfirmationFixture();
  f.context.activePlayback = null;
  assert.equal(await f.context.confirmOperation(), false);
  assert.match(f.copy.textContent, /播放状态已变化/);
  assert.equal(f.calls.length, 0);
});
