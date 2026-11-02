const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
function block(start, end) {
  return source.slice(source.indexOf('  function ' + start + '('), source.indexOf('  function ' + end + '('));
}

function fixture(withFrames = true) {
  const frames = new Map(), timers = new Map(), events = [];
  let next = 0;
  const context = {
    searchSuggestionActivation: null, searchSuggestionTimer: null, searchSuggestionRequest: null,
    searchSuggestionGeneration: 0, searchSuggestionReturnKey: '', searchSuggestionFocusedKey: '',
    searchSuggestionOpen: true, searchSuggestionDismissedQuery: '', accountEpoch: 1,
    applicationInBackground: false, hidden: false, mode: 'search', detailModalOpen: false,
    actorWorksOpen: false, searchScanOpen: false,
    searchInput: { value: '归路', setAttribute() {} },
    searchSuggestions: { classList: { add() { events.push('hide'); } }, setAttribute() {} },
    pageMode: () => context.mode, applicationHidden: () => context.hidden,
    openActorWorks: (...args) => events.push(['actor', ...args]),
    openDetail: (...args) => events.push(['detail', ...args]),
    goFocus: target => events.push(['focus', target]),
    submitSearch: () => events.push(['search', context.searchInput.value]),
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id)
  };
  if (withFrames) {
    context.requestAnimationFrame = fn => { frames.set(++next, fn); return next; };
    context.cancelAnimationFrame = id => frames.delete(id);
  }
  vm.createContext(context);
  vm.runInContext(block('closeSearchSuggestions', 'keepSearchSuggestionFocusVisible') +
    block('cancelSearchSuggestionActivation', 'lastSearchFilter'), context);
  function flush(queue) {
    const queued = [...queue.values()]; queue.clear(); queued.forEach(fn => fn());
  }
  return { c: context, events, frames, timers, frame: () => flush(frames), timer: () => flush(timers),
    choose: item => context.activateSearchSuggestion(item, { dataset: { suggestionKey: 'selected' } }) };
}

const drama = { name: '归路', drama: { series_id: '123' } };

test('hiding suggestions paints before the detail opens, preserving the return target and key', () => {
  const f = fixture();
  f.choose(drama);
  assert.deepEqual(f.events, ['hide']);
  assert.equal(f.c.searchSuggestionOpen, false);
  f.frame();
  assert.deepEqual(f.events, ['hide']);
  f.frame();
  assert.equal(f.events[1][0], 'detail');
  assert.equal(f.events[1][1], drama.drama);
  assert.equal(f.events[1][3], f.c.searchInput);
  assert.equal(f.c.searchSuggestionReturnKey, 'selected');
  assert.equal(f.c.searchSuggestionActivation, null);
});

test('actor and keyword suggestions keep their existing routes after the paint boundary', () => {
  const actor = fixture();
  actor.choose({ kind: 'short_play_actor', actor_id: 'actor-1', name: '演员' });
  actor.frame(); actor.frame();
  assert.equal(actor.events[1][0], 'actor');
  assert.equal(actor.events[1][1].actor_id, 'actor-1');
  assert.equal(actor.events[1][3], actor.c.searchInput);
  const keyword = fixture();
  keyword.choose({ name: '太奶奶' });
  keyword.frame(); keyword.frame();
  assert.deepEqual(keyword.events.slice(1), [['focus', keyword.c.searchInput], ['search', '太奶奶']]);
  assert.equal(keyword.c.searchSuggestionReturnKey, '');
});

test('repeated confirmation cannot open more than one target', () => {
  const f = fixture();
  f.choose(drama); f.choose({ name: '另一个', drama: { series_id: '456' } });
  f.frame(); f.frame(); f.frame();
  assert.equal(f.events.filter(e => Array.isArray(e) && e[0] === 'detail').length, 1);
});

test('Back cancels the pending action and returns focus to the editor without reopening the target', () => {
  const f = fixture();
  f.choose(drama); f.frame();
  const late = [...f.frames.values()][0];
  f.c.closeSearchSuggestions(true);
  f.frame(); late();
  assert.equal(f.c.searchSuggestionActivation, null);
  assert.equal(f.c.searchSuggestionReturnKey, '');
  assert.equal(f.c.searchSuggestionDismissedQuery, '归路');
  assert.equal(f.events[f.events.length - 1][0], 'focus');
  assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'detail'), false);
});

test('the key router consumes repeated confirmation and cancels Escape during the paint gap', () => {
  const f = fixture();
  f.c.normalizedKey = event => event.key;
  f.c.handleBack = () => f.c.closeSearchSuggestions(true);
  vm.runInContext(block('handleKey', 'remoteKey'), f.c);
  f.choose(drama);
  const keys = [];
  for (const key of ['Enter', 'Escape']) {
    f.c.handleKey({ key, preventDefault() { keys.push(key); }, stopPropagation() {} });
  }
  f.frame(); f.frame();
  assert.deepEqual(keys, ['Enter', 'Escape']);
  assert.equal(f.c.searchSuggestionActivation, null);
  assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'detail'), false);
});

for (const [name, change] of [
  ['page navigation', c => { c.mode = 'rank'; }],
  ['changed query', c => { c.searchInput.value = '新关键词'; }],
  ['replaced suggestion response', c => { ++c.searchSuggestionGeneration; }],
  ['changed account', c => { ++c.accountEpoch; }],
  ['background', c => { c.applicationInBackground = true; }],
  ['hidden document', c => { c.hidden = true; }],
  ['another detail', c => { c.detailModalOpen = true; }],
  ['actor modal', c => { c.actorWorksOpen = true; }],
  ['scan modal', c => { c.searchScanOpen = true; }]
]) {
  test(name + ' invalidates a pending suggestion activation', () => {
    const f = fixture(); f.choose(drama); f.frame(); change(f.c); f.frame();
    assert.deepEqual(f.events, ['hide']);
    assert.equal(f.c.searchSuggestionActivation, null);
    assert.equal(f.c.searchSuggestionReturnKey, '');
  });
}

test('cancelled frame callbacks cannot invalidate a subsequent valid choice', () => {
  const f = fixture();
  f.choose(drama); const oldFrame = [...f.frames.values()][0];
  f.c.cancelSearchSuggestionActivation();
  f.choose({ name: '另一部', drama: { series_id: '456' } });
  oldFrame(); f.frame(); f.frame();
  assert.equal(f.events[f.events.length - 1][1].series_id, '456');
});

test('a WebView without animation frames gets a cancellable timer fallback', () => {
  const f = fixture(false); f.choose(drama);
  assert.deepEqual(f.events, ['hide']);
  f.timer();
  assert.equal(f.events[1][0], 'detail');
  const cancelled = fixture(false); cancelled.choose(drama);
  cancelled.c.cancelSearchSuggestionActivation(); cancelled.timer();
  assert.deepEqual(cancelled.events, ['hide']);
});

test('leaving the page, backgrounding, editing and Back explicitly cancel queued work', () => {
  assert.match(source, /function activatePage\(item, restoring\) \{\s*cancelSearchSuggestionActivation\(\)/);
  assert.match(block('pauseForBackground', 'resumeFromBackground'), /cancelSearchSuggestionActivation\(\)/);
  assert.match(block('scheduleSearchSuggestions', 'cancelSearchSuggestionActivation'), /cancelSearchSuggestionActivation\(\)/);
  assert.match(block('handleBack', 'handleMediaCommand'), /if \(searchSuggestionActivation\) \{ closeSearchSuggestions\(true\); return true; \}/);
});
