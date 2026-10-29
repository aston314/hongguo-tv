const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./helpers/app-text.cjs');
const HongguoPagination = require('../core/cmd/hongguotv/ui/pagination.js');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const slice = (a, b) => source.slice(source.indexOf('  function ' + a + '('), source.indexOf('  function ' + b + '('));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ failSave = false, writeGate = null, sourceGate = null } = {}) {
  const calls = [], nodes = {}, pages = {}, state = { entries: [] };
  function classes() {
    const set = new Set();
    return { add(...names) { names.forEach(n => set.add(n)); }, remove(...names) { names.forEach(n => set.delete(n)); }, contains(n) { return set.has(n); }, toggle(n, on) { if (on) set.add(n); else set.delete(n); } };
  }
  function node(id) { return nodes[id] || (nodes[id] = { id, textContent: '', dataset: {}, classList: classes(), innerHTML: '', style: {} }); }
  for (const mode of ['recommend', 'search', 'account', 'history', 'favorites', 'rank', 'new', 'reservations', 'support']) {
    pages[mode] = { dataset: { page: mode }, classList: classes(), querySelector() { return { textContent: mode }; } };
  }
  const channel = node('channel'); channel.dataset.focus = 'channel-recommend'; channel.textContent = '推荐';
  const video = node('hero-video');
  Object.assign(video, { currentTime: 39, duration: 90, paused: false, pause() { this.paused = true; }, removeAttribute(name) { delete this[name]; }, load() { calls.push('load'); } });
  const c = vm.createContext({ Promise, AbortController, URLSearchParams, Date, Object, Math, Number, clearTimeout, HongguoPagination,
    calls, video, pages, channel, state,
    document: { hidden: false, activeElement: pages.recommend, contains: () => true,
      getElementById: node, querySelectorAll: selector => selector === '.side-item' ? Object.values(pages) : [],
      querySelector: selector => selector === '.channel-tab.is-active' ? channel : pages[(selector.match(/data-page="([^"]+)"/) || [])[1]] || node('other') },
    fetch: async (url, options) => {
      assert.equal(url, '/api/v1/library'); const change = JSON.parse(options.body); calls.push({ kind: 'save', ...change });
      if (writeGate) await writeGate.promise;
      if (failSave) return { ok: false, json: async () => ({ ok: false, error: 'fixture save failed' }) };
      const entry = { drama: change.drama, episode: change.episode, position: change.position, duration: change.duration,
        video_id: change.video_id, completed: change.completed, last_played_at: Date.now() };
      state.entries = state.entries.filter(e => e.drama.series_id !== entry.drama.series_id).concat(entry);
      return { ok: true, json: async () => ({ ok: true, data: { owner_id: 'account', entries: state.entries.slice() } }) };
    },
    fetchData: async (url, options) => {
      if (url.startsWith('/api/v1/lists/recommend')) {
        calls.push({ kind: 'recommend', url });
        return { items: [{ series_id: 'fresh', title: 'fresh', vid: 'fresh-1', episode_count: 3 }], has_more: false };
      }
      const params = new URLSearchParams(url.split('?')[1]);
      const item = { kind: 'source', series_id: params.get('series_id'), vid: params.get('vid'), signal: options.signal };
      calls.push(item); if (sourceGate) await sourceGate.promise;
      return { path: '/media/' + item.series_id + '/' + item.vid + '.mp4', quality: '720P', qualities: ['720P'] };
    }
  });
  vm.runInContext("var desktopShell=false;" + source.match(/  function applicationHidden[^\n]+/)[0], c);
  vm.runInContext(`
    var shell={dataset:{mode:'recommend'},classList:document.getElementById('shell').classList}, mainSurface=document.getElementById('main-surface');
    var searchPage=document.getElementById('search-page'),pagePlaceholder=document.getElementById('placeholder'),libraryPage=document.getElementById('library-page'),accountPage=document.getElementById('account-page'),supportPage=document.getElementById('support-page');
    var searchScanOpen=false,smsVerification=null,supportModalOpen=false,detailModalOpen=false,engagement={clear:function(){}};
    var autoCinemaEnabled=false,autoCinemaCandidate=false,autoCinemaGeneration=0,autoCinemaSession=null;
    var feedItems=Array.from({length:5},function(_,i){return {series_id:'r'+i,title:'Drama '+i,vid:'r'+i+'-1',episode_count:3,vid_list:['r'+i+'-1','r'+i+'-2','r'+i+'-3']}}),feedIndex=1,feedGeneration=1,continuationGeneration=0;
    var recommendationAutoplayPending=false;
    var recommendationSession=null,accountEpoch=1,accountData={logged_in:true},activePlayback={item:feedItems[1],episode:2,position:12,vid:'r1-2',owner:1,generation:1,started:true,lastWrite:0,completed:false};
    var playbackRequest=null,playbackInfoRequest=null,playbackPrefetchHandoff=null,controlsTimer=null,playbackQuality='',playbackQualities=[],playbackPreferences={quality:'720P'},applicationInBackground=false;
    var playbackRecovery={reset:function(){},next:function(){return 'stop'},attempts:function(){return 0}};
    var libraryData={owner_id:'account',entries:[]},libraryReady=Promise.resolve(),libraryQueue=Promise.resolve(),libraryLoaded=true,libraryError='',libraryEditing=false;
    var playerReturnPage=null,playerReturnFocus=null;
    var searchPager={loaded:true,cancel:function(){}},searchKind='browse',activeSearchQuery='',searchHistory={load:function(){}};
    var episodePrefetch={keepFor:function(){},consume:function(){return null},cancel:function(){}};
    function pageMode(){return shell.dataset.mode}function isPlaybackPage(){return pageMode()==='recommend'||pageMode()==='player'}function isLibraryPage(){return false}
    function playbackEngineName(){return ''}function nativePlaybackActive(){return false}
    function activeChannel(){return channel}function basicDrama(x){return {series_id:x.series_id,title:x.title,episode_count:x.episode_count}}
    function libraryEntry(id){return libraryData.entries.filter(function(e){return e.drama.series_id===id})[0]||null}
    function firstVid(x){return x.vid||x.vid_list&&x.vid_list[0]}function getDetail(x){return Promise.resolve(Object.assign({},x,{vid_list:[x.series_id+'-1',x.series_id+'-2',x.series_id+'-3']}))}
    function closePlayerOptions(){}function closeDiscussion(){}function resetDanmaku(){}function updateFeedCounter(){}function setCatalogHeading(){}
    function updateSavedButtons(){}function updateDetailProgress(){}function renderLibrary(){}function updateSeriesRows(){}function updatePlaybackControls(){}function updateSeasonControl(){}
    function cancelPlaybackPreparation(){if(playbackInfoRequest)playbackInfoRequest.abort();playbackInfoRequest=null;}
    function setFeatured(x){windowFeatured=x}function holdPlaybackAudio(){}function releasePlaybackAudio(){}
    function hasLastPlaybackFrame(){return false}function captureLastPlaybackFrame(){}function clearLastPlaybackFrame(){}
    function waitForPlaybackPaint(){return Promise.resolve(true)}function bindPlaybackPresentation(){}function clearRangeTransitionHint(){}function waitForPlaybackPrefetch(handoff){return handoff ? handoff.promise : Promise.resolve(null)}
    function setPlayerStatus(){}function showRecommendationPlaceholder(){}function episodeLoadingText(){return 'loading'}function revealControls(){}function showNotice(x){calls.push({kind:'notice',text:x})}
    function playMedia(v){v.paused=false;calls.push({kind:'play',src:v.src});return Promise.resolve()}
    function stageNativePlaybackStartPosition(){}
    function accountKeypadOpen(){return false}function hideWorkspacePages(){}function goFocus(x){document.activeElement=x}function firstContentFocus(){return pageMode()==='recommend'?activeChannel():document.getElementById('hero-feed-focus')}
    function cancelPendingAutoCinema(){autoCinemaCandidate=false;autoCinemaSession=null;autoCinemaGeneration=0}
    function resetPlayerUI(){cancelPlaybackPreparation()}function renderAccount(){}function pollAccount(){}function queueTailCheck(){}
    var feedPager=HongguoPagination.create({request:function(params,signal){return fetchData('/api/v1/lists/recommend?'+new URLSearchParams(params),{signal:signal})},render:function(items,append){if(append)feedItems=feedItems.concat(items);else renderFeed(items)}});
    feedPager.local(feedItems,feedItems.length);feedPager.params={channel:'16'};var allPagers=[feedPager,searchPager];
  ` + slice('resumeEpisode', 'clockText') + slice('changeLibrary', 'toggleSaved') +
    slice('recommendationChannel', 'showRecommendationPlaceholder') + slice('saveProgress', 'continueAfterEpisode') +
    slice('recoverPlaybackPreparation', 'clearRangeTransitionHint') + slice('playFeedItem', 'posterSeasonLabel') + slice('loadCatalog', 'seriesMessage') +
    source.slice(source.indexOf('  function activatePage('), source.indexOf("  document.addEventListener('keydown', handleKey")), c);
  return { c, calls, video, channel, state, async flush() { for (let i = 0; i < 6; i++) await tick(); }, entry(episode, position, extra = {}) {
    c.libraryData.entries = [{ drama: c.feedItems.find(x => x.series_id === 'r1') || { series_id: 'r1', episode_count: 3 }, episode, position, duration: 90, video_id: 'r1-' + episode, completed: false, last_played_at: Date.now(), ...extra }];
    state.entries = c.libraryData.entries;
  } };
}

test('leaving and returning restores the list, index, episode and position without requesting new recommendations', async () => {
  const f = fixture(); f.c.activatePage(f.c.pages.search); await f.flush(); f.c.activatePage(f.c.pages.recommend); await f.flush();
  assert.equal(f.c.feedIndex, 1); assert.deepEqual(plain(f.c.feedItems.map(x => x.series_id)), ['r0','r1','r2','r3','r4']);
  assert.equal(f.c.activePlayback.episode, 2); assert.equal(f.c.activePlayback.position, 39);
  assert.equal(f.calls.filter(x => x.kind === 'recommend').length, 0);
  assert.equal(f.c.document.activeElement, f.channel);
});
test('another-page single-drama playback cannot overwrite the recommendation list or move its current slot', async () => {
  const f = fixture(); f.c.activatePage(f.c.pages.search); await f.flush();
  f.c.startPlayer({ series_id: 'other', title: 'Other', vid: 'other-1', episode_count: 3 }); await f.flush();
  f.c.activePlayback.started = true; f.video.currentTime = 8; f.c.activatePage(f.c.pages.recommend); await f.flush();
  assert.equal(f.c.feedItems[f.c.feedIndex].series_id, 'r1'); assert.equal(f.c.activePlayback.episode, 2); assert.equal(f.c.activePlayback.position, 39);
});
test('the newest progress of the same drama takes precedence, including intentionally replaying an earlier episode', async () => {
  for (const episode of [1, 3]) {
    const f = fixture(); f.c.activatePage(f.c.pages.search); await f.flush(); f.entry(episode, 17);
    f.c.activatePage(f.c.pages.recommend); await f.flush();
    assert.equal(f.c.activePlayback.item.series_id, 'r1'); assert.equal(f.c.activePlayback.episode, episode); assert.equal(f.c.activePlayback.position, 17);
  }
});
test('a failed departure save still resumes the captured position without losing the current drama', async () => {
  const f = fixture({ failSave: true }); f.entry(1, 4); f.c.activatePage(f.c.pages.search); await f.flush();
  f.c.activatePage(f.c.pages.recommend); await f.flush();
  assert.equal(f.c.activePlayback.episode, 2); assert.equal(f.c.activePlayback.position, 39); assert.ok(f.calls.some(x => x.kind === 'notice'));
});
test('pending departure writes settle before restoration and never replace a requested next episode with stale media time', async () => {
  const gate = deferred(), f = fixture({ writeGate: gate }); f.entry(1, 4);
  f.c.activePlayback.started = false; f.c.activePlayback.episode = 3; f.c.activePlayback.position = 7;
  f.c.libraryQueue = gate.promise.then(() => { f.entry(2, 39); });
  f.c.activatePage(f.c.pages.search); f.c.activatePage(f.c.pages.recommend); await f.flush();
  assert.equal(f.c.activePlayback, null); assert.equal(f.calls.filter(x => x.kind === 'source').length, 0);
  gate.resolve(); await f.flush();
  assert.equal(f.c.activePlayback.episode, 3); assert.equal(f.c.activePlayback.position, 7);
});
test('leaving during source resolution aborts the old request and a late response cannot bind outside the playback page', async () => {
  const gate = deferred(), f = fixture({ sourceGate: gate }); f.c.playFeedItem(1, 3, 7); await f.flush();
  const first = f.calls.find(x => x.kind === 'source'); assert.ok(first);
  f.c.activatePage(f.c.pages.search); assert.equal(first.signal.aborted, true); gate.resolve(); await f.flush();
  assert.equal(f.c.shell.dataset.mode, 'search'); assert.equal(f.video.src, undefined);
  f.c.activatePage(f.c.pages.recommend); await f.flush(); assert.equal(f.c.activePlayback.episode, 3); assert.equal(f.c.activePlayback.position, 7);
});
test('refresh invalidates the saved list and old save callbacks; subsequent return restores the refreshed list', async () => {
  const f = fixture(); f.c.activatePage(f.c.pages.search); await f.flush();
  f.c.activatePage(f.c.pages.recommend); await f.flush(); f.c.loadCatalog('推荐'); await f.flush();
  assert.equal(f.c.recommendationSession, null); assert.equal(f.c.feedItems[0].series_id, 'fresh');
  f.c.activatePage(f.c.pages.search); await f.flush(); f.c.activatePage(f.c.pages.recommend); await f.flush();
  assert.equal(f.c.feedItems[f.c.feedIndex].series_id, 'fresh'); assert.equal(f.calls.filter(x => x.kind === 'recommend').length, 1);
});
test('selecting the already open recommendation sidebar does not reset playback or save progress twice', async () => {
  const f = fixture(), original = f.c.activePlayback; f.c.activatePage(f.c.pages.recommend); await f.flush();
  assert.equal(f.c.activePlayback, original); assert.equal(f.video.currentTime, 39); assert.equal(f.calls.length, 0);
  assert.equal(f.c.document.activeElement, f.channel);
});
test('returning from the single-drama player to recommendation restores channel focus instead of its previous video focus', async () => {
  const f = fixture(); f.c.startPlayer(f.c.feedItems[1], f.c.document.getElementById('hero-feed-focus')); await f.flush();
  f.c.leavePlayer(); await f.flush();
  assert.equal(f.c.pageMode(), 'recommend'); assert.equal(f.c.document.activeElement, f.channel);
  assert.equal(f.c.feedIndex, 1); assert.equal(f.calls.filter(x => x.kind === 'recommend').length, 0);
});
test('owner or channel changes reject an old session instead of restoring another account or channel', async () => {
  for (const change of ['owner', 'channel']) {
    const f = fixture(); f.c.activatePage(f.c.pages.search); await f.flush();
    if (change === 'owner') f.c.accountEpoch++; else f.channel.dataset.focus = 'channel-real';
    f.c.activatePage(f.c.pages.recommend); await f.flush();
    assert.equal(f.calls.filter(x => x.kind === 'recommend').length, 1); assert.equal(f.c.feedItems[0].series_id, 'fresh');
  }
});
test('completed episode resume follows existing history semantics and does not reuse the ending timestamp', () => {
  const f = fixture(); const item = f.c.feedItems[1];
  assert.deepEqual(plain(f.c.recommendationResume({ episode: 2, position: 90, completed: true, history: '' }, null, item)), { episode: 3, position: 0 });
});
test('while the departure queue is pending, loading uses its requested episode rather than a partially saved older episode', () => {
  const f = fixture(); f.entry(2, 39);
  assert.deepEqual(plain(f.c.recommendationResume({ episode: 3, position: 7, completed: false, history: '', pending: true }, f.c.libraryData.entries[0], f.c.feedItems[1])), { episode: 3, position: 7 });
});
test('buffered pager pages and cursor survive navigation, while a canceled reply cannot change the saved list', async () => {
  const f = fixture(), gate = deferred();
  f.c.feedPager.more = true; f.c.feedPager.cursor = { offset: 20, session_id: 'same-session' };
  // The real pager invalidates its pending response before aborting.
  f.c.feedPager.cancel();
  f.c.feedPager = HongguoPagination.create({ request: () => gate.promise, render: items => { f.c.feedItems = f.c.feedItems.concat(items); } });
  f.c.feedPager.local(f.c.feedItems, f.c.feedItems.length); f.c.feedPager.params = { channel: '16' }; f.c.feedPager.more = true; f.c.feedPager.cursor = { offset: 20, session_id: 'same-session' };
  f.c.allPagers = [f.c.feedPager, f.c.searchPager]; f.c.feedPager.load(); await tick();
  f.c.activatePage(f.c.pages.search); gate.resolve({ items: [{ series_id: 'late' }], has_more: true, next_offset: 40 }); await f.flush();
  assert.equal(f.c.feedPager.cursor.offset, 20); assert.equal(f.c.feedPager.cursor.session_id, 'same-session');
  f.c.activatePage(f.c.pages.recommend); await f.flush();
  assert.equal(f.c.feedItems.some(x => x.series_id === 'late'), false); assert.equal(f.c.feedIndex, 1);
});
