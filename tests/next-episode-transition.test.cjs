const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { uiText } = require('./helpers/app-text.cjs');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const slice = (a,b) => source.slice(source.indexOf('  function '+a+'('), source.indexOf('  function '+b+'('));
const tick = () => new Promise(r=>setImmediate(r));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture({failWrite=false,ready=true,engine='standard',sourceGate=null,detailGate=null,captureFailure=false,native=false,prefetchReady=false,webos=false,sourceReplies=null}={}) {
  const gate=deferred(), calls=[], resolverURLs=[], writes=[], notices=[], frames=new Map(), handlers={}, timers=[];let frameID=0;
  function classes(...initial){const names=new Set(initial);return {add(...x){x.forEach(n=>names.add(n))},remove(...x){x.forEach(n=>names.delete(n))},contains(n){return names.has(n)},toggle(n,on){if(on)names.add(n);else names.delete(n)},names}}
  const hero={classList:classes('is-feed'),style:{}};
  const video={currentTime:120,duration:120,paused:false,ended:false,seeking:false,readyState:4,videoWidth:720,videoHeight:1280,muted:false,volume:.75,classList:classes('has-source'),getAttribute(n){return this[n]||null},addEventListener(name,fn){handlers[name]=fn},pause(){this.paused=true},removeAttribute(n){delete this[n]},load(){calls.push('load');assert.equal(hero.classList.contains('is-preparing-video'),true)}};
  const root={classList:classes(...(native?['native-playback']:[]))};
  const bounds={width:1400,height:900};
  const canvas={width:0,height:0,classList:classes(),style:{},parentNode:{getBoundingClientRect:()=>bounds},getContext(){return {drawImage(node){assert.equal(node,video);calls.push('capture');if(captureFailure===true)throw new Error('capture unavailable')},getImageData(){if(captureFailure==='read')throw new Error('tainted canvas');return {data:[12,34,56,255]}}}}};
  const elem={classList:classes(),style:{}};
  const paint=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn())};
  const document={hidden:false,documentElement:root,querySelector:()=>video,getElementById:id=>id==='hero-video'?video:id==='hero'?hero:id==='hero-last-frame'?canvas:elem,addEventListener(name,fn){handlers['document:'+name]=fn}};
  const c=vm.createContext({Promise,AbortController,URLSearchParams,Date,Object,Number,Math,clearTimeout,console,
    setTimeout(fn,delay){timers.push({fn,delay});return timers.length},
    requestAnimationFrame(fn){frames.set(++frameID,fn);return frameID},cancelAnimationFrame(id){frames.delete(id)},
    engine,video,calls,resolverURLs,writes,notices,gate,detailGate,document,uiText,webosShell:webos,
    apiError(payload,status,key,fallback){return payload&&(payload.error||payload.message)||fallback||('HTTP '+status)},
    fetch:async(url,options)=>{
      assert.equal(url,'/api/v1/library');const change=JSON.parse(options.body);calls.push('history:'+change.episode);writes.push(change);
      if(change.episode===1)await gate.promise;
      return {ok:!(failWrite&&change.episode===1),json:async()=>({ok:!(failWrite&&change.episode===1),error:'fixture disk failure',data:{owner_id:'123',entries:[{drama:change.drama,episode:change.episode}]}})};
    },
    fetchData:async url=>{calls.push('source');resolverURLs.push(url);assert.match(url,/\/api\/v1\/play\/info\?/);if(sourceGate)await sourceGate.promise;if(sourceReplies&&sourceReplies.length){const reply=sourceReplies.shift();if(reply instanceof Error)throw reply;}return {path:'/media/next.mp4',quality:'720P',qualities:['720P']};}
  });
  vm.runInContext("var desktopShell=false;" + source.match(/  function applicationHidden[^\n]+/)[0], c);
  vm.runInContext(slice('recoverPlaybackPreparation','clearRangeTransitionHint'), c);
  vm.runInContext(`
    var accountEpoch=2,feedGeneration=1,continuationGeneration=0,seasonSwitchRequest=null;
    function playbackEngineName(){return engine==='mpv'?'mpv':engine==='range'?'webview':'webview_media3'}
    function mpvInPlaceReplaceAvailable(){return engine==='mpv'}
    function nativePlaybackActive(){return document.documentElement.classList.contains('native-playback')}
    function isNativeMedia3PlaybackActive(){return nativePlaybackActive()&&playbackEngineName()!=='mpv'}
    var autoCinemaCandidate=false,autoCinemaGeneration=0,autoCinemaSession=null;
    var rangeTransitionTimer=null;
    var rangePlaybackEnabled=function(){return engine==='range'||engine==='mpv'};
    var detailModalOpen=false,qualityPrevious=null,applicationInBackground=false;
    var libraryData={owner_id:'123',entries:[]},libraryLoaded=${ready},libraryError='';
    var libraryReady=Promise.resolve(),libraryQueue=Promise.resolve();
    var playbackInfoRequest=null,playbackPrefetchHandoff=null,playbackRequest=null,controlsTimer=null,playbackAudioHold=null,playbackTiming=[];
    var playbackRecovery={reset:function(){},next:function(){return 'stop'},attempts:function(){return 0}};
    var playbackQuality='',playbackQualities=[],playbackPreferences={quality:'720P'},feedIndex=0;
    var feedItems=[{series_id:'9001',title:'fixture',episode_count:3,vid_list:['111','222','333']}];
    var activePlayback={item:feedItems[0],episode:1,vid:'111',owner:2,generation:1,started:true,lastWrite:0,completed:false};
    var episodePrefetch={keepFor:function(){},consume:function(){return ${prefetchReady ? "{promise:Promise.resolve({path:'/media/prefetched.mp4',quality:'720P',mode:'full'}),timing:{started_at:1,ready_at:2},cancel:function(){}}" : 'null'}}};
    function pageMode(){return 'player'}function isPlaybackPage(){return true}function isLibraryPage(){return false}
    function basicDrama(x){return x}function firstVid(x){return x.vid_list[0]}
    function getDetail(x){return ${detailGate ? 'detailGate.promise.then(function () { return x; })' : 'Promise.resolve(x)'}}function libraryEntry(){return null}function resumeEpisode(){return 1}
    function closePlayerOptions(){}function closeDiscussion(){}function resetDanmaku(){}function cancelPlaybackPreparation(){}
    function stageNativePlaybackStartPosition(){}
    function cancelPendingAutoCinema(){autoCinemaCandidate=false;autoCinemaGeneration=0;autoCinemaSession=null}function finishAutoCinema(){}
    function clearRangeTransitionHint(){}function waitForPlaybackPrefetch(handoff){return handoff ? handoff.promise : Promise.resolve(null)}function recoverPlaybackAfterError(){return false}
    function updateFeedCounter(){}function setFeatured(){}function updateSeriesRows(){}function updatePlaybackControls(){}
    function updateSavedButtons(){}function updateDetailProgress(){}function renderLibrary(){}
    function episodeLoadingText(){return 'loading'}function setPlayerStatus(text,failed){calls.push('status:'+text);if(failed){clearLastPlaybackFrame();if(activePlayback&&activePlayback.presentation)activePlayback.presentation.failed=true}}function revealControls(){}
    function tickDanmaku(){}function scheduleControlsHide(){}function maybePrefetchNextEpisode(){}
    function showNotice(x){notices.push(x)}function playMedia(){calls.push('play');return Promise.resolve()}
  `+slice('changeLibrary','toggleSaved')+slice('saveProgress','continueAfterEpisode')+
    slice('continueAfterEpisode','offerNextSeasonReservation')+slice('holdPlaybackAudio','renderFeed'),c);
  vm.runInContext('var media=video;'+source.slice(source.indexOf("  media.addEventListener('playing'"),source.indexOf("  document.addEventListener('visibilitychange'")),c);
  vm.runInContext("document.addEventListener('visibilitychange', function () { if (desktopShell) return; if (applicationHidden()) pauseForBackground(); else resumeFromBackground(); });",c);
  return {c,gate,detailGate,calls,resolverURLs,writes,notices,video,hero,canvas,bounds,root,document,paint,frames,handlers,timers};
}
function setHidden(f, hidden) {
  f.document.hidden = hidden;
  f.c.applicationInBackground = hidden;
  if (hidden) f.c.continuationGeneration++;
  else f.c.resumePendingContinuation(f.c.activePlayback);
}
async function settlePlayback(f, rounds=8) {
  for (let i=0; i<rounds; i++) { f.paint(); await tick(); }
}
test('an ended episode observed in the background resumes the next episode after returning',async()=>{
  const f=fixture();
  setHidden(f, true);
  f.handlers.ended();
  assert.equal(f.c.activePlayback.endedPending, true);
  setHidden(f, false);
  await tick();await tick();f.paint();f.paint();await tick();await tick();
  assert.equal(f.c.activePlayback.episode,2);
  assert.equal(f.video.src,'/media/next.mp4');
});
test('a continuation request that settles in the background is retried in the foreground',async()=>{
  const detailGate=deferred(),f=fixture({detailGate}),old=f.c.activePlayback;
  old.completed = true;
  f.c.continueAfterEpisode(old);
  await tick();
  assert.equal(old.continuationPending, true);
  setHidden(f, true);
  detailGate.resolve();
  await tick();await tick();
  assert.equal(old.endedPending, true);
  assert.equal(f.video.src, undefined);
  setHidden(f, false);
  await settlePlayback(f, 30);
  assert.equal(f.c.activePlayback.episode,2);
  assert.equal(f.video.src,'/media/next.mp4');
});
test('a native frame followed by ended can continue before the WebView playing callback',async()=>{
  const f=await prepared();
  assert.equal(f.c.activePlayback.started, false);
  f.c.activePlayback.presentation.rendered = true;
  f.handlers.ended();
  await tick();await tick();f.paint();f.paint();await tick();await tick();
  assert.equal(f.c.activePlayback.episode,3);
  assert.equal(f.video.src,'/media/next.mp4');
});
test('a stale pending continuation cannot resume after the session generation changes',async()=>{
  const f=fixture();
  setHidden(f, true);f.handlers.ended();
  assert.equal(f.c.activePlayback.endedPending, true);
  f.c.feedGeneration++;
  setHidden(f, false);
  await tick();await tick();
  assert.equal(f.video.src, undefined);
  assert.equal(f.c.activePlayback.episode, 1);
});
test('a manual season switch keeps the episode boundary from starting an automatic continuation',async()=>{
  const f=fixture();
  f.c.seasonSwitchRequest = {};
  f.handlers.ended();
  await tick();await tick();
  assert.equal(f.video.src, undefined);
  assert.equal(f.c.activePlayback.continuationPending, undefined);
});
test('automatic next starts while the completed history fsync is still pending, then saves both episodes in order',async()=>{
  const f=fixture(),old=f.c.activePlayback;
  f.c.saveProgress(true,true);f.c.continueAfterEpisode(old);
  await tick();f.paint();f.paint();
  await tick();await tick();
  assert.equal(f.video.src,'/media/next.mp4');assert.equal(f.c.activePlayback.episode,2);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].episode,1);assert.equal(f.writes[0].completed,true);
  assert.ok(f.calls.includes('source'));assert.ok(f.calls.includes('play'));
  f.c.activePlayback.started=true;f.video.currentTime=0;f.c.saveProgress(true);
  await tick();assert.equal(f.writes.length,1);
  f.gate.resolve();await f.c.libraryQueue;
  assert.deepEqual(f.writes.map(x=>[x.episode,x.completed]),[[1,true],[2,false]]);
  assert.equal(f.c.libraryData.entries[0].episode,2);
});
test('a completed prefetch is adopted without a second foreground resolver request',async()=>{
  const f=fixture({prefetchReady:true});f.gate.resolve();f.c.playFeedItem(0,2,0);
  f.paint();f.paint();await tick();await tick();
  assert.equal(f.video.src,'/media/prefetched.mp4');
  assert.ok(!f.calls.includes('source'));
});
test('webOS automatic continuation recovers a temporary source failure without a retry click', async () => {
  const error = Object.assign(new Error('temporary source failure'), { code: 'VIDEO_MODEL_EMPTY', status: 502 });
  const f = fixture({ webos: true, engine: 'range', sourceReplies: [error, null] });
  f.c.playbackRecovery = require('../core/cmd/hongguotv/ui/playback-recovery').create({ maxAttempts: 1 });
  f.gate.resolve(); f.handlers.ended();
  await settlePlayback(f, 30);
  assert.equal(f.c.activePlayback.episode, 2);
  assert.equal(f.c.activePlayback.position, 0, 'old video ended at 120 seconds; new episode must start at zero');
  assert.equal(f.c.activePlayback.timing.automatic_next, true, 'recovery retains the automatic continuation diagnostic');
  assert.equal(f.video.src, '/media/next.mp4');
  assert.equal(f.resolverURLs.length, 2);
  assert(!f.calls.includes('status:暂时无法播放这集'), 'temporary failure stays in loading until recovery settles');
});
test('webOS consecutive source failures stop after one page refresh and show the retry action', async () => {
  const error = Object.assign(new Error('temporary source failure'), { code: 'VIDEO_MODEL_EMPTY', status: 502 });
  const f = fixture({ webos: true, engine: 'range', sourceReplies: [error, error, error] });
  f.c.playbackRecovery = require('../core/cmd/hongguotv/ui/playback-recovery').create({ maxAttempts: 1 });
  f.gate.resolve(); f.handlers.ended(); await settlePlayback(f, 30);
  assert.equal(f.resolverURLs.length, 2);
  assert(f.calls.includes('status:暂时无法播放这集'));
});
test('webOS automatic handoffs consume the real coordinator on every episode using the same video', async () => {
  const f = fixture({ webos: true, engine: 'range' });
  f.c.window = { HongguoWebOS: {} };
  f.c.HongguoEpisodePrefetch = require('../core/cmd/hongguotv/ui/episode-prefetch');
  vm.runInContext(source.slice(source.indexOf('  var episodePrefetch ='), source.indexOf('  var applicationInBackground =')), f.c);
  vm.runInContext(slice('maybePrefetchNextEpisode', 'holdPlaybackAudio'), f.c);
  f.c.feedItems[0].vid_list.push('444', '555'); f.c.feedItems[0].episode_count = 5;
  f.gate.resolve();
  for (let episode = 1; episode < 5; episode++) {
    f.video.paused = false; f.video.ended = false; f.video.currentTime = 6;
    f.c.activePlayback.started = true; f.c.activePlayback.stableSince = Date.now() - 6000;
    f.handlers.timeupdate(); await tick();
    const before = f.resolverURLs.length;
    f.video.currentTime = 120; f.video.ended = true;
    f.handlers.ended(); await settlePlayback(f, 20);
    assert.equal(f.c.activePlayback.episode, episode + 1);
    assert.equal(f.resolverURLs.length, before, 'automatic switch must use prepared info without resolving again');
    assert.equal(f.document.getElementById('hero-video'), f.video, 'the original player and its listeners stay attached');
    assert.equal(f.c.media, f.video);
  }
  assert.equal(f.resolverURLs.length, 4);
});
test('MPV retries a failed speculative Range preparation through the foreground Range/full-file fallback contract',async()=>{
  const f=fixture({engine:'mpv'});f.gate.resolve();f.c.playFeedItem(0,2,0);
  f.paint();f.paint();await tick();await tick();await tick();
  assert.equal(f.video.src,'/media/next.mp4');
  assert.equal(f.resolverURLs.length,1);
  const query=new URLSearchParams(f.resolverURLs[0].split('?')[1]);
  assert.equal(query.get('mode'),'range');
  assert.equal(query.get('fallback'),'1');
  assert.equal(query.has('prefetch'),false);
});
test('a failed completion write is reported without stopping the already prepared next episode or poisoning later saves',async()=>{
  const f=fixture({failWrite:true}),old=f.c.activePlayback;
  f.c.saveProgress(true,true);f.c.continueAfterEpisode(old);await tick();f.paint();f.paint();await tick();await tick();
  assert.equal(f.video.src,'/media/next.mp4');
  f.c.activePlayback.started=true;f.video.currentTime=0;f.c.saveProgress(true);
  f.gate.resolve();await f.c.libraryQueue;
  assert.equal(f.c.libraryData.entries[0].episode,2);assert.ok(f.notices.some(x=>x.includes('fixture disk failure')));
});
test('explicit selection still waits for saved history and does not use the automatic shortcut',async()=>{
  const f=fixture();f.c.saveProgress(true,true);f.c.playFeedItem(0,2,0);
  f.paint();f.paint();
  await tick();await tick();assert.equal(f.video.src,undefined);assert.ok(!f.calls.includes('source'));
  f.gate.resolve();await tick();await tick();await tick();assert.equal(f.video.src,'/media/next.mp4');
  assert.equal(f.c.activePlayback.timing.automatic_next,false);
});
test('an account change or unloaded library keeps the normal history gate',async()=>{
  for(const type of ['owner','library']){
    const f=fixture(),old=f.c.activePlayback;f.c.saveProgress(true,true);
    if(type==='owner')old.owner=1;else f.c.libraryLoaded=false;
    f.c.playFeedItem(0,2,0,old);await tick();await tick();assert.equal(f.video.src,undefined);
    f.paint();f.paint();
    f.gate.resolve();await tick();await tick();await tick();assert.equal(f.video.src,'/media/next.mp4');
    assert.equal(f.c.activePlayback.timing.automatic_next,false);
  }
});
test('leaving during asynchronous handoff cannot bind the next source',async()=>{
  const f=fixture(),old=f.c.activePlayback,prepare=deferred();
  f.c.episodePrefetch.consume=()=>({promise:prepare.promise,timing:{ready_at:0},cancel(){}});
  f.c.saveProgress(true,true);f.c.continueAfterEpisode(old);await tick();f.paint();f.paint();await tick();await tick();
  f.c.feedGeneration++;prepare.resolve({path:'/late.mp4'});await tick();
  assert.equal(f.video.src,undefined);assert.ok(!f.calls.includes('source'));f.gate.resolve();await f.c.libraryQueue;
});
test('same-drama selection keeps the opaque cover and skips its poster before the native video reset',async()=>{
  const f=fixture({native:true});f.gate.resolve();f.c.playFeedItem(0,2,0);
  assert.equal(f.hero.classList.contains('is-episode-transition'),true);
  assert.equal(f.hero.classList.contains('is-native-media3-episode-transition'),true);
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);
  assert.equal(f.video.classList.contains('has-source'),false);
  assert.ok(!f.calls.includes('load'));
  f.paint();await tick();assert.ok(!f.calls.includes('load'));
  f.paint();await tick();await tick();
  assert.equal(f.video.src,'/media/next.mp4');assert.equal(f.calls.filter(x=>x==='load').length,2);
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);
});
test('MPV same-series switches do not use the Media3 poster suppression state',()=>{
  const f=fixture({engine:'mpv',native:true});f.gate.resolve();f.c.playFeedItem(0,2,0);
  assert.equal(f.hero.classList.contains('is-episode-transition'),true);
  assert.equal(f.hero.classList.contains('is-native-media3-episode-transition'),false);
});
test('a rendered Media3 frame counts as the current same-series playback before time advances',()=>{
  const f=fixture({native:true});f.c.activePlayback.started=false;f.c.activePlayback.presentation={rendered:true};
  f.gate.resolve();f.c.playFeedItem(0,2,0);
  assert.equal(f.hero.classList.contains('is-episode-transition'),true);
  assert.equal(f.hero.classList.contains('is-native-media3-episode-transition'),true);
});
test('Media3 fallback that starts after an episode switch hides the series poster during preparation',async()=>{
  const f=fixture({native:false});f.gate.resolve();f.c.playFeedItem(0,2,0);
  await settlePlayback(f);
  assert.equal(f.hero.classList.contains('is-episode-transition'),true);
  assert.equal(f.hero.classList.contains('is-native-media3-episode-transition'),false);
  assert.equal(f.c.activePlayback.preserveNativeTransition,true);
  f.handlers.nativefallbackstart();
  assert.equal(f.hero.classList.contains('is-native-media3-episode-transition'),true);
  f.handlers.nativefallbackend();
  assert.equal(f.hero.classList.contains('is-native-media3-episode-transition'),true);
  f.hero.classList.remove('is-preparing-video', 'is-episode-transition');
  f.handlers.nativefallbackend();
  assert.equal(f.hero.classList.contains('is-native-media3-episode-transition'),false);
});
test('first playback does not use the Media3 episode-transition poster suppression state',()=>{
  const f=fixture({native:true});f.c.activePlayback=null;f.gate.resolve();f.c.playFeedItem(0,1,0);
  assert.equal(f.hero.classList.contains('is-episode-transition'),false);
  assert.equal(f.hero.classList.contains('is-native-media3-episode-transition'),false);
});
test('same-series Range switch holds the old frame and delays its spinner for 320ms',()=>{
  const f=fixture({engine:'range'});f.video.src='/media/current.mp4';f.c.playFeedItem(0,2,0);
  assert.equal(f.hero.classList.contains('is-range-transition'),true);
  assert.equal(f.hero.classList.contains('is-range-transition-loading'),false);
  assert.equal(f.video.classList.contains('has-source'),true);
  const timer=f.timers.find(x=>x.delay===320);assert.ok(timer);timer.fn();
  assert.equal(f.hero.classList.contains('is-range-transition-loading'),true);
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);
});
test('same-series Range switch keeps the old source until a replacement is ready',async()=>{
  const sourceGate=deferred(),f=fixture({engine:'range',sourceGate});f.gate.resolve();f.video.src='/media/current.mp4';
  f.c.playFeedItem(0,2,0);f.paint();f.paint();await tick();await tick();
  assert.equal(f.video.src,'/media/current.mp4');assert.equal(f.calls.filter(x=>x==='load').length,0);
  sourceGate.resolve();await tick();await tick();f.paint();f.paint();await tick();await tick();
  assert.equal(f.video.src,'/media/next.mp4');assert.equal(f.calls.filter(x=>x==='load').length,1);
  assert.equal(f.hero.classList.contains('is-range-source-reset'),true);
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);
});
test('a captured frame covers source replacement until the new picture is presented, then releases its memory',async()=>{
  const f=fixture({engine:'range'});f.gate.resolve();f.video.src='/media/current.mp4';
  f.c.playFeedItem(0,2,0);
  assert.equal(f.canvas.classList.contains('is-visible'),true);
  assert.equal(f.calls.filter(x=>x==='capture').length,1);
  f.paint();f.paint();await tick();await tick();f.paint();f.paint();await tick();
  assert.equal(f.video.src,'/media/next.mp4');
  assert.equal(f.canvas.classList.contains('is-visible'),true);
  f.video.readyState=1;f.handlers.canplay();await present(f);
  assert.equal(f.canvas.classList.contains('is-visible'),true);
  f.video.readyState=4;f.video.paused=false;f.handlers.playing();
  f.paint();await tick();assert.equal(f.canvas.classList.contains('is-visible'),true);
  f.paint();await tick();assert.equal(f.canvas.classList.contains('is-visible'),false);
  assert.equal(f.canvas.width*f.canvas.height,0);
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);
});
test('standard playback falls back to its poster when the previous frame cannot be captured',async()=>{
  for(const options of [{captureFailure:true},{captureFailure:'read'},{native:true},{noFrame:true}]){
    const f=fixture({engine:'range',...options});f.gate.resolve();f.video.src='/media/current.mp4';
    if(options.noFrame)f.video.readyState=0;
    assert.doesNotThrow(()=>f.c.playFeedItem(0,2,0));
    f.paint();f.paint();await tick();await tick();f.paint();f.paint();await tick();
    assert.equal(f.video.src,'/media/next.mp4');
    assert.equal(f.canvas.classList.contains('is-visible'),false);
    assert.equal(f.canvas.width*f.canvas.height,0);
    assert.equal(f.hero.classList.contains('is-range-transition'),false);
    assert.equal(f.hero.classList.contains('is-range-source-reset'),false);
    assert.equal(f.hero.classList.contains('is-preparing-video'),true);
  }
});
test('MPV keeps its episode-cover transition when canvas capture is unavailable',async()=>{
  const f=fixture({engine:'mpv',native:true});f.gate.resolve();f.video.src='/media/current.mp4';
  f.c.playFeedItem(0,2,0);
  assert.equal(f.hero.classList.contains('is-range-transition'),true);
  f.paint();f.paint();await tick();await tick();f.paint();f.paint();await tick();
  assert.equal(f.video.src,'/media/next.mp4');
  assert.equal(f.hero.classList.contains('is-range-source-reset'),true);
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);
});
test('rapid selections retain the last displayed frame and stale presentation cannot clear it',async()=>{
  const f=fixture({engine:'range'});f.gate.resolve();f.video.src='/media/current.mp4';
  f.c.playFeedItem(0,2,0);f.paint();f.paint();await tick();await tick();f.paint();f.paint();await tick();
  const old=f.c.activePlayback;f.video.readyState=0;
  f.c.playFeedItem(0,3,0);
  assert.equal(f.canvas.classList.contains('is-visible'),true);
  assert.equal(f.calls.filter(x=>x==='capture').length,1);
  old.started=true;f.c.finishPlaybackPreparation(old);await present(f);
  assert.equal(f.canvas.classList.contains('is-visible'),true);
  await present(f);assert.ok(f.c.activePlayback.presentation);
  f.video.readyState=4;f.video.paused=false;f.handlers.playing();await present(f);
  assert.equal(f.c.activePlayback.episode,3);
  assert.equal(f.canvas.classList.contains('is-visible'),false);
});
test('frame buffers are bounded and preserve portrait/landscape proportions when the viewport changes',()=>{
  const f=fixture({engine:'range'}),item=f.c.feedItems[0];
  for(const [width,height] of [[2160,3840],[3840,2160]]){
    f.c.clearLastPlaybackFrame();f.video.videoWidth=width;f.video.videoHeight=height;
    assert.equal(f.c.captureLastPlaybackFrame(item),true);
    assert.ok(f.canvas.width*f.canvas.height<=921600);
    for(const [boxWidth,boxHeight] of [[1400,900],[1920,1080],[960,540]]){
      f.bounds.width=boxWidth;f.bounds.height=boxHeight;f.c.layoutLastPlaybackFrame();
      const displayWidth=parseFloat(f.canvas.style.width)/100*boxWidth;
      const displayHeight=parseFloat(f.canvas.style.height)/100*boxHeight;
      assert.ok(Math.abs(displayWidth/displayHeight-width/height)<.001);
      assert.ok(displayWidth<=boxWidth+.01&&displayHeight<=boxHeight+.01);
    }
  }
});
test('another drama, account or MPV switch cannot reuse a held frame',()=>{
  for(const change of ['drama','account','mpv']){
    const f=fixture({engine:change==='mpv'?'mpv':'range',native:change==='mpv'});f.video.src='/media/current.mp4';f.c.playFeedItem(0,2,0);
    if(change !== 'mpv') assert.equal(f.canvas.classList.contains('is-visible'),true);
    if(change==='drama')f.c.feedItems=[{series_id:'other',vid_list:['111']}];
    else if(change==='account')f.c.accountEpoch++;
    else f.c.engine='mpv';
    f.c.playFeedItem(0,1,0);
    assert.equal(f.canvas.classList.contains('is-visible'),false);
    assert.equal(f.canvas.width*f.canvas.height,0);
  }
});
test('first start and a different drama keep the loading poster, including after a previous same-drama transition',async()=>{
  for(const type of ['first','different']){
    const f=fixture();f.gate.resolve();f.hero.classList.add('is-episode-transition','is-starting-video');
    if(type==='first')f.c.activePlayback=null;
    else f.c.feedItems=[{series_id:'9002',vid_list:['111'],episode_count:1}];
    f.c.playFeedItem(0,1,0);
    assert.equal(f.hero.classList.contains('is-episode-transition'),false);
    assert.equal(f.hero.classList.contains('is-starting-video'),false);
    f.paint();f.paint();await tick();await tick();
    assert.equal(f.video.src,'/media/next.mp4');
  }
});
test('cancel or leave before cover paint never resets or binds a stale source',async()=>{
  for(const type of ['abort','generation','background']){
    const f=fixture();f.c.playFeedItem(0,2,0);
    if(type==='abort')f.c.playbackInfoRequest.abort();
    else if(type==='generation')f.c.feedGeneration++;
    else f.c.applicationInBackground=true;
    f.paint();f.paint();await tick();await tick();
    assert.ok(!f.calls.includes('load'));assert.ok(!f.calls.includes('source'));
    assert.equal(f.frames.size,0);
  }
});
test('starting video is painted under the cover before the cover and its one loading panel are released',async()=>{
  const f=fixture();f.gate.resolve();f.c.playFeedItem(0,2,0);f.paint();f.paint();await tick();await tick();
  const playback=f.c.activePlayback;playback.started=true;playback.stableSince=Date.now();f.video.paused=false;
  f.c.finishPlaybackPreparation(playback);
  assert.equal(f.hero.classList.contains('is-starting-video'),true);
  f.paint();await tick();assert.equal(f.hero.classList.contains('is-preparing-video'),true);
  f.paint();await tick();
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);
  assert.equal(f.hero.classList.contains('is-episode-transition'),false);
  assert.equal(f.hero.classList.contains('is-starting-video'),false);
});
test('pause, buffering, or a superseding switch keeps its cover despite an older playing event',async()=>{
  for(const type of ['pause','waiting','next']){
    const f=fixture();f.gate.resolve();f.c.playFeedItem(0,2,0);f.paint();f.paint();await tick();await tick();
    const playback=f.c.activePlayback;playback.started=true;playback.stableSince=Date.now();f.video.paused=false;
    f.c.finishPlaybackPreparation(playback);
    if(type==='pause')f.video.paused=true;
    else if(type==='waiting'){f.handlers.waiting();f.video.readyState=2;}
    else {f.c.playFeedItem(0,3,0);}
    f.paint();f.paint();await tick();
    assert.equal(f.hero.classList.contains('is-preparing-video'),true);
  }
});

async function prepared(options){
  const f=fixture(options);f.gate.resolve();f.c.playFeedItem(0,2,0);
  f.paint();f.paint();await tick();await tick();f.video.paused=false;f.video.currentTime=0;
  return f;
}
async function present(f){f.paint();f.paint();await tick();f.paint();await tick();}
test('webOS rewritten media identity releases the loading cover and held audio',async()=>{
  const f=await prepared();
  const base='http://127.0.0.1:7655',path='/minireel-proxy/media/0123456789abcdef01234567.mp4';
  f.c.window={HongguoWebOS:{sameMediaSource:(actual,expected)=>actual===base+expected}};
  f.c.activePlayback.presentation.source=path;
  f.video.src=base+path;
  f.handlers.playing();await present(f);
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);
  assert.equal(f.video.muted,false);
  assert.equal(f.c.activePlayback.started,true);
});
test('webOS source comparison still rejects a stale episode or a foreign host',async()=>{
  for(const actual of ['http://127.0.0.1:7655/minireel-proxy/media/other.mp4','http://example.com/minireel-proxy/media/current.mp4']){
    const f=await prepared();
    f.c.window={HongguoWebOS:{sameMediaSource:(actual,expected)=>actual==='http://127.0.0.1:7655'+expected}};
    f.c.activePlayback.presentation.source='/minireel-proxy/media/current.mp4';
    f.video.src=actual;
    f.handlers.playing();await present(f);
    assert.equal(f.hero.classList.contains('is-preparing-video'),true);
    assert.equal(f.video.muted,true);
  }
});
test('history seeking between playing and cover paint retries without another playing event',async()=>{
  const f=await prepared();f.handlers.playing();f.paint();
  f.video.seeking=true;f.handlers.seeking();f.paint();await tick();
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);assert.equal(f.video.muted,true);
  f.video.currentTime=39;f.video.seeking=false;f.handlers.seeked();
  await present(f);
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);assert.equal(f.video.muted,false);
  assert.equal(f.c.playbackTiming.length,1);assert.equal(f.c.activePlayback.episode,2);
});
test('waiting interrupted presentation recovers through current-source progress without playing or canplay',async()=>{
  const f=await prepared();f.handlers.playing();f.paint();f.handlers.waiting();f.paint();await tick();
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);
  f.video.currentTime=.25;f.handlers.timeupdate();await present(f);
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);assert.equal(f.video.muted,false);
});
test('advancing media can recover a missing playing event without recording the next episode before it starts',async()=>{
  const f=await prepared();assert.equal(f.c.activePlayback.started,false);
  f.video.currentTime=.25;f.handlers.timeupdate();await present(f);await f.c.libraryQueue;
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);assert.equal(f.video.muted,false);
  assert.equal(f.c.activePlayback.started,true);assert.equal(f.c.playbackTiming.length,1);
  assert.equal(f.c.libraryData.entries[0].episode,2);
});
test('a native rendered frame can reveal before playing arrives without writing history early',async()=>{
  const f=await prepared(),writesBefore=f.writes.length;assert.equal(f.c.activePlayback.started,false);
  f.handlers.nativeframe();await present(f);
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);
  assert.equal(f.video.muted,false);
  assert.equal(f.c.activePlayback.started,false);
  assert.equal(f.writes.length,writesBefore);
});
test('early canplay and audio-only/no-video data cannot remove the cover or restore sound',async()=>{
  const f=await prepared();f.handlers.canplay();await present(f);
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);assert.equal(f.video.muted,true);
  f.video.videoWidth=0;f.video.videoHeight=0;f.handlers.playing();f.video.currentTime=.25;f.handlers.timeupdate();await present(f);
  assert.equal(f.hero.classList.contains('is-preparing-video'),true);assert.equal(f.video.muted,true);
  f.video.videoWidth=720;f.video.videoHeight=1280;f.handlers.loadeddata();await present(f);
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);assert.equal(f.video.muted,false);
});
test('sound is restored only after the cover and loading removal receive a paint',async()=>{
  const f=await prepared();f.handlers.playing();
  assert.equal(f.video.muted,true);f.paint();await tick();assert.equal(f.video.muted,true);
  f.paint();await tick();assert.equal(f.hero.classList.contains('is-preparing-video'),false);
  assert.equal(f.calls.at(-1),'status:');assert.equal(f.video.muted,true);
  f.paint();await tick();assert.equal(f.video.muted,false);assert.equal(f.video.volume,.75);
  assert.equal(f.c.playbackAudioHold,null);
});
test('temporary audio hold preserves prior mute and in-transition user choices without changing volume',async()=>{
  for(const initial of [false,true]){
    const f=fixture();f.video.muted=initial;f.gate.resolve();f.c.playFeedItem(0,2,0);
    f.paint();f.paint();await tick();await tick();f.video.paused=false;f.handlers.playing();await present(f);
    assert.equal(f.video.muted,initial);assert.equal(f.video.volume,.75);
  }
  const f=await prepared();f.c.setPlaybackMuted(true);f.handlers.playing();await present(f);assert.equal(f.video.muted,true);
  f.c.holdPlaybackAudio(f.c.feedGeneration);f.c.setPlaybackMuted(false);assert.equal(f.video.muted,true);
  f.c.finishPlaybackPreparation(f.c.activePlayback);f.paint();await tick();assert.equal(f.video.muted,false);assert.equal(f.video.volume,.75);
});
test('stale picture and sound callbacks cannot affect a rapid newer switch',async()=>{
  for(const stage of ['cover','sound']){
    const f=await prepared();f.handlers.playing();const old=f.c.activePlayback;
    if(stage==='sound'){f.paint();f.paint();await tick();}
    f.c.playFeedItem(0,3,0);f.paint();f.paint();await tick();await tick();
    assert.equal(f.c.activePlayback.episode,3);assert.equal(f.hero.classList.contains('is-preparing-video'),true);
    assert.equal(f.video.muted,true);f.c.releasePlaybackAudio(old);assert.equal(f.video.muted,true);
    f.video.paused=false;f.handlers.playing();await present(f);assert.equal(f.video.muted,false);
  }
});
test('pause, background, account changes, source replacement and failure prevent late reveal/unmute',async()=>{
  for(const guard of ['pause','background','hidden','owner','source','error']){
    const f=await prepared();f.handlers.playing();f.paint();
    if(guard==='pause'){f.video.paused=true;f.handlers.pause();}
    else if(guard==='background')f.c.applicationInBackground=true;
    else if(guard==='hidden')f.c.document.hidden=true;
    else if(guard==='owner')f.c.accountEpoch++;
    else if(guard==='source')f.video.src='/other.mp4';
    else f.handlers.error();
    f.paint();await tick();f.video.currentTime=.25;f.handlers.timeupdate();f.handlers.canplay();await present(f);
    assert.equal(f.hero.classList.contains('is-preparing-video'),true,guard);assert.equal(f.video.muted,true,guard);
  }
});
test('sound restore interrupted after cover removal is retried after buffering resumes',async()=>{
  const f=await prepared();f.handlers.playing();f.paint();f.paint();await tick();
  f.handlers.waiting();f.video.readyState=2;f.paint();await tick();assert.equal(f.video.muted,true);
  f.video.currentTime=.25;f.handlers.timeupdate();f.paint();await tick();assert.equal(f.video.muted,false);
});
test('ordinary playback buffering keeps the picture and does not reenter a transition audio hold',async()=>{
  const f=await prepared();f.handlers.playing();await present(f);f.handlers.waiting();
  assert.equal(f.hero.classList.contains('is-preparing-video'),false);assert.equal(f.video.muted,false);
  assert.equal(f.c.playbackAudioHold,null);f.video.currentTime=.25;f.handlers.timeupdate();
  assert.equal(f.calls.at(-1),'status:');assert.equal(f.video.muted,false);
});
test('rebinding quality invalidates old presentation callbacks; paused exit restores user mute safely',async()=>{
  const f=await prepared();f.handlers.playing();f.paint();
  f.c.bindPlaybackPresentation(f.c.activePlayback,'/new-quality.mp4');f.video.src='/new-quality.mp4';
  f.paint();await tick();assert.equal(f.hero.classList.contains('is-preparing-video'),true);
  f.handlers.playing();await present(f);assert.equal(f.hero.classList.contains('is-preparing-video'),false);
  f.c.holdPlaybackAudio(f.c.feedGeneration);f.video.paused=true;f.c.releasePlaybackAudio();
  assert.equal(f.video.muted,false);assert.equal(f.video.volume,.75);assert.equal(f.c.playbackAudioHold,null);
});
