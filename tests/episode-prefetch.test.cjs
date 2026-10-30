const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create,nextPrefetchEpisode,nextUnlockedEpisodes,prefetchThreshold,prepareParams} = require('../core/cmd/hongguotv/ui/episode-prefetch.js');
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick = () => new Promise(r=>setImmediate(r));
const info = (extra={}) => ({series_id:'123',vid:'111',episode:1,quality:'720P',generation:3,owner:2,
  duration:120,position:8,stable_seconds:5,active:true,started:true,paused:false,ended:false,...extra});
const target = (extra={}) => ({series_id:'123',vid:'222',episode:2,quality:'720P',owner:2,...extra});
function fixture(lookup) {
  const calls=[],signals=[];
  const p=create({lookup:lookup || (async x=>target({quality:x.quality})),prepare:async(x,signal)=>{calls.push(x);signals.push(signal);return {path:'/media/next.mp4'};}});
  return {p,calls,signals};
}
test('starts once after five stable playback seconds, early in a long episode', async()=>{
  const f=fixture();
  for(const x of [info({stable_seconds:4.99}),info({stable_seconds:0,position:110}),info({stable_seconds:NaN}),info({stable_seconds:undefined}),info({paused:true}),info({active:false}),info({started:false}),info({ended:true}),info({duration:NaN}),info({duration:Infinity})]) f.p.maybe(x);
  await tick();assert.equal(f.calls.length,0);
  f.p.maybe(info());f.p.maybe(info({position:90}));await tick();assert.equal(f.calls.length,1);
  const g=fixture();g.p.maybe(info({duration:600,position:2.5}));await tick();assert.equal(g.calls.length,1);
});
test('MPV can request an earlier prefetch threshold without changing the default', async()=>{
  const f=fixture();
  f.p.maybe(info({stable_seconds:.99,prefetch_after_seconds:1}));
  await tick();assert.equal(f.calls.length,0);
  f.p.maybe(info({stable_seconds:1,prefetch_after_seconds:1}));
  await tick();assert.equal(f.calls.length,1);
  const g=fixture();
  g.p.maybe(info({stable_seconds:4.99}));
  await tick();assert.equal(g.calls.length,0);
});
test('full-download mode waits longer before prefetching, especially on MPV',()=>{
  assert.equal(prefetchThreshold('range','mpv'),1);
  assert.equal(prefetchThreshold('range',''),5);
  assert.equal(prefetchThreshold('full','mpv'),12);
  assert.equal(prefetchThreshold('full',''),10);
});
test('full downloads do not start until the longer stability window is reached',async()=>{
  for (const [engine,threshold] of [['',10],['mpv',12]]) {
    const f=fixture(x=>target({quality:x.quality,prefetch_mode:'full'}));
    f.p.maybe(info({stable_seconds:threshold-.01,prefetch_after_seconds:prefetchThreshold('full',engine),prefetch_mode:'full'}));
    await tick();assert.equal(f.calls.length,0,engine);
    f.p.maybe(info({stable_seconds:threshold,prefetch_after_seconds:prefetchThreshold('full',engine),prefetch_mode:'full'}));
    await tick();assert.equal(f.calls.length,1,engine);
  }
});
test('prefetch request parameters keep full and Range preparation on separate server paths',()=>{
  assert.equal(prepareParams({series_id:'123',vid:'222',quality:'720P',prefetch_mode:'range'}).mode,'range');
  assert.equal(Object.prototype.hasOwnProperty.call(prepareParams({series_id:'123',vid:'222',prefetch_mode:'full'}),'mode'),false);
});
test('prefetch targets only the immediate next episode and ignores only inferred locks',()=>{
  const detail={series_id:'123',accessible_episode_cnt:3,vid_list:['10','11','12','13','14'],episodes:[
    {video_id:'10',locked:false},{video_id:'11',locked:false},{video_id:'12',locked:false},
    {video_id:'13',locked:true,locked_inferred:true},{video_id:'14',locked:true,locked_inferred:true}
  ]};
  assert.deepEqual(nextPrefetchEpisode(detail,3),{episode:4,vid:'13'});
  assert.equal(nextPrefetchEpisode(detail,4).episode,5);
  assert.equal(nextPrefetchEpisode(detail,5),null);
  assert.equal(nextPrefetchEpisode({vid_list:['10','11','12'],episodes:[{}, {locked:true}]},1),null,
    'an explicit lock must prevent speculative preparation');
  assert.equal(nextPrefetchEpisode({vid_list:['10','bad','12']},1),null,
    'an invalid immediate next VID must not skip ahead');
});
test('legacy candidate helper remains available with its original four-entry bound',()=>{
  assert.deepEqual(nextUnlockedEpisodes({vid_list:['1','2','3','4','5'],accessible_episode_cnt:3},0,8),[
    {episode:1,vid:'1'},{episode:2,vid:'2'},{episode:3,vid:'3'}
  ]);
});
test('seek and resume position alone do not bypass the stable interval',async()=>{
  const f=fixture();f.p.maybe(info({position:119,stable_seconds:0}));await tick();assert.equal(f.calls.length,0);
  f.p.maybe(info({position:119,stable_seconds:5}));await tick();assert.equal(f.calls.length,1);
});
test('does not recursively prepare further episodes or another season',async()=>{
  const f=fixture();f.p.maybe(info());await tick();for(let i=0;i<10;i++)f.p.maybe(info({position:110}));await tick();assert.equal(f.calls.length,1);
  for(const next of [null,target({vid:'111'}),target({vid:'bad'}),target({series_id:'456'})]){
    const g=fixture(async()=>next);g.p.maybe(info());await tick();assert.equal(g.calls.length,0);
  }
});
test('switching drama, explicit episode, quality or owner cancels even a late lookup',async()=>{
  for(const args of [['456',2,'720P',2],['123',5,'720P',2],['123',2,'1080P',2],['123',2,'720P',4]]){
    const reply=deferred();let signal;const f=fixture((_,s)=>{signal=s;return reply.promise});
    f.p.maybe(info());await tick();f.p.keepFor(...args);assert.equal(signal.aborted,true);
    reply.resolve(target());await tick();assert.equal(f.calls.length,0);
  }
});
test('natural next episode adopts the pending download without aborting or preparing twice',async()=>{
  const reply=deferred();let downloads=0,signal;
  const p=create({lookup:async()=>target(),prepare:(_,s)=>{downloads++;signal=s;return reply.promise}});
  p.maybe(info());await tick();p.keepFor('123',2,'720P',2);const next=p.consume(target());p.cancel();
  assert.ok(next);assert.equal(signal.aborted,false);reply.resolve({path:'/prepared.mp4'});
  assert.equal((await next.promise).path,'/prepared.mp4');assert.equal(downloads,1);
  assert.equal(p.consume(target()),null);
});
test('full-prefetch strategy is independent of the actual range playback mode',async()=>{
  const calls=[];
  const p=create({lookup:async()=>target({mode:'range',prefetch_mode:'full'}),prepare:async x=>{calls.push(x);return {path:'/whole.mp4'};}});
  p.maybe(info({mode:'range',prefetch_mode:'full'}));await tick();
  const handoff=p.consume(target({mode:'range',prefetch_mode:'full'}));
  assert.ok(handoff);
  assert.equal(handoff.prefetchMode,'full');
  assert.equal((await handoff.promise).path,'/whole.mp4');
  assert.equal(calls.length,1);
  const mismatch=p.consume(target({mode:'range',prefetch_mode:'range'}));
  assert.equal(mismatch,null);
});
test('readyFor is read-only and shares the handoff identity and expiry boundary',async()=>{
  let now=1000;
  const next=target({mode:'range',prefetch_mode:'full',codec_mode:'software'});
  const pending=deferred();
  const p=create({now:()=>now,fullMaxAgeMs:800,lookup:async()=>next,prepare:()=>pending.promise});
  p.maybe(info({mode:'range',prefetch_mode:'full',codec_mode:'software'}));await tick();
  assert.equal(p.readyFor(next),false,'an unfinished full download is not ready');
  pending.resolve({path:'/complete.mp4',mode:'full'});await tick();
  assert.equal(p.readyFor(next),true);
  for(const extra of [{series_id:'other'},{vid:'999'},{episode:3},{quality:'1080P'},{owner:3},{mode:''},{prefetch_mode:'range'},{codec_mode:'auto'}]) {
    assert.equal(p.readyFor({...next,...extra}),false,JSON.stringify(extra));
    assert.equal(p.readyFor(next),true,'a hint mismatch must not discard the usable cache');
  }
  now=1799;assert.equal(p.readyFor(next),true);
  now=1800;assert.equal(p.readyFor(next),false);
  assert.equal(p.consume(next),null,'an expired hint cannot become a successful handoff');
});
test('checking readiness never consumes or cancels a completed next episode',async()=>{
  const f=fixture();f.p.maybe(info());await tick();
  for(let i=0;i<3;i++)assert.equal(f.p.readyFor(target()),true);
  const handoff=f.p.consume(target());
  assert.equal((await handoff.promise).path,'/media/next.mp4');
  assert.equal(f.signals[0].aborted,false);
  assert.equal(f.p.readyFor(target()),false);
});
test('pending full downloads can be cancelled without discarding a completed file',async()=>{
  const pending=deferred();let signal;
  const p=create({lookup:async()=>target({mode:'range',prefetch_mode:'full'}),prepare:(_,s)=>{signal=s;return pending.promise;}});
  p.maybe(info({mode:'range',prefetch_mode:'full'}));await tick();
  assert.equal(p.cancelPending('full'),true);
  assert.equal(signal.aborted,true);
  const complete=create({lookup:async()=>target({mode:'range',prefetch_mode:'full'}),prepare:async()=>({path:'/complete.mp4'})});
  complete.maybe(info({mode:'range',prefetch_mode:'full'}));await tick();
  assert.equal(complete.cancelPending('full'),false);
  assert.equal((await complete.consume(target({mode:'range',prefetch_mode:'full'})).promise).path,'/complete.mp4');
});
test('pending metadata survives take-over and the foreground owner can cancel it',async()=>{
  const lookup=deferred();let downloads=0,signal;
  const p=create({lookup:(_,s)=>{signal=s;return lookup.promise},prepare:async()=>{downloads++;return {path:'/prepared.mp4'}}});
  p.maybe(info());await tick();const next=p.consume(target());assert.ok(next);
  lookup.resolve(target());assert.equal((await next.promise).path,'/prepared.mp4');assert.equal(downloads,1);
  next.cancel();assert.equal(signal.aborted,true);
});
test('speculative failure stays silent and is handed back as a normal foreground retry',async()=>{
  let attempts=0;const p=create({lookup:async()=>target(),prepare:async()=>{attempts++;throw Error('offline')}});
  p.maybe(info());await tick();p.maybe(info());await tick();assert.equal(attempts,1);
  const next=p.consume(target());assert.equal(await next.promise,null);
});
test('cancel prevents late replies from attaching to a new playback context',async()=>{
  const lookup=deferred();const f=fixture(()=>lookup.promise);f.p.maybe(info());await tick();f.p.cancel();
  lookup.resolve(target());await tick();assert.equal(f.calls.length,0);
  f.p.maybe(info({generation:4}));await tick();assert.equal(f.calls.length,1);
});
test('consume rejects a mismatched VID instead of using the wrong prepared episode',async()=>{
  const f=fixture();f.p.maybe(info());await tick();assert.equal(f.p.consume(target({vid:'999'})),null);assert.equal(f.signals[0].aborted,true);
});
test('a late metadata reply must match the episode adopted by the foreground',async()=>{
  const lookup=deferred();const f=fixture(()=>lookup.promise);f.p.maybe(info());await tick();
  const next=f.p.consume(target({vid:'999'}));lookup.resolve(target());
  assert.equal(await next.promise,null);assert.equal(f.calls.length,0);
});
test('webOS retries a failed prefetch once after the delay and only on an eligible playback tick',async()=>{
  let now=1000, attempts=0;
  const p=create({now:()=>now,maxRetries:1,retryDelayMs:3000,lookup:async()=>target(),prepare:async()=>{attempts++;throw Object.assign(Error('multi_video_model HTTP 502'),{code:'VIDEO_MODEL_HTTP',status:502,upstreamStatus:502});}});
  p.maybe(info());await tick();assert.equal(attempts,1);
  now=3999;p.maybe(info());await tick();assert.equal(attempts,1);
  now=4000;
  for(const extra of [{paused:true},{active:false},{stable_seconds:0},{ended:true}]) p.maybe(info(extra));
  await tick();assert.equal(attempts,1);
  p.maybe(info());p.maybe(info());await tick();assert.equal(attempts,2);
  now=10000;p.maybe(info());await tick();assert.equal(attempts,2);
  assert.equal(await p.consume(target()).promise,null);
});
test('permanent access errors never retry, even when surfaced as upstream 502',async()=>{
  for(const error of [
    Object.assign(new Error('该集暂不可播：需要会员权限'),{status:502,code:'VIDEO_MODEL_REJECTED'}),
    Object.assign(new Error('episode locked'),{status:502,code:'VIDEO_MODEL_REJECTED'}),
    Object.assign(new Error('unauthorized'),{status:502,code:'VIDEO_MODEL_REJECTED'}),
    Object.assign(new Error('multi_video_model 拒绝了播放请求（1003）'),{status:502,code:'VIDEO_MODEL_REJECTED'}),
    Object.assign(new Error('multi_video_model 未返回本集片源地址'),{status:502,code:'VIDEO_MODEL_MISSING'}),
    Object.assign(new Error('upstream denied'),{status:502,upstreamStatus:403,code:'VIDEO_MODEL_HTTP'}),
    Object.assign(new Error('unknown upstream failure'),{status:502,upstreamStatus:502,code:'PROVIDER_ERROR'}),
    Object.assign(new Error('bad request'),{status:400}),
    Object.assign(new Error('cancelled'),{name:'AbortError',status:503})
  ]) {
    let now=1000, attempts=0;
    const p=create({now:()=>now,maxRetries:1,retryDelayMs:3000,lookup:async()=>target(),prepare:async()=>{attempts++;throw error;}});
    p.maybe(info());await tick();now+=10000;p.maybe(info());await tick();
    assert.equal(attempts,1,String(error.message));
    assert.equal(await p.consume(target()).promise,null);
  }
});
test('transient network and Range errors remain retryable once',async()=>{
  for(const error of [
    Object.assign(new Error('RANGE_UNAVAILABLE'),{code:'RANGE_UNAVAILABLE'}),
    Object.assign(new Error('multi_video_model HTTP 502'),{status:502,upstreamStatus:502,code:'VIDEO_MODEL_HTTP'}),
    Object.assign(new Error('empty response'),{status:502,upstreamStatus:502,code:'VIDEO_MODEL_EMPTY'}),
    Object.assign(new Error('failed to fetch'),{name:'TypeError'}),
    Object.assign(new Error('gateway unavailable'),{status:502,upstreamStatus:502,code:'VIDEO_MODEL_HTTP'})
  ]) {
    let now=1000, attempts=0;
    const p=create({now:()=>now,maxRetries:1,retryDelayMs:3000,lookup:async()=>target(),prepare:async()=>{attempts++;if(attempts===1)throw error;return {path:'/retry.mp4'};}});
    p.maybe(info());await tick();now+=3000;p.maybe(info());await tick();
    assert.equal(attempts,2,String(error.message));
    assert.equal((await p.consume(target()).promise).path,'/retry.mp4');
  }
});
test('a successful retry is reused and never starts a third prepare',async()=>{
  let now=1000, attempts=0;
  const p=create({now:()=>now,maxRetries:1,lookup:async()=>target(),prepare:async()=>{if(++attempts===1)throw Object.assign(Error('multi_video_model HTTP 502'),{code:'VIDEO_MODEL_HTTP',status:502,upstreamStatus:502});return {path:'/retry.mp4'};}});
  p.maybe(info());await tick();now+=3000;p.maybe(info());await tick();
  now+=3000;p.maybe(info());await tick();
  assert.equal(attempts,2);assert.equal((await p.consume(target()).promise).path,'/retry.mp4');
});
test('webOS rejects expired prefetches while other platforms keep their existing lifetime',async()=>{
  for(const maxAgeMs of [120000,0]) {
    let now=1000;
    const p=create({now:()=>now,maxAgeMs,lookup:async()=>target(),prepare:async()=>({path:'/prepared.mp4'})});
    p.maybe(info());await tick();now+=120000;
    const handoff=p.consume(target());
    assert.equal(!!handoff,maxAgeMs===0);
  }
});
test('webOS refreshes an expired success near the end using the same bounded extra attempt',async()=>{
  let now=1000, attempts=0;
  const p=create({now:()=>now,maxRetries:1,maxAgeMs:120000,lookup:async()=>target(),prepare:async()=>({path:'/prepared-'+(++attempts)+'.mp4'})});
  p.maybe(info({duration:300}));await tick();
  now+=120000;p.maybe(info({duration:300,position:130}));await tick();assert.equal(attempts,1);
  now+=100000;p.maybe(info({duration:300,position:270}));await tick();assert.equal(attempts,2);
  now+=1000;assert.equal((await p.consume(target()).promise).path,'/prepared-2.mp4');
});
test('an old full-file cache result is rejected after its cache-safe lifetime',async()=>{
  let now=0;
  const p=create({now:()=>now,fullMaxAgeMs:60000,lookup:async()=>target({mode:'range',prefetch_mode:'full'}),prepare:async()=>({path:'/old.mp4'})});
  p.maybe(info({mode:'range',prefetch_mode:'full'}));await tick();
  now=60000;
  assert.equal(p.consume(target({mode:'range',prefetch_mode:'full'})),null);
});
test('cancel discards a failed retry candidate and a claimed lookup even without AbortController',async()=>{
  let now=1000, attempts=0;
  const p=create({now:()=>now,maxRetries:1,lookup:async()=>target(),prepare:async()=>{attempts++;throw Error('502');}});
  p.maybe(info());await tick();p.cancel();now+=3000;
  assert.equal(p.consume(target()),null);assert.equal(attempts,1);
  const original=global.AbortController;
  try {
    global.AbortController=undefined;
    const lookup=deferred();let prepared=0;
    const q=create({lookup:()=>lookup.promise,prepare:async()=>{prepared++;return {path:'/late.mp4'};}});
    q.maybe(info());await tick();const handoff=q.consume(target());handoff.cancel();
    lookup.resolve(target());assert.equal(await handoff.promise,null);assert.equal(prepared,0);
    const media=deferred();
    const r=create({lookup:async()=>target(),prepare:()=>media.promise});
    r.maybe(info());await tick();const claimed=r.consume(target());claimed.cancel();
    media.resolve({path:'/cancelled.mp4'});assert.equal(await claimed.promise,null);
  } finally {global.AbortController=original;}
});
