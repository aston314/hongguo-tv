'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
require('../webos/service/runtime-compat');
const verify=require('../webos/service/playback-rule-verifier'),createManager=require('../webos/service/playback-repair'),createRuntime=require('../webos/service/playback-rule-runtime');
const cancel=require('../webos/service/audio-cancel');
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
const key=publicKey.export({format:'der',type:'spki'}).subarray(-32);
function control(revision,script=Buffer.from('synthetic fixture '+revision),enabled=true,version='test.'+revision){const now=Math.floor(Date.now()/1000),hash=verify.digest(script);const manifest={schema:1,product:'hongguo-playback-resolver',revision,enabled,issued_at:now-30,expires_at:now+3600,module:enabled?{version,protocol:1,host_api:1,url:verify.root+'modules/'+hash+'.js',size:script.length,sha256:hash}:null};const payload=Buffer.from(JSON.stringify(manifest));return {manifest,envelope:{payload:payload.toString('base64'),signature:crypto.sign(null,payload,privateKey).toString('base64')},script};}
function lab(t,initial){let latest=initial,live=0,maximum=0,fail=false,answer=[{url:'https://cdn.example/episode.mp4',key:null,codec:'h265',width:1280,height:720,quality:'720P',duration:90}];const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webos-rules-'));let offline=false;
 const manager=createManager({dataDir:dir,publicKey:key,fetch:async(url,limit,accept,signal)=>{if(offline)throw Error('offline');if(signal.aborted)throw verify.fault('RESOLVER_CANCELLED');const b=url===verify.manifest?Buffer.from(JSON.stringify(latest.envelope)):latest.script;accept(b);return b;},runtimeFactory:()=>{live++;maximum=Math.max(maximum,live);let closed=false;return {load:async()=>{},resolve:async()=>{if(fail)throw verify.fault(typeof fail==='string'?fail:'RESOLVER_SCRIPT_FAILED');return answer;},close:async()=>{if(!closed){closed=true;live--;}}};}});
 t.after(async()=>{await manager.close();fs.rmSync(dir,{recursive:true,force:true});});return {manager,dir,set:v=>latest=v,offline:v=>offline=v,fail:v=>fail=v,answer:v=>answer=v,count:()=>({live,maximum})};}
test('webOS verifier accepts shared canonical Ed25519 controls and rejects tampering, replay shape and expiry',()=>{
 const c=control(1);assert.equal(verify.verify(c.envelope,{publicKey:key}).revision,1);
 const altered={...c.manifest,revision:2};assert.throws(()=>verify.verify({...c.envelope,payload:Buffer.from(JSON.stringify(altered)).toString('base64')},{publicKey:key}));
 assert.throws(()=>verify.verify({...c.envelope,extra:true},{publicKey:key}));
 assert.throws(()=>verify.verify(c.envelope,{publicKey:key,now:Date.now()+7200000}));assert.equal(verify.verify(c.envelope,{publicKey:key,stored:true,now:Date.now()+7200000}).revision,1);
 assert.equal(verify.official(verify.manifest),true);assert.equal(verify.official(verify.root+'../account.json'),false);
});
test('off creates no runtime; signed activation, verified rollback, cache preservation and remote disable are separate',async t=>{
 const a=control(1),l=lab(t,a),m=l.manager;m.start();assert.deepEqual(l.count(),{live:0,maximum:0});assert.equal(m.status().enabled,false);
 m.setEnabled(true);await m.check();assert.equal(m.status().revision,1);await m.resolve({vid:'123'});
 l.set(control(2));await m.check();assert.equal(m.status().revision,2);l.fail(true);await assert.rejects(m.resolve({vid:'123'}));assert.equal(m.status().revision,1);assert.equal(m.status().event,'rolled_back');l.fail(false);
 l.set(a);await m.check();assert.equal(m.status().revision,1,'replayed control did not replace active rollback');
 l.set(control(3,Buffer.alloc(0),false));await m.check();assert.equal(m.status().source,'native');assert.equal(m.status().event,'remote_disabled');
 l.set(a);await m.check();assert.equal(m.status().source,'native','disable high-water survives replay');
 l.set(control(4));await m.check();await m.resolve({vid:'123'});m.setEnabled(false);await m.drain();assert.equal(l.count().live,0);
 l.offline(true);m.setEnabled(true);await m.check();assert.equal(m.status().revision,4,'verified cached rule remains usable offline');assert.ok(l.count().maximum<=2);
});
test('invalid signature and interrupted cache cannot replace a verified rule or discard signed high-water',async t=>{
 const l=lab(t,control(1)),m=l.manager;m.start();m.setEnabled(true);await m.check();await m.resolve({vid:'123'});
 const bad=control(2);bad.envelope.signature=Buffer.alloc(64).toString('base64');l.set(bad);await m.check();assert.equal(m.status().revision,1);
 m.setEnabled(false);await m.drain();const s=JSON.parse(fs.readFileSync(path.join(l.dir,'playback-repair/state.json')));const a=verify.verify(s.active,{publicKey:key,stored:true}).module;fs.unlinkSync(path.join(l.dir,'playback-repair/modules',a.sha256+'.js'));
 m.setEnabled(true);await m.check();assert.equal(m.status().source,'native');assert.equal(m.control(m.state.control,true).revision,1);
});
test('upstream errors and cancellation never quarantine a rule; rapid toggles retire workers',async t=>{
 const l=lab(t,control(1)),m=l.manager;m.start();for(let i=0;i<12;i++){m.setEnabled(true);await m.check();m.setEnabled(false);await m.drain();}
 assert.equal(l.count().live,0);assert.ok(l.count().maximum<=2);
 m.setEnabled(true);await m.check();const before=m.status().revision;for(const code of ['VIDEO_MODEL_EMPTY','UPSTREAM_TIMEOUT','RESOLVER_CANCELLED']){l.fail(code);await assert.rejects(m.resolve({vid:'123'}),{code});assert.equal(m.status().revision,before);assert.deepEqual(m.state.quarantine,[]);}l.fail(false);
});
for(const runtime of [...new Set([process.execPath,process.env.WEBOS_LEGACY_NODE].filter(Boolean))])test('shared published-format rule runs in isolated worker on '+runtime,()=>{
 const p=spawnSync(runtime,[path.join(__dirname,'fixtures/webos-rule-runtime-probe.cjs')],{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH}});assert.ifError(p.error);assert.equal(p.status,0,p.stdout+p.stderr);
});
test('worker is killed on cancellation and scripts cannot perform HTTP during signing self-test',async()=>{
 const r=createRuntime(),c=cancel.create();try{
  const bad=Buffer.from("(function(){return {metadata:function(){return {name:'hongguo-playback-resolver',version:'test',protocol:1}},selfTest:function(){return __resolverHost.http('GET','https://api.fqnovel.com',{},Buffer.alloc(0),1000)}}})()");
  await assert.rejects(r.load(bad,'test',c.signal));
 }finally{await r.close();}assert.equal(r.child,null);
 const pending=createRuntime(),abort=cancel.create();try{
  const script=Buffer.from("(function(){return {metadata:function(){return {name:'hongguo-playback-resolver',version:'test',protocol:1}},selfTest:function(){return 4},resolve:function(){return new Promise(function(){})}}})()");
  await pending.load(script,'test');const work=pending.resolve({vid:'123'},abort.signal,1000);setTimeout(()=>abort.abort(),30);await assert.rejects(work,{code:'RESOLVER_CANCELLED'});assert.equal(pending.child,null);assert.equal(pending.broken,true);
 }finally{await pending.close();}
});
test('webOS repair API uses the shared controller and rejects external origins or hosts',async t=>{
 const l=lab(t,control(1)),m=l.manager;let configured;const provider={dataDirectory:()=>l.dir,setPlaybackRepair:r=>configured=r,startCache(){},closeCache(){}};
 const service=require('../webos/service/service')({provider,playbackRepair:m,account:{close(){}},watchStatistics:{},numberInput:{close(){}},phoneSearch:{close(){}},announcements:{active:async()=>[]},service:{register(){}},port:0});
 t.after(()=>service.shutdown());await service.ensureReady();assert.equal(configured,m);const port=service.address().port;
 const call=(body,headers={})=>new Promise((resolve,reject)=>{const req=require('node:http').request({host:'127.0.0.1',port,path:'/api/v1/playback/repair',method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});req.on('error',reject);req.end(JSON.stringify(body));});
 assert.equal((await call({action:'enable'},{Origin:'https://outside.example'})).status,403);assert.equal(m.status().enabled,false);
 assert.equal((await call({action:'enable'},{Host:'outside.example'})).status,403);
 assert.equal((await call({action:'enable'},{Origin:'null'})).status,200);await m.check();assert.equal(m.status().revision,1);
 assert.equal((await call({action:'restore'},{Origin:'null'})).status,200);assert.equal(m.status().enabled,false);await m.drain();assert.equal(l.count().live,0);
});
test('preference storage errors leave the existing off selection unchanged',async t=>{
 const l=lab(t,control(1)),m=l.manager;fs.mkdirSync(path.join(l.dir,'playback-repair'),{recursive:true});fs.mkdirSync(path.join(l.dir,'playback-repair/preference.json'));assert.throws(()=>m.setEnabled(true));assert.equal(m.status().enabled,false);assert.equal(l.count().live,0);
});
test('rapid off/on during an unfinished check cannot activate stale work or accumulate candidates',async t=>{
 const l=lab(t,control(1)),m=l.manager;m.start();let release;
 const read=m.options.fetch;m.options.fetch=(...args)=>new Promise(resolve=>{release=()=>resolve(read(...args));});
 m.setEnabled(true);for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release);const old=m.checkPromise;m.setEnabled(false);m.options.fetch=read;m.setEnabled(true);release();await old;await m.check();assert.equal(m.status().revision,1);assert.equal(m.status().enabled,true);assert.ok(l.count().maximum<=2);
});
test('provider uses signed options once, charges its budget, and preserves native fallback and cancellation',async()=>{
 const Module=require('node:module'),file=require.resolve('../webos/service/provider'),mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
 const source=fs.readFileSync(file,'utf8').replace('prepare: prepare,','_options: videoOptions, prepare: prepare,');mod._compile(source,file);const provider=mod.exports;
 let calls=0;provider.setPlaybackRepair({resolve:async request=>{calls++;assert.equal(request.vid,'123');return [{url:'https://cdn.example/a.mp4',codec:'h265',quality:'720P',width:1280,height:720,duration:90,key:null}];}});
 const state={};const options=await provider._options('123',null,{identityState:state});assert.equal(options[0].codec,'h265');assert.equal(state.source,'repair');assert.equal(state.repairTried,true);assert.equal(calls,1);assert.ok(state.resolveSpent>=0);
 // Replace only the provider's native network functions with a controlled
 // fixture; execute its actual source-selection and cancellation branches.
 const native=new Module(file,module);native.filename=file;native.paths=mod.paths;native._compile(source.replace("var request = provider === 'video_tab' ? videoTabOptions : single ? singleVideoOptions : mobileVideoOptions;","var request = function(){return Promise.resolve([{url:'https://cdn.example/native.mp4',codec:'h265',quality:'720P',height:720}]);};"),file);
 const p=native.exports;let attempts=0;p.setPlaybackRepair({resolve:async()=>{attempts++;throw verify.fault('VIDEO_MODEL_EMPTY');}});const s={};assert.match((await p._options('123',null,{identityState:s}))[0].url,/native/);assert.equal(attempts,1);s.cursor=0;await p._options('123',null,{identityState:s});assert.equal(attempts,1,'native retry did not restart the JS route');
 const c=cancel.create();c.abort();await assert.rejects(p._options('123',c.signal,{identityState:{}}));assert.equal(attempts,1);
});
