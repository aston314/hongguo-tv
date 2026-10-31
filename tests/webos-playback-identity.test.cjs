'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const create=require('../webos/service/playback-identity');
const cancel=require('../webos/service/audio-cancel');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture() {
  let time=10000,sequence=0;const tasks=[],timers=new Map();
  const cache=create(signal=>new Promise((resolve,reject)=>tasks.push({signal,resolve,reject})),{
    now:()=>time,setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
  return {cache,tasks,timers,advance:ms=>time+=ms};
}
const observe=p=>p.then(value=>({value}),error=>({error}));
test('initial registration is shared, successful identity is reused, and failed initial registration can retry',async()=>{
  const f=fixture();const a=f.cache.get(),b=f.cache.get();await tick();assert.equal(f.tasks.length,1);
  const first={id:'A'};f.tasks[0].resolve(first);assert.equal(await a,first);assert.equal(await b,first);assert.equal(await f.cache.get(),first);assert.equal(f.timers.size,0);f.cache.close();
  const g=fixture(),failed=observe(g.cache.get());await tick();g.tasks[0].reject(Error('unavailable'));assert((await failed).error);
  const retry=g.cache.get();await tick();assert.equal(g.tasks.length,2);g.tasks[1].resolve(first);assert.equal(await retry,first);g.cache.close();
});
test('refresh, new callers and late old-identity failures share a single replacement',async()=>{
  const f=fixture(),a={id:'A'},b={id:'B'};const first=f.cache.get();await tick();f.tasks[0].resolve(a);await first;
  const one=f.cache.refreshAfterEmpty(a),two=f.cache.refreshAfterEmpty(a),newCaller=f.cache.get();await tick();assert.equal(f.tasks.length,2);
  f.tasks[1].resolve(b);assert.deepEqual(await Promise.all([one,two,newCaller]),[b,b,b]);
  assert.equal(await f.cache.refreshAfterEmpty(a),b);assert.equal(f.tasks.length,2);
  await assert.rejects(f.cache.refreshAfterEmpty(b),{code:'PLAYBACK_IDENTITY_COOLDOWN'});
  f.advance(30000);const next=f.cache.refreshAfterEmpty(b);await tick();f.tasks[2].resolve({id:'C'});await next;f.cache.close();
});
test('refresh failure keeps the old identity and consumes cooldown even with concurrent callers',async()=>{
  const f=fixture(),a={id:'A'};const p=f.cache.get();await tick();f.tasks[0].resolve(a);await p;
  const b=observe(f.cache.refreshAfterEmpty(a)),c=observe(f.cache.refreshAfterEmpty(a));await tick();f.tasks[1].reject(Error('register failed'));
  assert((await b).error);assert((await c).error);assert.equal(await f.cache.get(),a);
  await assert.rejects(f.cache.refreshAfterEmpty(a),{code:'PLAYBACK_IDENTITY_COOLDOWN'});assert.equal(f.tasks.length,2);f.cache.close();
});
test('cancelled waiter leaves promptly without cancelling another waiter or shared registration',async()=>{
  const f=fixture(),cancelled=cancel.create();const one=observe(f.cache.get(cancelled.signal)),two=f.cache.get();await tick();cancelled.abort();
  assert.equal((await one).error.name,'AbortError');assert.equal(f.tasks[0].signal.aborted,false);f.tasks[0].resolve({id:'A'});assert.equal((await two).id,'A');f.cache.close();
});
test('registration has a total 8 second deadline and cannot install a late response',async()=>{
  const f=fixture(),p=observe(f.cache.get());await tick();const deadline=[...f.timers.values()][0];assert.equal(deadline.ms,8000);deadline.fn();
  assert.equal((await p).error.code,'ACCOUNT_DEVICE');assert.equal(f.tasks[0].signal.aborted,true);assert.equal(f.timers.size,0);
  const next=f.cache.get();await tick();f.tasks[1].resolve({id:'B'});assert.equal((await next).id,'B');f.tasks[0].resolve({id:'late-A'});await tick();assert.equal((await f.cache.get()).id,'B');f.cache.close();
});
test('shutdown cancels registration, rejects waiters and never installs a late identity',async()=>{
  const f=fixture(),p=observe(f.cache.get());await tick();f.cache.close();assert.equal((await p).error.name,'AbortError');assert.equal(f.tasks[0].signal.aborted,true);assert.equal(f.timers.size,0);
  f.tasks[0].resolve({id:'late'});await tick();await assert.rejects(f.cache.get(),{name:'AbortError'});assert.equal(f.tasks.length,1);
});
