'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
require('../webos/service/runtime-compat');
const create=require('../webos/service/playback-profile-service'),verify=require('../webos/service/playback-rule-verifier'),profile=require('../webos/service/playback-profile'),cancel=require('../webos/service/audio-cancel');
const baseline=fs.readFileSync(path.join(__dirname,'../webos/service/playback-profile.json'));
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519'),key=publicKey.export({format:'der',type:'spki'}).subarray(-32);
function control(revision,bytes,enabled=true){const now=Math.floor(Date.now()/1000),hash=verify.digest(bytes),m={schema:1,product:'hongguo-playback-profile',revision,enabled,issued_at:now-30,expires_at:now+3600,module:enabled?{version:'p'+revision,protocol:1,host_api:1,url:verify.profileRoot+'profiles/'+hash+'.json',size:bytes.length,sha256:hash}:null},b=Buffer.from(JSON.stringify(m));return {envelope:{payload:b.toString('base64'),signature:crypto.sign(null,b,privateKey).toString('base64')},bytes};}
function changed(value){return Buffer.from(baseline.toString().replace('"value": 312','"value": '+value));}
function signature(p){const values=p.query({device_id:'123',iid:'456',cdid:'synthetic'},'789',true);return p.sign(values,Buffer.alloc(0),1800000000000,[1,2,3,4],{nonce:'synthetic',started:1800000000000,now:1800000000000,launch:110,pid:11001}).headers['X-Medusa'];}
function lab(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-profile-'));let current=control(1,changed(377)),offline=false,seen=[];
 const options={dataDir:dir,publicKey:key,fetch:async(url,limit,accept,signal,kind)=>{assert.equal(kind,'json');if(offline)throw Error('offline');const bytes=url===verify.profileManifest?Buffer.from(JSON.stringify(current.envelope)):current.bytes;accept(bytes);return bytes;},resolve:async(p,request,signal)=>{assert.equal(request.vid,'123');cancel.check(signal);seen.push(signature(p));return [{codec:'h265',quality:'1080P'}];}};
 const service=create(options);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,service,options,seen,set:v=>current=v,offline:v=>offline=v};}
for(const runtime of [...new Set([process.execPath,process.env.WEBOS_LEGACY_NODE].filter(Boolean))])test('native profile works on '+runtime,()=>{const c=spawnSync(runtime,[path.join(__dirname,'fixtures/webos-profile-probe.cjs')],{encoding:'utf8',timeout:20000});assert.ifError(c.error);assert.equal(c.status,0,c.stdout+c.stderr);});
test('JSON is automatic without a preference; update, cache, remote disable and replay are independent from JS',async t=>{
 const l=lab(t),s=l.service;s.start();await s.check();assert.equal(s.status().enabled,true);assert.equal(s.status().automatic,true);assert.equal(s.status().revision,1);assert.equal(fs.existsSync(path.join(l.dir,'playback-profile/preference.json')),false);
 await s.resolve({vid:'123'});assert.equal(l.seen.at(-1),signature(profile.parse(changed(377))));
 l.offline(true);await s.close();const restarted=create(l.options);t.after(()=>restarted.close());restarted.start();await restarted.check();await restarted.resolve({vid:'123'});assert.equal(l.seen.at(-1),signature(profile.parse(changed(377))));
 l.offline(false);l.set(control(2,baseline,false));await restarted.check();assert.equal(restarted.status().event,'remote_disabled');await restarted.resolve({vid:'123'});assert.equal(l.seen.at(-1),signature(profile.parse(baseline)));
 l.set(control(1,changed(377)));await restarted.check();assert.equal(restarted.status().source,'native');
});
test('signed invalid JSON, bad digest, wrong product and tampered signature leave usable config active',async t=>{
 const l=lab(t),s=l.service;s.start();await s.check();await s.resolve({vid:'123'});const want=l.seen.at(-1);
 for(const variant of ['type','digest','product','signature']){let v=control(2,baseline);if(variant==='type')v=control(2,Buffer.from(baseline.toString().replace('"${magic}"','"${ts}"')));if(variant==='digest')v.bytes=Buffer.from('<html>bad proxy</html>');if(variant==='product'){const m=JSON.parse(Buffer.from(v.envelope.payload,'base64'));m.product='hongguo-playback-resolver';const b=Buffer.from(JSON.stringify(m));v.envelope={payload:b.toString('base64'),signature:crypto.sign(null,b,privateKey).toString('base64')};}if(variant==='signature')v.envelope.signature=Buffer.alloc(64).toString('base64');l.set(v);await s.check();assert.equal(s.status().revision,1);await s.resolve({vid:'123'});assert.equal(l.seen.at(-1),want);}
});
test('profile URLs and proxy routes stay separated from executable rules',async t=>{
 const url=verify.profileRoot+'profiles/'+'a'.repeat(64)+'.json';assert.equal(verify.official(url,true),true);assert.equal(verify.official(verify.profileManifest,true),true);for(const bad of [verify.manifest,url+'?x=1',url.replace('.json','.js'),url.replace('profiles/','../')])assert.equal(verify.official(bad,true),false);assert.equal(verify.official(url),false);
 const network=require('../webos/service/playback-rule-network'),https=require('node:https'),{EventEmitter}=require('node:events'),original=https.request,calls=[];t.after(()=>https.request=original);
 https.request=(options,callback)=>{calls.push('https://'+options.hostname+options.path);assert.equal(options.headers.Cookie,undefined);const req=new EventEmitter();req.destroy=()=>{};req.end=()=>process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};res.destroy=()=>{};callback(res);res.emit('data',calls.length<5?Buffer.from('<html>error</html>'):Buffer.from('valid'));res.emit('end');});return req;};
 assert.equal((await network.fetch(url,100,b=>assert.equal(b.toString(),'valid'),null,'json')).toString(),'valid');assert.deepEqual(calls,['https://gh-proxy.com/','https://v4.gh-proxy.org/','https://gh-proxy.org/','https://ghfast.top/',''].map(p=>p+url));
});
test('cancellation and shutdown abort native requests without creating workers',async t=>{
 const l=lab(t);l.options.resolve=(p,r,signal)=>new Promise((resolve,reject)=>{if(signal.aborted)return reject(cancel.error(signal));signal.addEventListener('abort',()=>reject(cancel.error(signal)));});const s=create(l.options);t.after(()=>s.close());
 const parent=cancel.create(),job=s.resolve({vid:'123'},parent.signal);parent.abort();await assert.rejects(job);const pending=s.resolve({vid:'123'});const caught=assert.rejects(pending);await s.close();await caught;
});
test('an in-flight request keeps its JSON snapshot while the next request sees the update',async t=>{
 const l=lab(t),s=l.service;s.start();await s.check();let release,entered;const ready=new Promise(resolve=>entered=resolve);
 l.options.resolve=(p,r,signal)=>new Promise(resolve=>{const old=signature(p);release=()=>resolve([{codec:'h265',signature:old}]);entered();});
 // create() copies options into its manager, but baseline/active provider calls
 // use the wrapper's immutable per-call profile, even across activation.
 await s.close();const service=create(l.options);t.after(()=>service.close());service.start();await service.check();const current=service.resolve({vid:'123'});await ready;
 l.set(control(2,changed(378)));await service.check();release();assert.equal((await current)[0].signature,signature(profile.parse(changed(377))));
 l.options.resolve=async p=>[{codec:'h265',signature:signature(p)}];await service.close();const next=create(l.options);t.after(()=>next.close());next.start();await next.check();assert.equal((await next.resolve({vid:'123'}))[0].signature,signature(profile.parse(changed(378))));
});
test('provider runs optional JS, automatic JSON and original native fallback in order, only once',async()=>{
 const Module=require('node:module'),file=require.resolve('../webos/service/provider'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
 const source=fs.readFileSync(file,'utf8').replace('prepare: prepare,','_options: videoOptions, prepare: prepare,').replace("var request = provider === 'video_tab' ? videoTabOptions : single ? singleVideoOptions : mobileVideoOptions;","var request = function(){return Promise.resolve([{url:'https://cdn.example/native.mp4',height:720}]);};");m._compile(source,file);const p=m.exports,order=[];
 p.setPlaybackRepair({resolve:async()=>{order.push('js');return null;}});p.setPlaybackProfile({resolve:async()=>{order.push('json');return [{url:'https://cdn.example/profile.mp4',height:720}];}});
 const state={};assert.match((await p._options('123',null,{identityState:state}))[0].url,/profile/);assert.deepEqual(order,['js','json']);assert.equal(state.source,'repair');assert.ok(state.resolveSpent>=0);
 assert.match((await p._options('123',null,{identityState:state}))[0].url,/native/);assert.deepEqual(order,['js','json']);const abort=cancel.create();abort.abort();await assert.rejects(p._options('123',abort.signal,{identityState:{}}));assert.equal(order.length,2);p.closeCache();
});
test('service starts JSON automatically while JS is off; manual check also checks JSON',async t=>{
 const l=lab(t),p={dataDirectory:()=>l.dir,startCache(){},closeCache(){},setPlaybackProfile(value){this.profile=value;},setPlaybackRepair(value){this.repair=value;}};
 const s=require('../webos/service/service')({provider:p,playbackProfile:l.service,account:{close(){}},watchStatistics:{},numberInput:{close(){}},phoneSearch:{close(){}},announcements:{active:async()=>[]},service:{register(){}},port:0});t.after(()=>s.shutdown());await s.ensureReady();await l.service.check();assert.equal(p.profile,l.service);
 const port=s.address().port;const response=await fetch('http://127.0.0.1:'+port+'/api/v1/playback/repair');const status=(await response.json()).data;assert.equal(status.enabled,false);assert.equal(status.native_profile.automatic,true);assert.equal(status.native_profile.revision,1);
 l.set(control(2,changed(378)));assert.equal((await fetch('http://127.0.0.1:'+port+'/api/v1/playback/repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'check'})})).status,200);await l.service.check();assert.equal(l.service.status().revision,2);
});
