const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../webos/app/webos-audio-controller.js');
const wsola=require('../webos/app/webos-wsola.js');
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const source=n=>'/minireel-proxy/media/'+String(n).padStart(24,'0')+'.mp4';
function fixture(extra={}){
  let now=0,timerID=0;const timers=new Map(),requests=[],workers=[],nodes=[],failures=[],native={rate:1,muted:false},video={currentTime:1,duration:10,volume:.6,paused:false,ended:false,seeking:false,readyState:4};
  const context={currentTime:0,state:'running',destination:{},createGain(){return {gain:{setValueAtTime:v=>context.gain=v},connect(){},disconnect(){}};},
    createBuffer(channels,frames,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(frames));return{getChannelData:c=>data[c],data,sampleRate};},
    createBufferSource(){const node={connect(){},disconnect(){this.disconnected=true;},start(when){this.when=when;},stop(){this.stopped=true;}};nodes.push(node);return node;},
    resume(){this.state='running';return Promise.resolve();},suspend(){this.state='suspended';return Promise.resolve();},close(){this.state='closed';return Promise.resolve();}};
  const data={data:new ArrayBuffer(10),duration:10,channels:1};
  const pcm=Float32Array.from({length:24000*10},(_,i)=>.5*Math.sin(2*Math.PI*440*i/24000));
  const options={video,readNativeRate:()=>native.rate,setNativeRate:r=>{native.rate=r;},setNativeMuted:v=>{native.muted=v;},createContext:()=>context,
    setTimeout:(fn,delay)=>{const id=++timerID;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
    createAbort:()=>new AbortController(),requestAudio:(path,signal)=>{requests.push({path,signal});return Promise.resolve(data);},decode:async()=>({channels:[new Float32Array(pcm)],sampleRate:24000}),
    onFallback:code=>failures.push(code),createWorker(){
      const worker={messages:[],terminated:false,postMessage(message){this.messages.push(message);if(this.terminated)return;
        let reply;
        if(message.type==='load'){this.processor=wsola.create(message.channels.map(b=>new Float32Array(b)),message.sampleRate);reply={type:'ready',sourceId:message.sourceId,epoch:message.epoch};}
        if(message.type==='reset'){this.epoch=message.epoch;this.processor.reset(message.position,message.rate);}
        if(message.type==='render'){const out=this.processor.render(message.frames);reply={type:'pcm',id:message.id,epoch:message.epoch,channels:out.channels.map(c=>c.buffer),sampleRate:24000};}
        if(reply)setImmediate(()=>{if(!this.terminated&&this.onmessage)this.onmessage({data:reply});});
      },terminate(){this.terminated=true;}};workers.push(worker);return worker;
    },...extra};
  const controller=create(options);
  async function flush(){for(let i=0;i<5;i++)await tick();}
  async function advance(ms){const end=now+ms;for(let i=0;i<100;i++){
    const due=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];const target=due?due[1].at:end,delta=(target-now)/1000;
    if(context.state==='running')context.currentTime+=delta;if(!video.paused&&!video.ended&&!video.seeking)video.currentTime+=delta*native.rate;now=target;
    for(const node of nodes)if(!node.done&&!node.stopped&&node.when!==undefined&&node.buffer&&context.currentTime>=node.when+node.buffer.data[0].length/node.buffer.sampleRate){node.done=true;if(node.onended)node.onended();}
    if(!due)break;timers.delete(due[0]);due[1].fn();await flush();
  }}
  return{controller,context,video,native,requests,workers,nodes,failures,timers,options,flush,advance,data};
}
test('native 1x sound remains until external audio is ready; output pitch uses WSOLA and never two native voices',async()=>{
  const pending=deferred(),f=fixture();f.options.requestAudio=(path,signal)=>{f.requests.push({path,signal});return pending.promise;};
  f.controller.sourceChanged(source(1));f.controller.setRate(2);
  assert.equal(f.native.rate,1);assert.equal(f.native.muted,false);assert.equal(f.requests.length,1);
  pending.resolve(f.data);await f.flush();
  assert.equal(f.native.rate,1);assert.equal(f.native.muted,false);assert.equal(f.controller.diagnostics().audio_active,false);
  await f.advance(180);
  assert.equal(f.native.rate,2);assert.equal(f.native.muted,true);assert.equal(f.controller.getMuted(),false);
  assert.equal(f.controller.diagnostics().audio_active,true);assert(f.nodes.length>0);assert.equal(f.context.gain,.6);
  await f.advance(1000);assert(f.controller.diagnostics().scheduled_nodes<=4);
  assert(Math.abs(f.controller.diagnostics().sync_error_ms)<120);assert.equal(f.requests.length,1);
  f.controller.destroy();assert.equal(f.timers.size,0);
});
test('pause, seek and resume keep the existing video clock and reuse decoded audio',async()=>{
  const f=fixture();f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();await f.advance(180);
  f.video.paused=true;f.controller.event('pause');assert(f.nodes.every(n=>n.stopped));const position=f.video.currentTime;
  await f.advance(500);assert.equal(f.video.currentTime,position);
  f.video.currentTime=5;f.video.seeking=true;f.controller.event('seeking');f.video.seeking=false;f.controller.event('seeked');
  f.video.paused=false;f.controller.event('playing');await f.flush();assert.equal(f.video.currentTime,5);
  assert.equal(f.requests.length,1);assert.equal(f.workers.length,1);assert.equal(f.native.rate,2);
  f.controller.destroy();
});
test('switching episodes aborts and ignores the previous response without changing video src or position',async()=>{
  const a=deferred(),b=deferred(),f=fixture();f.options.requestAudio=(path,signal)=>{f.requests.push({path,signal});return f.requests.length===1?a.promise:b.promise;};
  f.controller.sourceChanged(source(1));f.controller.setRate(2);f.controller.sourceChanged(source(2));
  assert.equal(f.requests[0].signal.aborted,true);a.resolve(f.data);await f.flush();assert.equal(f.workers.length,0);
  b.resolve(f.data);await f.flush();assert.equal(f.workers.length,1);assert.equal(f.video.currentTime,1);
  f.controller.sourceChanged('');assert.equal(f.native.rate,1);assert.equal(f.native.muted,false);assert.equal(f.workers[0].terminated,true);
  f.controller.destroy();
});
test('mute and returning to 1x restore native audio and release worker output',async()=>{
  const f=fixture();f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();await f.advance(180);
  f.controller.setMuted(true);assert.equal(f.context.gain,0);f.controller.setMuted(false);assert.equal(f.context.gain,.6);
  f.controller.setRate(1);assert.equal(f.native.rate,1);assert.equal(f.native.muted,false);assert(f.nodes.every(n=>n.stopped));assert(f.workers[0].terminated);
  f.controller.destroy();
});
test('backgrounding silences and releases audio; foreground restores the same source without moving the video',async()=>{
  const f=fixture();f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();await f.advance(180);
  f.controller.foregroundChanged(false);assert.equal(f.native.rate,1);assert.equal(f.native.muted,true);assert(f.workers[0].terminated);
  f.video.paused=true;const position=f.video.currentTime;
  f.controller.foregroundChanged(true);await f.flush();assert.equal(f.video.currentTime,position);assert.equal(f.controller.getRate(),2);
  f.video.paused=false;f.controller.event('playing');await f.flush();await f.advance(180);assert.equal(f.native.rate,2);
  f.controller.destroy();
});
test('network, decode, unsupported rate and memory failures restore audible 1x instead of silent playback',async()=>{
  for(const kind of ['network','decode','rate','memory']){
    const f=fixture();
    if(kind==='network')f.options.requestAudio=async()=>{throw Error('network');};
    if(kind==='decode')f.options.decode=async()=>{throw Error('decode');};
    if(kind==='rate')f.options.setNativeRate=r=>{if(r!==1)throw Error('rate');f.native.rate=r;};
    if(kind==='memory')f.options.requestAudio=async()=>({...f.data,duration:1000});
    f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();await f.advance(180);
    assert.equal(f.native.rate,1,kind);assert.equal(f.native.muted,false,kind);assert.equal(f.controller.getRate(),1,kind);assert.equal(f.failures.length,1,kind);
    f.controller.event('playing');await f.flush();assert.equal(f.failures.length,1);f.controller.destroy();
  }
});
test('an unexpected AudioContext suspension recovers through 1x without keeping the video muted',async()=>{
  const f=fixture();f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();await f.advance(180);
  f.context.state='suspended';f.context.onstatechange();assert.equal(f.native.rate,1);assert.equal(f.native.muted,false);
  await f.flush();await f.advance(180);assert.equal(f.native.rate,2);assert.equal(f.controller.diagnostics().audio_active,true);f.controller.destroy();
});
test('worker ready without PCM keeps native voice and falls back once instead of becoming silent',async()=>{
  const f=fixture(),make=f.options.createWorker;
  f.options.createWorker=()=>{const w=make(),post=w.postMessage;w.postMessage=function(m){if(m.type!=='render')post.call(this,m);};return w;};
  f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();
  assert.equal(f.native.muted,false);assert.equal(f.native.rate,1);assert.equal(f.controller.diagnostics().audio_active,false);
  await f.advance(1000);assert.equal(f.native.muted,false);assert.equal(f.native.rate,1);assert.deepEqual(f.failures,['WSOLA_WORKER_TIMEOUT']);
  f.controller.setRate(2);assert.equal(f.requests.length,1,'same-source automatic callbacks cannot retry the failed route');
  f.controller.setRate(2,true);await f.flush();assert.equal(f.requests.length,2,'explicit user speed selection can retry');f.controller.destroy();
});
test('late PCM is discarded and realigned to the current video position before handoff',async()=>{
  const f=fixture(),make=f.options.createWorker;let held,post,worker;
  f.options.createWorker=()=>{worker=make();post=worker.postMessage;worker.postMessage=function(m){if(m.type==='render')held=m;else post.call(this,m);};return worker;};
  f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();await f.advance(200);
  post.call(worker,held);await f.flush();assert.equal(f.nodes.length,0);assert.equal(f.native.rate,1);assert.equal(f.native.muted,false);
  const resets=worker.messages.filter(m=>m.type==='reset');assert(resets.length>=2);assert(resets.at(-1).position>resets[0].position+.15);
  await f.advance(60);post.call(worker,held);await f.flush();await f.advance(100);
  assert.equal(f.native.rate,2);assert.equal(f.controller.diagnostics().audio_active,true);assert.deepEqual(f.failures,[]);f.controller.destroy();
});
test('ready audio can remain paused and a stuck decoder never queues another track',async()=>{
  const f=fixture();f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();f.video.paused=true;f.controller.event('pause');await f.advance(30000);
  assert.deepEqual(f.failures,[]);assert.equal(f.native.muted,false);f.controller.destroy();
  const busy=fixture({decoderBusy:()=>true});busy.controller.sourceChanged(source(1));busy.controller.setRate(2);await busy.flush();assert.equal(busy.requests.length,0);assert.equal(busy.native.rate,1);assert.deepEqual(busy.failures,['WEB_AUDIO_DECODER_BUSY']);busy.controller.destroy();
});
test('selecting a speed while paused defers audio reads until actual playback',async()=>{
  const f=fixture();f.video.paused=true;f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();assert.equal(f.requests.length,0);assert.equal(f.workers.length,0);
  f.video.paused=false;f.controller.event('playing');await f.flush();await f.advance(180);assert.equal(f.requests.length,1);assert.equal(f.native.rate,2);f.controller.destroy();
});
test('speaker output latency is compensated at handoff rather than causing repeated false resynchronization',async()=>{
  const f=fixture();f.context.outputLatency=.1;f.context.getOutputTimestamp=()=>({contextTime:Math.max(0,f.context.currentTime-.1)});
  f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();
  assert(Math.abs(f.workers[0].messages.find(m=>m.type==='reset').position-1.35)<1e-9);
  await f.advance(2000);assert.equal(f.native.rate,2);assert.deepEqual(f.failures,[]);assert(Math.abs(f.controller.diagnostics().sync_error_ms)<1);
  assert.equal(f.controller.diagnostics().output_latency_ms,100);assert.equal(f.workers[0].messages.filter(m=>m.type==='reset').length,1);f.controller.destroy();
});
test('a local audio decode failure retries the existing Service audio route once',async()=>{
  const f=fixture();let localCalls=0,fallbackCalls=0,decodes=0;
  f.options.requestAudio=async()=>{localCalls++;return {...f.data,local:true};};
  f.options.requestAudioFallback=async()=>{fallbackCalls++;return {...f.data,local:false};};
  f.options.decode=async()=>{decodes++;if(decodes===1)throw Error('WEB_AUDIO_DECODE');return {channels:[new Float32Array(24000)],sampleRate:24000};};
  f.controller.sourceChanged(source(1));f.controller.setRate(2);await f.flush();await f.advance(180);
  assert.equal(localCalls,1);assert.equal(fallbackCalls,1);assert.equal(decodes,2);assert.equal(f.native.rate,2);assert.equal(f.native.muted,true);assert.deepEqual(f.failures,[]);f.controller.destroy();
});
