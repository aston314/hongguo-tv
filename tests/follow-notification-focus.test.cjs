const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');
function slice(from, to) {
  return source.slice(source.indexOf('  function ' + from + '('), source.indexOf('  function ' + to + '('));
}

function fixture(count = 3) {
  const nodes = [];
  function node(id, classes, parent, x = 300, y = 60) {
    const names = new Set(classes.split(' ').filter(Boolean));
    const n = { id, parent, dataset: {}, listeners: {},
      classList: {
        contains: name => names.has(name), add: name => names.add(name), remove: name => names.delete(name)
      },
      closest(selector) { return matches(this, selector) ? this : this.parent ? this.parent.closest(selector) : null; },
      getBoundingClientRect: () => ({ left: x, top: y, right: x + 100, bottom: y + 40, width: 100, height: 40 }),
      addEventListener(name, fn) { this.listeners[name] = fn; }
    };
    nodes.push(n); return n;
  }
  function matches(n, selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      return part[0] === '#' ? n.id === part.slice(1) : part[0] === '.' && part.slice(1).split('.').every(name => n.classList.contains(name));
    });
  }
  function visible(n) { return !n.classList.contains('is-hidden') && (!n.parent || visible(n.parent)); }
  const root = node('follow-page', ''), actions = node('follow-actions', '', root), list = node('follow-list-view', '', root);
  const view = node('follow-notification-view', 'is-hidden', root);
  function button(id, parent, x, y) {
    const tag = html.match(new RegExp('<button[^>]*\\bid="' + id + '"[^>]*>'))[0];
    return node(id, tag.match(/\bclass="([^"]+)"/)[1], parent, x, y);
  }
  const follow = node('follow-tab-follow', 'follow-tab is-active', root), reservations = node('follow-tab-reservations', 'follow-tab', root, 460);
  const open = button('follow-notifications-open', actions), refresh = button('follow-refresh', actions);
  const back = button('follow-notifications-back', view), readAll = button('follow-notifications-read-all', view);
  const card = node('follow-card', 'follow-card', list);
  const reservation = node('reservation', 'reservation-tab is-active', node('reservations-view', 'is-hidden', root));
  const plays = [], details = [];
  for (let i = 0; i < count; i++) {
    const row = node('row-' + i, 'follow-notification-row', view, 300, 200 + i * 190);
    plays.push(node('play-' + i, 'follow-notification-play', row, 300, 200 + i * 190));
    details.push(node('detail-' + i, 'follow-notification-detail', row, 900, 200 + i * 190));
  }
  const sidebar = node('sidebar', 'side-item');
  const context = vm.createContext({
    coreConnectionModalOpen: false, scanModalOpen: () => false, accountCountryModalOpen: false,
    supportModalOpen: false, confirmOpen: false, playbackCommandMenuOpen: false, rankFilterOpen: false,
    actorWorksOpen: false, playerOptionsOpen: false, detailModalOpen: false, discussionOpen: false,
    followNotificationViewOpen: false, followView: 'follow', followNotificationReturnFocus: null,
    followPage: root, followActions: actions, followListView: list, followNotificationView: view,
    followNotificationList: { scrollTop: 100, getBoundingClientRect: () => ({ top: 200, bottom: 600 }) },
    followPager: {}, reservationMode: 'online',
    document: { activeElement: open, contains: n => nodes.includes(n), getElementById: id => nodes.find(n => n.id === id) },
    firstVisible: selector => nodes.find(n => visible(n) && matches(n, selector)) || null,
    focusables: selector => nodes.filter(n => visible(n) && matches(n, selector)),
    zoneSelectors: { followTabs: '.follow-tab', followActions: '.follow-action', followNotifications: '.follow-notification-action' },
    activeSidebar: () => sidebar, renderFollowNotifications() {}, notificationCheck() {},
    goFocus(n) { context.document.activeElement = n; }, listBoundary: () => null
  });
  vm.runInContext(slice('zoneOf', 'goFocus') + slice('moveWithinZone', 'accountKeypadOpen') +
    slice('keepNotificationActionVisible', 'acceptNotificationData') + slice('openFollowNotifications', 'markNotificationRead'), context);
  return { c: context, follow, reservations, open, refresh, back, readAll, card, reservation, plays, details, sidebar, node };
}

test('follow header controls use their own navigation even with shared library toolbar styles', () => {
  const f = fixture();
  for (const n of [f.open, f.refresh]) assert.equal(f.c.zoneOf(n), 'followActions');
  for (const n of [f.back, f.readAll]) assert.equal(f.c.zoneOf(n), 'followNotifications');
  assert.equal(f.c.zoneOf(f.node('ordinary-toolbar', 'library-toolbar-button')), 'libraryActions');
});

test('opening reminders connects follow tabs, reminder header and first row in both directions', () => {
  const f = fixture();
  f.c.openFollowNotifications();
  assert.equal(f.c.followPage.classList.contains('has-notifications'), true);
  assert.equal(f.c.document.activeElement, f.plays[0]);
  assert.equal(f.c.moveFrom(f.plays[0], 'up'), f.back);
  assert.equal(f.c.moveFrom(f.back, 'up'), f.follow);
  assert.equal(f.c.moveFrom(f.follow, 'down'), f.back);
  assert.equal(f.c.moveFrom(f.back, 'down'), f.plays[0]);
  assert.equal(f.c.moveFrom(f.reservations, 'right'), f.back);
});

test('reminder row navigation preserves play/detail columns and their header return paths', () => {
  const f = fixture(); f.c.openFollowNotifications();
  assert.equal(f.c.moveFrom(f.back, 'right'), f.readAll);
  assert.equal(f.c.moveFrom(f.readAll, 'left'), f.back);
  assert.equal(f.c.moveFrom(f.readAll, 'down'), f.details[0]);
  assert.equal(f.c.moveFrom(f.details[0], 'up'), f.readAll);
  for (let i = 0; i < f.plays.length; i++) {
    assert.equal(f.c.moveFrom(f.plays[i], 'right'), f.details[i]);
    assert.equal(f.c.moveFrom(f.details[i], 'left'), f.plays[i]);
    if (i) {
      assert.equal(f.c.moveFrom(f.plays[i], 'up'), f.plays[i - 1]);
      assert.equal(f.c.moveFrom(f.details[i], 'up'), f.details[i - 1]);
    }
    assert.equal(f.c.moveFrom(f.plays[i], 'down'), f.plays[i + 1] || f.plays[i]);
    assert.equal(f.c.moveFrom(f.details[i], 'down'), f.details[i + 1] || f.details[i]);
  }
  assert.equal(f.c.moveFrom(f.plays[0], 'left'), f.sidebar);
});

test('empty reminders keep both header actions reachable without jumping to hidden follow controls', () => {
  const f = fixture(0); f.c.openFollowNotifications();
  assert.equal(f.c.document.activeElement, f.back);
  assert.equal(f.c.moveFrom(f.back, 'down'), f.back);
  assert.equal(f.c.moveFrom(f.readAll, 'down'), f.readAll);
  assert.equal(f.c.moveFrom(f.readAll, 'up'), f.follow);
  assert.equal(f.c.moveFrom(f.follow, 'down'), f.back);
});

test('closing reminders restores the follow toolbar and leaves reservation navigation intact', () => {
  const f = fixture(); f.c.openFollowNotifications(); f.c.closeFollowNotifications();
  assert.equal(f.c.followPage.classList.contains('has-notifications'), false);
  assert.equal(f.c.document.activeElement, f.open);
  assert.equal(f.c.moveFrom(f.follow, 'down'), f.open);
  assert.equal(f.c.moveFrom(f.open, 'up'), f.follow);
  assert.equal(f.c.moveFrom(f.open, 'down'), f.card);
  f.c.followView = 'reservations'; f.reservation.parent.classList.remove('is-hidden');
  assert.equal(f.c.moveFrom(f.follow, 'down'), f.reservation);
});

test('focusing a row leaves room for the complete outer ring at both scroll edges', () => {
  const f = fixture();
  const row = f.plays[0].parent;
  f.c.keepNotificationActionVisible(f.plays[0]);
  row.getBoundingClientRect = () => ({ top: 200, bottom: 376 });
  f.plays[0].listeners.focus(); assert.equal(f.c.followNotificationList.scrollTop, 96);
  row.getBoundingClientRect = () => ({ top: 424, bottom: 600 });
  f.plays[0].listeners.focus(); assert.equal(f.c.followNotificationList.scrollTop, 100);
  row.getBoundingClientRect = () => ({ top: 204, bottom: 596 });
  f.plays[0].listeners.focus(); assert.equal(f.c.followNotificationList.scrollTop, 100);
});
