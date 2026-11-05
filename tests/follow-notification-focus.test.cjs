const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');
const appCss = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'), 'utf8');
const compatCss = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/compat.css'), 'utf8');
function slice(from, to) {
  return source.slice(source.indexOf('  function ' + from + '('), source.indexOf('  function ' + to + '('));
}

function fixture(count = 3, options = {}) {
  const nodes = [];
  const loggedIn = options.loggedIn !== false;
  const unread = options.unread === undefined ? (count ? 1 : 0) : options.unread;
  function node(id, classes = '', parent = null, x = 300, y = 60, tagName = 'div') {
    const names = new Set(classes.split(' ').filter(Boolean));
    const n = { id, parent, children: [], dataset: {}, listeners: {}, attributes: {}, disabled: false, tagName: tagName.toUpperCase(), textContent: '', innerHTML: '',
      classList: {
        contains: name => names.has(name),
        add: name => names.add(name),
        remove: name => names.delete(name),
        toggle(name, force) { const add = force === undefined ? !names.has(name) : !!force; if (add) names.add(name); else names.delete(name); return add; }
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] || null; },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      contains(child) { return child === this || this.children.some(item => item.contains(child)); },
      closest(selector) { return matches(this, selector) ? this : this.parent ? this.parent.closest(selector) : null; },
      querySelector(selector) { return nodes.find(item => this.contains(item) && item !== this && matches(item, selector)) || null; },
      getBoundingClientRect: () => ({ left: x, top: y, right: x + 100, bottom: y + 40, width: 100, height: 40 }),
      getClientRects() { return visible(this) ? [{}] : []; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      focus() { context.document.activeElement = this; }
    };
    if (parent) parent.children.push(n);
    nodes.push(n);
    return n;
  }
  function matches(n, selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (part[0] === '#') return n.id === part.slice(1);
      if (part[0] !== '.') return false;
      return part.slice(1).split('.').every(name => n.classList.contains(name));
    });
  }
  function visible(n) {
    return !n.disabled && !n.classList.contains('is-hidden') && (!n.parent || visible(n.parent));
  }

  const root = node('follow-page');
  const heading = node('follow-heading', '', root);
  const tabs = node('follow-tabs', '', heading);
  const notificationsTab = node('follow-tab-notifications', 'follow-tab', tabs, 300, 60, 'button');
  notificationsTab.dataset.followView = 'notifications'; notificationsTab.dataset.focus = notificationsTab.id;
  const follow = node('follow-tab-follow', 'follow-tab is-active', tabs, 450, 60, 'button');
  follow.dataset.followView = 'follow'; follow.dataset.focus = follow.id;
  const reservations = node('follow-tab-reservations', 'follow-tab', tabs, 600, 60, 'button');
  reservations.dataset.followView = 'reservations'; reservations.dataset.focus = reservations.id;
  const actions = node('follow-actions', '', heading);
  const refresh = node('follow-refresh', 'follow-action', actions, 740, 60, 'button');
  const list = node('follow-list-view', '', root);
  const grid = node('follow-grid', '', list);
  const card = node('follow-card', 'follow-card', grid, 300, 200);
  const view = node('follow-notification-view', 'follow-notification-view is-hidden', root);
  const readAll = node('follow-notifications-read-all', 'follow-notification-action', view, 700, 110, 'button');
  readAll.dataset.focus = readAll.id;
  readAll.disabled = !loggedIn || unread < 1;
  const notificationList = node('follow-notification-list', '', view);
  const reservationsView = node('reservations-view', 'reservations-view is-hidden', root);
  const reservation = node('reservation-online', 'reservation-tab is-active', reservationsView, 300, 120, 'button');
  const sidebar = node('sidebar-follows', 'side-item', null, 0, 60, 'button');
  const sidebarBadge = node('follow-sidebar-badge', 'side-notification-dot is-hidden', sidebar, 45, 52, 'span');
  const plays = [], details = [];
  for (let i = 0; i < count; i++) {
    const row = node('row-' + i, 'follow-notification-row', notificationList, 300, 200 + i * 190);
    plays.push(node('play-' + i, 'follow-notification-play', row, 300, 200 + i * 190, 'button'));
    details.push(node('detail-' + i, 'follow-notification-detail', row, 900, 200 + i * 190, 'button'));
  }

  const context = vm.createContext({
    coreConnectionModalOpen: false, scanModalOpen: () => false, accountCountryModalOpen: false,
    supportModalOpen: false, confirmOpen: false, playbackCommandMenuOpen: false, rankFilterOpen: false,
    actorWorksOpen: false, playerOptionsOpen: false, detailModalOpen: false, discussionOpen: false,
    followView: 'follow', followPage: root, followActions: actions, followListView: list,
    followNotificationView: view, followNotificationList: notificationList, followNotificationItems: [],
    followNotificationUnread: unread, followGrid: grid, followPager: { loaded: true, reset() {} },
    reservationMode: 'online', accountData: loggedIn ? { logged_in: true } : { logged_in: false },
    notificationAccountKey: () => loggedIn ? 'test-account' : '',
    document: {
      activeElement: follow,
      body: {},
      contains: n => nodes.includes(n),
      getElementById: id => nodes.find(n => n.id === id) || null,
      querySelectorAll: selector => nodes.filter(n => matches(n, selector)),
      querySelector: selector => nodes.find(n => visible(n) && matches(n, selector)) || null,
      createElement: tag => node('generated-' + nodes.length, '', null, 300, 300, tag)
    },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    firstVisible: selector => nodes.find(n => visible(n) && matches(n, selector)) || null,
    focusables: selector => nodes.filter(n => visible(n) && matches(n, selector)),
    zoneSelectors: {
      followTabs: '.follow-tab', followActions: '.follow-action',
      followNotifications: '.follow-notification-action',
      followNotificationItems: '.follow-notification-play, .follow-notification-detail',
      followItems: '.follow-card', reservationTabs: '.reservation-tab'
    },
    activeSidebar: () => sidebar,
    renderReservations() {}, queueTailCheck() {},
    notificationCheck() {}, renderMessage() {}, uiText: (key, fallback) => fallback,
    goFocus(n) { if (n && !n.disabled) context.document.activeElement = n; },
    listBoundary: () => null
  });
  vm.runInContext(slice('zoneOf', 'goFocus') + slice('moveWithinZone', 'accountKeypadOpen') +
    slice('renderNotificationBadge', 'updateFollowNotificationAccess') +
    slice('renderFollowNotifications', 'acceptNotificationData') + slice('firstFollowViewFocus', 'submitSearch'), context);
  return { c: context, root, notificationsTab, follow, reservations, refresh, actions, list, grid, view, readAll, notificationList, reservationsView, reservation, card, plays, details, sidebar, sidebarBadge, node, visible };
}

test('follow page exposes three sibling tabs and a sidebar notification indicator', () => {
  for (const [id, panel] of [['follow-tab-notifications', 'follow-notification-view'], ['follow-tab-follow', 'follow-list-view'], ['follow-tab-reservations', 'reservations-view']]) {
    const tag = html.match(new RegExp('<button[^>]*\\bid="' + id + '"[^>]*>'))?.[0];
    assert.ok(tag, `${id} has a stable DOM id`);
    assert.match(tag, new RegExp('aria-controls="' + panel + '"'));
    assert.match(html, new RegExp('aria-labelledby="' + id + '"'));
  }
  assert.doesNotMatch(html, /follow-notifications-(?:open|back)/);
  assert.match(html, /id="sidebar-follows"[^>]*>[\s\S]*?id="follow-sidebar-badge"/);
  assert.match(html, /id="sidebar-follows"[^>]*aria-label="追更"(?![^>]*data-i18n-aria-label)/);
  assert.match(appCss, /\.side-notification-dot\s*\{[^}]*margin-left:\s*auto/);
  assert.match(appCss, /\.app-shell\.sidebar-icons \.side-item > \.side-notification-dot\s*\{[^}]*position:\s*absolute/);
  assert.match(compatCss, /\.legacy-flex-gap \.side-item > \.side-notification-dot\s*\{[^}]*margin-left:\s*auto/);
  assert.match(source, /var label = item\.querySelector\('\[data-i18n\]'\);/);
});

test('the sidebar dot mirrors unread reminders, clears only when unread reaches zero, and stays hidden when logged out', () => {
  const f = fixture(3, { unread: 1 });
  f.c.renderNotificationBadge();
  assert.equal(f.sidebarBadge.classList.contains('is-hidden'), false);
  assert.equal(f.sidebar.attributes['aria-label'], '追更，有未读更新提醒');

  vm.runInContext(slice('acceptNotificationData', 'notificationCheck'), f.c);
  f.c.acceptNotificationData({ items: [], unread_count: 0 }, false);
  assert.equal(f.sidebarBadge.classList.contains('is-hidden'), true);
  assert.equal(f.sidebar.attributes['aria-label'], '追更');

  const loggedOut = fixture(0, { loggedIn: false, unread: 2 });
  loggedOut.c.renderNotificationBadge();
  assert.equal(loggedOut.sidebarBadge.classList.contains('is-hidden'), true);
});

test('all three follow tabs switch sibling panels and keep the selected tab synchronized', () => {
  const f = fixture();
  assert.equal(f.c.zoneOf(f.refresh), 'followActions');
  assert.equal(f.c.zoneOf(f.readAll), 'followNotifications');
  assert.equal(f.c.moveFrom(f.notificationsTab, 'right'), f.follow);
  assert.equal(f.c.moveFrom(f.follow, 'right'), f.reservations);
  assert.equal(f.c.moveFrom(f.reservations, 'left'), f.follow);

  f.c.switchFollowView('notifications');
  assert.equal(f.c.followView, 'notifications');
  assert.equal(f.notificationsTab.classList.contains('is-active'), true);
  assert.equal(f.follow.classList.contains('is-active'), false);
  assert.equal(f.list.classList.contains('is-hidden'), true);
  assert.equal(f.view.classList.contains('is-hidden'), false);
  assert.equal(f.view.attributes['aria-hidden'], 'false');
  assert.equal(f.c.document.activeElement, f.plays[0]);
  assert.equal(f.c.moveFrom(f.readAll, 'up'), f.notificationsTab);
  assert.equal(f.c.moveFrom(f.readAll, 'down'), f.plays[0]);

  f.c.switchFollowView('reservations');
  assert.equal(f.reservations.classList.contains('is-active'), true);
  assert.equal(f.reservationsView.classList.contains('is-hidden'), false);
  assert.equal(f.view.classList.contains('is-hidden'), true);
  assert.equal(f.c.document.activeElement, f.reservation);

  f.c.switchFollowView('follow');
  assert.equal(f.follow.classList.contains('is-active'), true);
  assert.equal(f.list.classList.contains('is-hidden'), false);
  assert.equal(f.reservationsView.classList.contains('is-hidden'), true);
});

test('notification rows retain play/detail columns and return focus to the tab or enabled header action', () => {
  const f = fixture();
  f.c.switchFollowView('notifications');
  assert.equal(f.c.moveFrom(f.plays[0], 'right'), f.details[0]);
  assert.equal(f.c.moveFrom(f.details[0], 'left'), f.plays[0]);
  assert.equal(f.c.moveFrom(f.plays[0], 'up'), f.readAll);
  for (let i = 0; i < f.plays.length; i++) {
    if (i) {
      assert.equal(f.c.moveFrom(f.plays[i], 'up'), f.plays[i - 1]);
      assert.equal(f.c.moveFrom(f.details[i], 'up'), f.details[i - 1]);
    }
    assert.equal(f.c.moveFrom(f.plays[i], 'down'), f.plays[i + 1] || f.plays[i]);
    assert.equal(f.c.moveFrom(f.details[i], 'down'), f.details[i + 1] || f.details[i]);
  }

  const empty = fixture(0, { loggedIn: true, unread: 0 });
  empty.c.switchFollowView('notifications');
  assert.equal(empty.readAll.disabled, true);
  assert.equal(empty.c.document.activeElement, empty.notificationsTab);
  assert.equal(empty.c.moveFrom(empty.plays[0] || empty.notificationsTab, 'down'), empty.notificationsTab);
  assert.equal(empty.notificationList.children[0].textContent, '暂无更新提醒');
});

test('logged-out reminders show a login hint without hiding any of the three tabs', () => {
  const f = fixture(0, { loggedIn: false, unread: 0 });
  f.c.switchFollowView('notifications');
  assert.equal(f.readAll.disabled, true);
  assert.equal(f.notificationsTab.classList.contains('is-hidden'), false);
  assert.equal(f.follow.classList.contains('is-hidden'), false);
  assert.equal(f.reservations.classList.contains('is-hidden'), false);
  assert.equal(f.notificationList.children[0].textContent, '登录红果账号后查看更新提醒。');
  assert.equal(f.c.document.activeElement, f.notificationsTab);
});

test('focusing a notification keeps the complete row outline inside the scroll viewport', () => {
  const f = fixture();
  const row = f.plays[0].parent;
  const list = { scrollTop: 100, getBoundingClientRect: () => ({ top: 200, bottom: 600 }) };
  f.c.followNotificationList = list;
  f.c.keepNotificationActionVisible(f.plays[0]);
  row.getBoundingClientRect = () => ({ top: 200, bottom: 376 });
  f.plays[0].listeners.focus(); assert.equal(list.scrollTop, 96);
  row.getBoundingClientRect = () => ({ top: 424, bottom: 600 });
  f.plays[0].listeners.focus(); assert.equal(list.scrollTop, 100);
  row.getBoundingClientRect = () => ({ top: 204, bottom: 596 });
  f.plays[0].listeners.focus(); assert.equal(list.scrollTop, 100);
});

test('a reminder response from the previous account is discarded after an account switch', async () => {
  let account = 'account-a';
  let resolveRequest;
  let accepted = 0;
  const context = vm.createContext({
    notificationGeneration: 0, notificationCheckBusy: false, notificationLastCheck: 0,
    notificationKnownKey: '', notificationPopupQueue: [], followView: 'notifications',
    applicationHidden: () => false, applicationInBackground: false,
    notificationAccountKey: () => account,
    fetchData: () => new Promise(resolve => { resolveRequest = resolve; }),
    acceptNotificationData() { accepted++; }, flushNotificationPopup() {}, showNotice() {}
  });
  vm.runInContext(slice('notificationCheck', 'isPlaybackPage'), context);
  const pending = context.notificationCheck(true);
  account = 'account-b';
  context.notificationGeneration++;
  resolveRequest({ items: [{ id: 'old-account-item' }] });
  assert.equal(await pending, false);
  assert.equal(accepted, 0);
  assert.equal(context.notificationCheckBusy, false);
});
