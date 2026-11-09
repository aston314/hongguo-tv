const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const WatchingReturn = require('../core/cmd/hongguotv/ui/watching-return.js');
const { uiText } = require('./helpers/app-text.cjs');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const fn = name => source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'))[0];
const resumeEpisode = vm.runInNewContext('(' + fn('resumeEpisode').trim() + ')');
function node() {
  const classes = new Set(), events = {};
  return { textContent: '', style: {}, offsetWidth: 230, offsetHeight: 92, events,
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle(x, on) { on ? classes.add(x) : classes.delete(x); } },
    addEventListener(name, cb) { events[name] = cb; }, setAttribute(name, value) { this[name] = value; },
    getBoundingClientRect: () => ({ top: 430, right: 88 }) };
}
function fixture() {
  const view = Object.fromEntries(['wrap','button','cover','title','meta','tooltip','tooltipTitle','tooltipMeta'].map(key => [key, node()]));
  const state = { owner: 1, playingPage: false, icons: false, calls: [], covers: 0 };
  const controller = WatchingReturn.create({ view, resumeEpisode, owner: () => state.owner, playbackPage: () => state.playingPage, icons: () => state.icons,
    bounds: () => ({width: 960, height: 540}), text: uiText, clock: x => Math.floor(x/60) + ':' + String(x%60).padStart(2,'0'),
    cover: () => state.covers++, resume: (snapshot, target) => state.calls.push({snapshot, target}) });
  const capture = (extra = {}) => controller.capture({ item: {series_id: 's1', title: '原剧'}, owner: 1, episode: 12, position: 155, ...extra });
  return {controller, view, state, capture};
}
test('the card represents this session, resumes the exact drama/episode/time, and stays hidden on the viewing page even when paused', () => {
  const f = fixture(); f.controller.render(); assert.ok(f.view.wrap.classList.contains('is-hidden'));
  f.capture(); f.controller.render(); assert.equal(f.view.wrap.classList.contains('is-hidden'), false);
  assert.equal(f.view.title.textContent, '原剧'); assert.equal(f.view.meta.textContent, '第 12 集 · 2:35');
  f.view.button.events.click(); assert.equal(f.state.calls.length, 1);
  assert.deepEqual(f.state.calls[0].snapshot, {item: {series_id:'s1',title:'原剧'},owner:1,episode:12,position:155});
  f.state.playingPage = true; f.controller.render(); f.view.button.events.click();
  assert.ok(f.view.wrap.classList.contains('is-hidden')); assert.equal(f.state.calls.length, 1);
  f.state.playingPage = false; f.controller.render(); assert.equal(f.view.wrap.classList.contains('is-hidden'), false);
});
test('a new drama replaces the card and an account change prevents resuming another owner', () => {
  const f = fixture(); f.capture(); f.capture({item:{series_id:'s2',title:'新剧'},episode:3,position:8}); f.controller.render();
  assert.equal(f.view.title.textContent, '新剧'); assert.equal(f.view.meta.textContent, '第 3 集 · 0:08');
  f.state.owner = 2; f.controller.render(); f.view.button.events.click();
  assert.ok(f.view.wrap.classList.contains('is-hidden')); assert.equal(f.state.calls.length, 0);
  assert.equal(f.capture(), false); f.controller.clear(); assert.equal(f.controller.snapshot(), null);
});
test('icon mode offers full information on focus without loading covers repeatedly or putting its tooltip outside the viewport', () => {
  const f = fixture(); f.capture(); f.controller.render(); f.controller.render(); assert.equal(f.state.covers, 1);
  f.view.button.events.focus(); assert.ok(f.view.tooltip.classList.contains('is-hidden'));
  f.state.icons = true; f.controller.render(); assert.equal(f.view.tooltip.classList.contains('is-hidden'), false);
  assert.equal(f.view.tooltipTitle.textContent, '原剧'); assert.match(f.view.tooltipMeta.textContent, /第 12 集.*2:35.*全屏继续/);
  assert.ok(parseInt(f.view.tooltip.style.top) + f.view.tooltip.offsetHeight <= 532);
  f.view.button.events.blur(); assert.ok(f.view.tooltip.classList.contains('is-hidden'));
});
const history = (id, time, extra = {}) => ({drama:{series_id:id,title:id,episode_count:20},last_played_at:time,episode:12,position:155,...extra});
test('a fresh controller restores the newest valid watched history, not collection order or favorites, without starting playback', () => {
  const f = fixture();
  f.controller.restore([history('old',1), history('latest',10), history('favorite',0,{favorite_at:99}),
    history('missing-drama',30,{drama:null}), history('bad-episode',40,{episode:0}), history('older',5)]);
  f.controller.render();
  assert.equal(f.view.title.textContent,'latest'); assert.equal(f.view.meta.textContent,'第 12 集 · 2:35');
  assert.equal(f.state.calls.length,0);
  f.view.button.events.click();
  assert.equal(f.state.calls[0].snapshot.item.series_id,'latest');
  assert.equal(f.state.calls[0].snapshot.episode,12); assert.equal(f.state.calls[0].snapshot.position,155);
  assert.equal(f.view.wrap.classList.contains('is-hidden'),false);
});
test('restored completed episodes follow existing resume rules and never seek to their ending', () => {
  const f = fixture();
  for (const [episode,expected] of [[12,13],[20,1]]) {
    f.controller.restore([history('completed',10,{episode,completed:true})]);
    assert.equal(f.controller.snapshot().episode,expected); assert.equal(f.controller.snapshot().position,0);
  }
  f.controller.restore([history('bad-position',10,{position:Infinity})]); assert.equal(f.controller.snapshot().position,0);
  f.controller.restore([]); f.controller.render();
  assert.equal(f.controller.snapshot(),null); assert.ok(f.view.wrap.classList.contains('is-hidden'));
});
test('loaded history can refresh until a live departure checkpoint exists, then late saves cannot rewind it', () => {
  const f = fixture(); f.controller.restore([history('old',1)]); f.controller.restore([history('new',2)]);
  assert.equal(f.controller.snapshot().item.series_id,'new');
  f.capture({episode:3,position:39});
  f.controller.restore([history('older-response',100)]); f.controller.restore([]);
  assert.equal(f.controller.snapshot().item.series_id,'s1'); assert.equal(f.controller.snapshot().episode,3);
  assert.equal(f.controller.snapshot().position,39);
  f.controller.clear(); f.state.owner=2; f.controller.restore([history('account-two',10)]);
  assert.equal(f.controller.snapshot().owner,2); assert.equal(f.controller.snapshot().item.series_id,'account-two');
});
function historyFixture() {
  const f = fixture(), notices=[];
  const c = vm.createContext({ Promise, accountEpoch:1, libraryData:{entries:[],owner_id:''}, libraryLoaded:false,
    libraryReady:Promise.resolve(), libraryQueue:Promise.resolve(), watchingReturn:f.controller,
    updateSavedButtons(){}, updateDetailProgress(){}, detailModalOpen:false, isLibraryPage:()=>false,
    renderWatchingReturn:()=>f.controller.render(), localizedError:()=> 'load failed', showNotice:x=>notices.push(x),
    uiText, apiError:()=> 'invalid', fetch:async()=>({ok:true,json:async()=>({ok:true,data:{entries:[history('persisted',10)]}})}) });
  vm.runInContext(['loadLibrary','changeLibrary','restoreWatchingReturn'].map(fn).join('\n'),c);
  return {...f,c,notices};
}
test('real library load restores the card, failed reads preserve it, and late account responses are ignored', async () => {
  const f = historyFixture(); assert.equal(await f.c.loadLibrary(),true);
  assert.equal(f.controller.snapshot().item.series_id,'persisted');
  f.c.fetch=async()=>{throw new Error('offline')}; assert.equal(await f.c.loadLibrary(),false);
  assert.equal(f.controller.snapshot().item.series_id,'persisted');
  let resolve; f.c.fetch=()=>new Promise(r=>resolve=r); const pending=f.c.loadLibrary();
  f.c.accountEpoch=2; f.state.owner=2; f.controller.clear();
  resolve({ok:true,json:async()=>({ok:true,data:{entries:[history('wrong-owner',50)]}})});
  assert.equal(await pending,false); assert.equal(f.controller.snapshot(),null);
});
test('successful history deletion updates the card while favorite deletion and failed clears retain the departure point', async () => {
  const f = historyFixture(); f.capture();
  f.c.fetch=async()=>({ok:true,json:async()=>({ok:true,data:{entries:[history('previous',5)]}})});
  await f.c.changeLibrary({action:'remove',kind:'favorites',series_id:'s1'});
  assert.equal(f.controller.snapshot().item.series_id,'s1');
  await f.c.changeLibrary({action:'remove',kind:'history',series_id:'s1'});
  assert.equal(f.controller.snapshot().item.series_id,'previous');
  f.c.fetch=async()=>{throw new Error('offline')};
  assert.equal(await f.c.changeLibrary({action:'clear',kind:'history'}),false);
  assert.equal(f.controller.snapshot().item.series_id,'previous');
  f.c.fetch=async()=>({ok:true,json:async()=>({ok:true,data:{entries:[]}})});
  assert.equal(await f.c.changeLibrary({action:'clear',kind:'history'}),true);
  assert.equal(f.controller.snapshot(),null); assert.ok(f.view.wrap.classList.contains('is-hidden'));
});
function checkpointFixture() {
  const video = {currentTime: 39}, captured = [];
  const c = vm.createContext({ activePlayback: {item:{series_id:'s1',title:'原剧',episode_count:20},episode:12,position:7,owner:1,generation:4,started:true},
    watchingReturn:{capture:x=>captured.push(x)}, playbackRequest:null, accountEpoch:1, feedGeneration:4, feedItems:[],
    document:{getElementById:()=>video}, isPlaybackPage:()=>true, libraryEntry:()=>null, basicDrama:x=>({...x}) });
  vm.runInContext(source.slice(source.indexOf('  function resumeEpisode('), source.indexOf('  function clockText(')) +
    source.slice(source.indexOf('  function rememberWatchingReturn('), source.indexOf('  function showRecommendationPlaceholder(')), c);
  return {c, video, captured};
}
test('departure captures observed media time only after playback starts; pending playback keeps its requested position', () => {
  const f = checkpointFixture(); f.c.rememberWatchingReturn(); assert.equal(f.captured[0].position, 39);
  f.c.activePlayback.started=false; f.c.rememberWatchingReturn(); assert.equal(f.captured[1].position, 7);
  f.c.activePlayback.completed=true; f.c.rememberWatchingReturn(); assert.equal(f.captured[2].episode,13); assert.equal(f.captured[2].position,0);
});
test('rapid navigation during a pending source remembers that target and rejects stale generations and account data', () => {
  const f = checkpointFixture(); f.c.activePlayback=null; f.c.feedItems=[{series_id:'pending',title:'目标剧'}];
  f.c.playbackRequest={index:0,series_id:'pending',owner:1,generation:4,episode:3,position:8};
  f.c.rememberWatchingReturn(); assert.equal(f.captured[0].item.series_id,'pending'); assert.equal(f.captured[0].episode,3); assert.equal(f.captured[0].position,8);
  f.c.playbackRequest.generation=3; f.c.rememberWatchingReturn(); assert.equal(f.captured.length,1);
  f.c.playbackRequest.generation=4; f.c.playbackRequest.owner=0; f.c.rememberWatchingReturn(); assert.equal(f.captured.length,1);
});
