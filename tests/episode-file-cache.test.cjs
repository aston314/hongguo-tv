'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create,isCacheReady} = require('../core/cmd/hongguotv/ui/episode-prefetch.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const info = (extra={}) => ({series_id:'123',vid:'111',episode:1,quality:'720P',generation:3,owner:2,mode:'range',
  duration:120,position:8,stable_seconds:5,active:true,started:true,paused:false,ended:false,cache_ready:true,...extra});
const target = (extra={}) => ({series_id:'123',vid:'222',episode:2,quality:'720P',owner:2,mode:'range',...extra});
const range = {path:'/range.mp4',mode:'range',vid:'222',quality:'720P'};
const complete = {...range,path:'/complete.mp4',mode:'full'};
function fixture({prepare=async()=>range,cache}={}) {
  const pending=deferred(), calls=[];
  const p=create({lookup:async()=>target(),prepare,cache:(data,signal)=>{calls.push({data,signal});return cache ? cache(data,signal) : pending.promise;}});
  return {p,pending,calls};
}

test('optional full download waits for current-episode buffer completion, without delaying Range preparation',async()=>{
  const f=fixture();f.p.maybe(info({cache_ready:false}));await tick();assert.equal(f.calls.length,0);
  f.p.maybe(info());await tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0].data,range);
  for(let i=0;i<10;i++)f.p.maybe(info());await tick();assert.equal(f.calls.length,1);
  f.pending.resolve(complete);await tick();assert.equal(await f.p.consume(target()).promise,complete);
});

test('next-episode handoff cancels an unfinished full download and immediately returns Range',async()=>{
  const f=fixture();f.p.maybe(info());await tick();
  const handoff=f.p.consume(target());assert.equal(f.calls[0].signal.aborted,true);
  assert.equal(await handoff.promise,range);
  f.pending.resolve(complete);await tick();assert.equal(await handoff.promise,range);
});

test('failed cache keeps the prepared source and cannot retry on every playback tick',async()=>{
  const f=fixture();f.p.maybe(info());await tick();f.pending.reject(Error('offline'));await tick();
  for(let i=0;i<20;i++)f.p.maybe(info());await tick();assert.equal(f.calls.length,1);
  assert.equal(await f.p.consume(target()).promise,range);
});

test('a failed Range preparation does not start a full-file resolver or hide foreground retry',async()=>{
  const f=fixture({prepare:async()=>{throw Error('unsupported Range');}});
  f.p.maybe(info());await tick();assert.equal(f.calls.length,0);assert.equal(await f.p.consume(target()).promise,null);
});

test('pause, buffer loss, hidden state, and explicit suspension abort without consuming the Range result',async()=>{
  for(const state of [{paused:true},{active:false},{cache_ready:false},{stable_seconds:0},{ended:true},null]) {
    const f=fixture();f.p.maybe(info());await tick();
    if(state)f.p.maybe(info(state));else f.p.suspendCache();
    assert.equal(f.calls[0].signal.aborted,true);
    f.pending.resolve(complete);await tick();f.p.maybe(info());await tick();
    assert.equal(f.calls.length,1);assert.equal(await f.p.consume(target()).promise,range);
  }
});

test('a pause before metadata arrives prevents the delayed cache from starting',async()=>{
  const prepared=deferred();const f=fixture({prepare:()=>prepared.promise});
  f.p.maybe(info());await tick();f.p.suspendCache();prepared.resolve(range);await tick();
  assert.equal(f.calls.length,0);f.p.maybe(info());await tick();assert.equal(f.calls.length,1);f.p.cancel();
});

test('quality, account, series, explicit jump and mode changes abort optional work and reject stale handoff',async()=>{
  for(const next of [target({series_id:'999'}),target({quality:'1080P'}),target({owner:4}),target({episode:4}),target({mode:''}),target({vid:'999'})]) {
    const f=fixture();f.p.maybe(info());await tick();assert.equal(f.p.consume(next),null);
    assert.equal(f.calls[0].signal.aborted,true);f.pending.resolve(complete);await tick();assert.equal(f.p.consume(target()),null);
  }
});

test('new generation cannot receive the previous generation full-file response',async()=>{
  const replies=[deferred(),deferred()];let count=0;
  const f=fixture({cache:()=>replies[count++].promise});
  f.p.maybe(info());await tick();f.p.maybe(info({generation:4}));await tick();
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].signal.aborted,true);
  replies[0].resolve(complete);await tick();
  assert.equal(await f.p.consume(target()).promise,range);assert.equal(f.calls[1].signal.aborted,true);
});

test('completed results must preserve prepared quality and target VID',async()=>{
  for(const response of [{...complete,vid:'999'},{...complete,quality:'1080P'},{...complete,mode:'range'},null]) {
    const f=fixture();f.p.maybe(info());await tick();f.pending.resolve(response);await tick();
    assert.equal(await f.p.consume(target()).promise,range);
  }
});

test('foreground can claim a pending Range lookup without starting an optional full download later',async()=>{
  const prepared=deferred();const f=fixture({prepare:()=>prepared.promise});
  f.p.maybe(info());await tick();const handoff=f.p.consume(target());prepared.resolve(range);
  assert.equal(await handoff.promise,range);await tick();assert.equal(f.calls.length,0);
});

test('AbortController-less environments retain Range prefetch and do no optional networking',async()=>{
  const saved=global.AbortController;
  try {
    global.AbortController=undefined;
    const f=fixture();f.p.maybe(info());await tick();assert.equal(f.calls.length,0);assert.equal(await f.p.consume(target()).promise,range);
  } finally {global.AbortController=saved;}
});

test('complete current buffer requires one continuous range through the episode end',()=>{
  const ranges=values=>({length:values.length,start:i=>values[i][0],end:i=>values[i][1]});
  const base={mode:'range',position:10,duration:100,buffered:ranges([[0,100]])};
  assert.equal(isCacheReady(base),true);
  for(const extra of [
    {buffered:ranges([[0,50]])},{buffered:ranges([[0,50],[70,100]])},{buffered:ranges([[20,100]])},
    {buffered:ranges([])},{buffered:{length:Infinity}},{buffered:{length:1,start(){throw Error('stale range');}}},
    {paused:true},{seeking:true},{waiting:true},{duration:Infinity},{position:NaN},{position:101}
  ])assert.equal(isCacheReady({...base,...extra}),false);
  assert.equal(isCacheReady({mode:'full'}),true);
  assert.equal(isCacheReady({mode:'full',waiting:true}),false);
});
