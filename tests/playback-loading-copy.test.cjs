const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./helpers/app-text.cjs');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const functions = source.slice(source.indexOf('  function clearPrefetchedEpisodeHint('),source.indexOf('  function setControlIcon('));
function fixture(options) {
  const classes=(...initial)=>{const set=new Set(initial);return {contains:n=>set.has(n),add:(...v)=>v.forEach(n=>set.add(n)),remove:(...v)=>v.forEach(n=>set.delete(n)),toggle(n,on){if(on)set.add(n);else set.delete(n)}}};
  const node=(...initial)=>({textContent:'',classList:classes(...initial)});
  const hero=node('is-feed','is-preparing-video'),title=node('is-hidden'),text=node(),spinner=node(),retry=node('is-hidden'),diagnostics=node('is-hidden'),panel=node('is-hidden');
  panel.querySelector=selector=>{assert.equal(selector,'.player-spinner');return spinner};
  const nodes={'hero':hero,'player-status':panel,'player-status-title':title,'player-status-text':text,'player-retry':retry,'player-failure-diagnostics':diagnostics};
  const frames=[],timers=[];
  let now=1000;
  const context={document:{getElementById:id=>nodes[id]},activePlayback:null,autoCinemaCandidate:false,featuredItem:{title:'新剧名称'},reveals:0,focused:null,coverClears:0,zoneOf:()=> 'feed',
    prefetchedEpisodeHint:null,portraitBackdrop:null,webosShell:false,episodePrefetch:{},feedGeneration:4,accountEpoch:2,applicationInBackground:false,
    playbackPreferences:{quality:'720P'},Date:{now:()=>now},isPlaybackPage:()=>true,applicationHidden:()=>false,
    rangePlaybackEnabled:()=>true,effectiveEpisodePrefetchMode:()=> 'full',
    setTimeout(fn,delay){timers.push({fn,delay,cancelled:false});return timers.length},clearTimeout(id){if(timers[id-1])timers[id-1].cancelled=true}};
  if(options&&options.frameScheduler)context.requestAnimationFrame=callback=>{frames.push(callback)};
  const c=vm.createContext(context);
  vm.runInContext('function clearLastPlaybackFrame(){}function clearEpisodeCover(){coverClears++}function cancelPendingAutoCinema(){autoCinemaCandidate=false}function revealControls(){reveals++}function goFocus(node){focused=node}'+functions,c);
  return {c,hero,title,text,spinner,retry,diagnostics,panel,frames,timers,advance(ms){now+=ms;},paint(){const pending=frames.splice(0);pending.forEach(callback=>callback())}};
}
test('first start shows only the spinner until the real target episode resolves, without a title or loading panel',()=>{
  const f=fixture(),spinner=f.spinner;
  f.c.setPlayerStatus(f.c.episodeLoadingText(0));
  assert.equal(f.title.textContent,'');assert.equal(f.title.classList.contains('is-hidden'),true);
  assert.equal(f.text.textContent,'');assert.equal(f.text.classList.contains('is-hidden'),true);
  assert.equal(f.hero.classList.contains('is-transition-loading'),true);assert.equal(f.panel.classList.contains('is-hidden'),false);
  assert.equal(f.panel.classList.contains('is-loading'),true);
  f.c.setPlayerStatus(f.c.episodeLoadingText(7));
  assert.equal(f.text.textContent,'第7集');assert.equal(f.text.classList.contains('is-hidden'),false);assert.equal(f.panel.querySelector('.player-spinner'),spinner);
  assert.equal(f.c.reveals,0);
});
test('same-drama episode switches use the target episode alone, with no repeated title',()=>{
  const f=fixture();f.hero.classList.add('is-episode-transition');
  f.c.setPlayerStatus(f.c.episodeLoadingText(28));
  assert.equal(f.title.textContent,'');assert.equal(f.title.classList.contains('is-hidden'),true);
  assert.equal(f.text.textContent,'第28集');assert.equal(f.hero.classList.contains('is-transition-loading'),true);
});
test('natural continuation hides scattered copy even while the next episode detail is still pending',()=>{
  const f=fixture();f.hero.classList.remove('is-preparing-video');f.c.activePlayback={started:true,continuationPending:true};
  f.c.setPlayerStatus(f.c.episodeLoadingText(4));
  assert.equal(f.hero.classList.contains('is-transition-loading'),true);
  assert.equal(f.title.classList.contains('is-hidden'),true);assert.equal(f.title.textContent,'');
  assert.equal(f.text.textContent,'第4集');
});
test('switching to another drama retains episode-only loading and clearing it restores normal visibility ownership',()=>{
  const f=fixture();f.hero.classList.add('is-episode-transition');f.c.setPlayerStatus(f.c.episodeLoadingText(2));
  f.hero.classList.remove('is-episode-transition');f.c.featuredItem={title:'另一部剧 · 更新后的标题'};
  f.c.setPlayerStatus(f.c.episodeLoadingText(9));
  assert.equal(f.title.textContent,'');assert.equal(f.title.classList.contains('is-hidden'),true);
  assert.equal(f.text.textContent,'第9集');assert.equal(f.panel.classList.contains('is-loading'),true);
  f.hero.classList.remove('is-preparing-video');f.c.setPlayerStatus('');
  assert.equal(f.hero.classList.contains('is-transition-loading'),false);
  assert.equal(f.title.textContent,'');assert.equal(f.panel.classList.contains('is-hidden'),true);assert.equal(f.text.classList.contains('is-hidden'),true);
  assert.equal(f.panel.classList.contains('is-loading'),false);
  assert.equal(f.c.reveals,0);
});
test('ordinary buffering and failure do not retain a stale incoming title or transition copy suppression',()=>{
  const f=fixture();f.c.setPlayerStatus(f.c.episodeLoadingText(3));
  f.hero.classList.remove('is-preparing-video');f.c.activePlayback={started:true};
  f.c.setPlayerStatus('正在缓冲…');
  assert.equal(f.hero.classList.contains('is-transition-loading'),false);assert.equal(f.title.textContent,'');
  assert.equal(f.text.textContent,'正在缓冲…');assert.equal(f.text.classList.contains('is-hidden'),false);
  assert.equal(f.spinner.classList.contains('is-hidden'),false);
  assert.equal(f.panel.classList.contains('is-loading'),true);
  f.hero.classList.add('is-preparing-video');f.c.setPlayerStatus('暂时无法播放这集',true);
  assert.equal(f.c.coverClears,1);
  assert.equal(f.hero.classList.contains('is-transition-loading'),false);assert.equal(f.title.classList.contains('is-hidden'),true);
  assert.equal(f.spinner.classList.contains('is-hidden'),true);assert.equal(f.retry.classList.contains('is-hidden'),false);
  assert.equal(f.diagnostics.classList.contains('is-hidden'),false);
  assert.equal(f.text.textContent,'暂时无法播放这集');assert.equal(f.text.classList.contains('is-hidden'),false);
  assert.equal(f.panel.classList.contains('is-loading'),false);
  assert.equal(f.c.reveals,1);assert.equal(f.c.focused,f.retry);
  f.c.setPlayerStatus('');
  assert.equal(f.retry.classList.contains('is-hidden'),true);
  assert.equal(f.diagnostics.classList.contains('is-hidden'),true);
});
test('a hidden loading panel appears after the layout has crossed a paint boundary',()=>{
  const f=fixture({frameScheduler:true});
  f.c.setPlayerStatus(f.c.episodeLoadingText(7));
  assert.equal(f.panel.classList.contains('is-hidden'),true);
  f.paint();
  assert.equal(f.panel.classList.contains('is-hidden'),true);
  f.paint();
  assert.equal(f.panel.classList.contains('is-hidden'),false);
});
test('clearing loading invalidates a queued panel reveal',()=>{
  const f=fixture({frameScheduler:true});
  f.c.setPlayerStatus(f.c.episodeLoadingText(7));
  f.c.setPlayerStatus('');
  f.paint();f.paint();
  assert.equal(f.panel.classList.contains('is-hidden'),true);
});
test('failure state is immediate and invalidates a queued loading reveal',()=>{
  const f=fixture({frameScheduler:true});
  f.c.setPlayerStatus(f.c.episodeLoadingText(7));
  f.c.setPlayerStatus('暂时无法播放这集',true);
  assert.equal(f.panel.classList.contains('is-hidden'),false);
  assert.equal(f.retry.classList.contains('is-hidden'),false);
  f.paint();f.paint();
  assert.equal(f.panel.classList.contains('is-hidden'),false);
  assert.equal(f.retry.classList.contains('is-hidden'),false);
});
test('an already visible loading panel updates without being hidden or re-revealed',()=>{
  const f=fixture({frameScheduler:true});
  f.c.setPlayerStatus(f.c.episodeLoadingText(7));
  f.paint();f.paint();
  assert.equal(f.panel.classList.contains('is-hidden'),false);
  f.c.setPlayerStatus(f.c.episodeLoadingText(8));
  assert.equal(f.panel.classList.contains('is-hidden'),false);
  assert.equal(f.text.textContent,'第8集');
  assert.equal(f.frames.length,0);
});

function beginReadySwitch(f,startedAt=1000) {
  const item={series_id:'series-1',vid_list:['111','222']};
  f.c.episodePrefetch={peek:()=>({info:{generation:4},target:{vid:'222'}}),readyFor:()=>true};
  f.c.activePlayback={item,episode:2,generation:4,owner:2,started:false,mode:'full',presentation:{}};
  f.c.beginPrefetchedEpisodeHint(item,2,4,startedAt,4);
  f.c.setPlayerStatus(f.c.episodeLoadingText(2));
}

test('a ready full-file switch hides the loading panel through paints and waiting callbacks until 800ms',()=>{
  const f=fixture({frameScheduler:true});beginReadySwitch(f);
  f.paint();f.paint();
  assert.equal(f.hero.classList.contains('is-prefetched-episode-quiet'),true);
  assert.equal(f.hero.classList.contains('is-transition-loading'),true,'preparation still owns controls');
  assert.equal(f.timers[0].delay,800);
  const listeners={};
  f.c.media={addEventListener:(name,callback)=>{listeners[name]=callback}};
  f.c.cancelFullEpisodePrefetchForPlayback=()=>{};
  f.c.interruptPlaybackPresentation=()=>{};
  const start=source.indexOf("  media.addEventListener('waiting'");
  vm.runInContext(source.slice(start,source.indexOf("  media.addEventListener('stalled'",start)),f.c);
  listeners.waiting();
  assert.equal(f.hero.classList.contains('is-prefetched-episode-quiet'),true);
  f.advance(800);f.timers[0].fn();
  assert.equal(f.hero.classList.contains('is-prefetched-episode-quiet'),false);
  assert.equal(f.hero.classList.contains('is-range-transition-loading'),true);
  assert.equal(f.text.textContent,'正在准备播放…');
  assert.equal(f.panel.classList.contains('is-loading'),true);
  listeners.waiting();
  assert.equal(f.text.textContent,'正在准备播放…','late waiting must not restore the episode number');
});

test('first frame and explicit errors cancel the quiet hint without a late spinner or error suppression',()=>{
  for(const failed of [false,true]) {
    const f=fixture({frameScheduler:true});beginReadySwitch(f);
    const staleTimer=f.timers[0];
    if(!failed)f.hero.classList.remove('is-preparing-video');
    f.c.setPlayerStatus(failed?'暂时无法播放这集':'',failed);
    f.paint();f.paint();staleTimer.fn();
    assert.equal(staleTimer.cancelled,true);
    assert.equal(f.c.prefetchedEpisodeHint,null);
    assert.equal(f.hero.classList.contains('is-prefetched-episode-quiet'),false);
    assert.equal(f.panel.classList.contains('is-hidden'),!failed);
    assert.equal(f.retry.classList.contains('is-hidden'),!failed);
    assert.equal(f.text.textContent,failed?'暂时无法播放这集':'');
  }
});

test('natural continuation carries its original deadline instead of starting another 800ms window',()=>{
  const f=fixture();f.hero.classList.remove('is-preparing-video');beginReadySwitch(f);
  f.c.activePlayback.started=true;f.c.activePlayback.continuationPending=true;
  const staleTimer=f.timers[0];
  f.advance(600);f.c.beginPrefetchedEpisodeHint(f.c.activePlayback.item,2,4,1000,4);
  assert.equal(f.timers[1].delay,200);
  staleTimer.fn();assert.equal(f.hero.classList.contains('is-prefetched-episode-quiet'),true);
  f.advance(200);f.timers[1].fn();
  assert.equal(f.hero.classList.contains('is-prefetched-episode-quiet'),false);
  assert.equal(f.text.textContent,'正在准备播放…');
});

test('obsolete timers cannot write into a new generation, account, background or different page',()=>{
  for(const invalidate of [c=>c.feedGeneration++,c=>c.accountEpoch++,c=>c.applicationInBackground=true,c=>c.applicationHidden=()=>true,c=>c.isPlaybackPage=()=>false]) {
    const f=fixture();beginReadySwitch(f);invalidate(f.c);
    const previous=f.text.textContent;f.timers[0].fn();
    assert.equal(f.c.prefetchedEpisodeHint,null);
    assert.equal(f.text.textContent,previous);
  }
});

test('webOS, range strategy, pending or stale prefetches retain normal episode loading',()=>{
  for(const invalidate of [c=>c.webosShell=true,c=>c.effectiveEpisodePrefetchMode=()=> 'range',c=>c.episodePrefetch.readyFor=()=>false,c=>c.episodePrefetch.peek=()=>({info:{generation:3},target:{vid:'222'}})]) {
    const f=fixture();beginReadySwitch(f);f.c.clearPrefetchedEpisodeHint();invalidate(f.c);
    f.c.beginPrefetchedEpisodeHint(f.c.activePlayback.item,2,4,1000,4);
    f.c.setPlayerStatus(f.c.episodeLoadingText(2));
    assert.equal(f.c.prefetchedEpisodeHint,null);
    assert.equal(f.hero.classList.contains('is-prefetched-episode-quiet'),false);
    assert.equal(f.text.textContent,'第2集');
  }
});
