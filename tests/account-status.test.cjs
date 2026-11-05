const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const start = source.indexOf('  function acceptAccountStatus(');
const end = source.indexOf('\n  function renderAccount(', start);

function fixture() {
  const heroClasses = new Set(['is-preparing-video']);
  let pauseCount = 0;
  let cancelCount = 0;
  let status = '';
  const hero = { classList: { contains: name => heroClasses.has(name) } };
  const video = { pause() { pauseCount++; } };
  const context = vm.createContext({
    accountData: null,
    accountEpoch: 0,
    accountCountdownUntil: 0,
    accountPollBusy: false,
    accountBusy: false,
    accountRequestGeneration: 0,
    accountStatusInitialized: false,
    accountNotice: '',
    accountNoticeIsError: false,
    libraryData: { entries: [], owner_id: '' },
    libraryLoaded: true,
    libraryQueue: Promise.resolve(),
    libraryReady: Promise.resolve(),
    activePlayback: null,
    playbackInfoRequest: null,
    playbackPrefetchHandoff: null,
    smsVerification: null,
    engagement: { resetAccount() {} },
    episodePrefetch: { cancel() {} },
    allPagers: [],
    notificationPopupQueue: [],
    reservationOverrides: {},
    reservationCounts: {},
    discussionDrafts: {},
    danmakuDrafts: {},
    heroClasses,
    notificationKnownKey: '',
    notificationLastCheck: 0,
    notificationGeneration: 0,
    followNotificationItems: [],
    followNotificationUnread: 0,
    followView: 'follow',
    recommendationSession: null,
    notificationHidePopup() {},
    renderNotificationBadge() {},
    notificationPopupQueue: [],
    reservationOverrides: {},
    calendarSchema: null,
    historyFilter: 'all',
    detailModalOpen: false,
    confirmOpen: false,
    document: { getElementById(id) { return id === 'hero' ? hero : video; } },
    pageMode: () => 'player',
    updateFollowNotificationAccess() {},
    setAccountPhoneCountry() {},
    resetEndRecommendations() {},
    cancelPlaybackPreparation() { cancelCount++; context.playbackInfoRequest = null; },
    setPlayerStatus(value) { status = value; },
    resetSeasonCatalog() {},
    updateReservationCounts() {},
    resetSeriesPanel() {},
    closePlayerOptions() {},
    closeDiscussion() {},
    resetDanmaku() {},
    loadLibrary: () => Promise.resolve(),
    updateSavedButtons() {},
    updateDetailProgress() {},
    renderAccount() {},
    startPendingAccountHomeProgram() { context.pendingStartedAfterAccountInit = context.accountStatusInitialized; },
    pendingAccountHomeProgram: { series_id: 'series' },
    uiText: (_key, fallback) => fallback
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    context,
    snapshot: () => ({ pauseCount, cancelCount, status, epoch: context.accountEpoch })
  };
}

test('first account response initializes owner-scoped library state before releasing the pending Channel launch', () => {
  const f = fixture();
  f.context.acceptAccountStatus({ logged_in: true, profile: { uid: 'account-a' } });

  assert.equal(f.context.accountStatusInitialized, true);
  assert.deepEqual(f.snapshot(), { pauseCount: 0, cancelCount: 1, status: '', epoch: 1 });
  assert.equal(f.context.libraryData.owner_id, 'account-a');
  assert.equal(f.context.libraryLoaded, false);
  assert.equal(f.context.pendingStartedAfterAccountInit, true);
});

test('a later account identity change still cancels playback prepared for the old account', () => {
  const f = fixture();
  f.context.accountStatusInitialized = true;
  f.context.accountData = { logged_in: true, profile: { uid: 'account-a' } };
  f.context.libraryData = { entries: [], owner_id: 'account-a' };
  f.context.playbackInfoRequest = { abort() {} };
  f.context.acceptAccountStatus({ logged_in: true, profile: { uid: 'account-b' } });

  const result = f.snapshot();
  assert.equal(result.pauseCount, 1);
  assert.equal(result.cancelCount, 1);
  assert.match(result.status, /账号已切换/);
  assert.equal(result.epoch, 1);
});
