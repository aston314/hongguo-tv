const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const slice = (a, b) => source.slice(source.indexOf('  function ' + a + '('), source.indexOf('  function ' + b + '('));

function fixture(mode = 'recommend', zone = 'channels') {
  const channel = { id: 'channel-real' }, feed = { id: 'hero-feed-focus' }, input = { id: 'search-input' };
  const state = { mode, zone, hidden: false, clear: [], timers: [], paused: false, ended: false };
  const c = vm.createContext({ state, channel, feed, input,
    document: { activeElement: feed, querySelector: () => feed, getElementById: () => state },
    clearTimeout: id => state.clear.push(id), setTimeout: (callback, delay) => { state.timers.push({ callback, delay }); return 2; },
    shell: { classList: { contains: () => state.hidden } },
    lastPageFocus: { recommend: feed, search: input }, searchInput: input,
    detailModalOpen: false, confirmOpen: false, playerOptionsOpen: false, discussionOpen: false,
    controlsTimer: 1,
    pageMode: () => state.mode, isPlaybackPage: () => ['recommend', 'player'].includes(state.mode),
    zoneOf: () => state.zone, activeChannel: () => channel, isFocusTarget: element => [feed, input].includes(element),
    hideControls: () => { state.hidden = true; }
  });
  vm.runInContext(slice('firstContentFocus', 'activeSidebar') + slice('scheduleControlsHide', 'revealControls'), c);
  return { c, state, channel, feed, input };
}

test('returning to restored recommendation enters the active channel even when video focus is remembered and visible', () => {
  const f = fixture();
  assert.equal(f.c.firstContentFocus(), f.channel);
  assert.equal(f.c.lastPageFocus.recommend, f.feed);
});
test('a recommendation channel other than the default receives focus without changing the selected channel', () => {
  const f = fixture(); f.channel.id = 'channel-comic';
  assert.equal(f.c.firstContentFocus().id, 'channel-comic');
});
test('the single-drama player continues entering the video rather than the hidden channel bar', () => {
  const f = fixture('player'); assert.equal(f.c.firstContentFocus(), f.feed);
});
test('other navigation pages still restore their remembered content focus', () => {
  const f = fixture('search'); assert.equal(f.c.firstContentFocus(), f.input);
});
test('focusing the channel bar cancels a previously armed clear-screen timer and does not arm another', () => {
  const f = fixture(); f.c.scheduleControlsHide();
  assert.deepEqual(f.state.clear, [1]); assert.equal(f.state.timers.length, 0);
});
test('ongoing playing events cannot start automatic clear-screen while the channel bar is being operated', () => {
  const f = fixture(); for (let i = 0; i < 4; i++) f.c.scheduleControlsHide();
  assert.equal(f.state.timers.length, 0);
});
test('entering the video resumes the existing four-second clear-screen timer', () => {
  const f = fixture('recommend', 'feed'); f.c.scheduleControlsHide();
  assert.equal(f.state.timers.length, 1); assert.equal(f.state.timers[0].delay, 4000);
  f.state.timers[0].callback(); assert.equal(f.state.hidden, true);
});
test('sidebar, paused video and open panels retain their existing protection against automatic clear-screen', () => {
  const sidebar = fixture('recommend', 'sidebar'); sidebar.c.scheduleControlsHide(); assert.equal(sidebar.state.timers.length, 0);
  const paused = fixture('recommend', 'feed'); paused.state.paused = true; paused.c.scheduleControlsHide(); assert.equal(paused.state.timers.length, 0);
  const modal = fixture('recommend', 'feed'); modal.c.playerOptionsOpen = true; modal.c.scheduleControlsHide(); assert.equal(modal.state.timers.length, 0);
});
