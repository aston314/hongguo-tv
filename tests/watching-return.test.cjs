const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const WatchingReturn = require('../core/cmd/hongguotv/ui/watching-return.js');
const { uiText } = require('./helpers/app-text.cjs');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
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
  const controller = WatchingReturn.create({ view, owner: () => state.owner, playbackPage: () => state.playingPage, icons: () => state.icons,
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
