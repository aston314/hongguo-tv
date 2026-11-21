const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {install}=require('../webos/app/webos-audio');
function fixture(saved){
 const counters={contexts:0,workers:0,observers:0,controllers:0,destroyed:0},storage=new Map(saved?[['hongguo-webos-audible-speed',saved]]:[]),listeners={},audioState={phase:'idle'};let options,rate=1,muted=false;
 function Media(){this.nativeRate=1;this.nativeDefault=1;this.nativeMuted=false;this.src='/minireel-proxy/media/'+('1'.repeat(24))+'.mp4';this.events={};}
 for(const [name,field] of [['playbackRate','nativeRate'],['defaultPlaybackRate','nativeDefault'],['muted','nativeMuted']])Object.defineProperty(Media.prototype,name,{configurable:true,get(){return this[field]},set(v){this[field]=v}});
 const video=new Media();video.getAttribute=()=>video.src;video.addEventListener=(name,cb)=>video.events[name]=cb;video.dispatchEvent=e=>{if(video.events[e.type])video.events[e.type](e);};
 const doc={hidden:false,events:{},querySelector:()=>video,addEventListener(name,fn){this.events[name]=fn;},createEvent:()=>({initCustomEvent(type,bubbles,cancelable,detail){this.type=type;this.detail=detail;}})};
 const win={HongguoWebOS:{mediaPath:v=>v},HTMLMediaElement:Media,AudioContext:function(){counters.contexts++;},OfflineAudioContext:function(){},Worker:function(){counters.workers++;},
  MutationObserver:function(){counters.observers++;this.observe=()=>{};this.disconnect=()=>{counters.observers--;};},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},addEventListener:(name,cb)=>listeners[name]=cb,
  HongguoWebOSAudioController:{create(o){counters.controllers++;options=o;return{getRate:()=>rate,setRate:v=>{rate=v;},getMuted:()=>muted,setMuted:v=>{muted=v;},sourceChanged(){},foregroundChanged(){},event(){},diagnostics:()=>({...audioState}),destroy(){counters.destroyed++;o.setNativeRate(1);o.setNativeMuted(muted);}}}}};
 const api=install(win,doc);return{win,doc,video,api,storage,counters,listeners,audioState,get options(){return options;}};
}
test('default off does not override video, construct contexts/workers, or issue audio requests',()=>{
 const f=fixture();assert.equal(f.api.isEnabled(),false);assert.deepEqual(f.counters,{contexts:0,workers:0,observers:0,controllers:0,destroyed:0});
 for(const k of ['playbackRate','defaultPlaybackRate','muted'])assert.equal(Object.hasOwn(f.video,k),false);
 f.video.playbackRate=1.5;f.video.events.play();assert.equal(f.video.playbackRate,1.5);assert.equal(f.api.diagnostics().phase,'disabled');
});
test('one persistent switch enables lazily and disabling restores original descriptors without reloading video',()=>{
 const f=fixture();const src=f.video.src;assert(f.api.choose(true));assert.equal(f.storage.get('hongguo-webos-audible-speed'),'1');assert.equal(f.api.isEnabled(),true);assert.equal(f.counters.contexts,0);
 assert(Object.hasOwn(f.video,'playbackRate'));f.api.chooseSpeed(2);assert.equal(f.video.playbackRate,2);
 assert(f.api.choose(false));assert.equal(f.api.isEnabled(),false);assert.equal(f.counters.destroyed,1);assert.equal(f.counters.observers,0);assert.equal(f.video.src,src);assert.equal(f.video.playbackRate,1);assert(!Object.hasOwn(f.video,'playbackRate'));
 const restored=fixture('1');assert.equal(restored.api.isEnabled(),true);restored.api.choose(false);
});
test('storage failure and non-webOS never enable a partially applied route',()=>{
 const f=fixture();f.win.localStorage.setItem=()=>{throw Error('quota')};assert.equal(f.api.choose(true),false);assert.equal(f.counters.controllers,0);
 const other=fixture();delete other.win.HongguoWebOS;assert.equal(install(other.win,other.doc),null);assert.equal(other.counters.controllers,0);
});
test('binary transport cancellation works without AbortController and decoder work never queues',async()=>{
 const f=fixture();f.api.choose(true);let xhr;
 f.win.XMLHttpRequest=function(){xhr=this;this.open=()=>{};this.send=()=>{};this.abort=()=>{this.aborted=true;if(this.onabort)this.onabort();};this.getResponseHeader=()=>null;};
 const c=f.options.createAbort(),pending=f.options.requestAudio('/minireel-proxy/media/'+('1'.repeat(24))+'.mp4',c.signal);await new Promise(r=>setImmediate(r));c.abort();await assert.rejects(pending,{code:'WEBOS_AUDIO_CANCELLED'});assert.equal(xhr.aborted,true);
 let complete;f.win.OfflineAudioContext.prototype.decodeAudioData=function(_,ok){complete=ok;};
 let current=true;const decoding=f.options.decode(new ArrayBuffer(3),()=>current);assert.equal(f.options.decoderBusy(),true);
 await assert.rejects(f.options.decode(new ArrayBuffer(3),()=>true),{code:'WEB_AUDIO_DECODER_BUSY'});current=false;complete({numberOfChannels:1,length:10,getChannelData:()=>new Float32Array(10)});assert.equal(await decoding,null);assert.equal(f.options.decoderBusy(),false);f.api.choose(false);
});
const tick=()=>new Promise(r=>setImmediate(r));
const mediaPath=n=>'/minireel-proxy/media/'+String(n).padStart(24,'0')+'.mp4';
function warmFixture(t){
 const f=fixture();t.after(()=>f.api.choose(false));f.api.choose(true);f.api.chooseSpeed(2);
 f.audioState.worker_ready=true;f.audioState.pcm_bytes=8*1024*1024;f.video.paused=false;
 f.reads=[];f.decodes=[];
 f.win.HongguoWebOSLocalAudio={extract(path,signal,limits){f.reads.push({path,signal,limits});return Promise.resolve({data:new ArrayBuffer(20),duration:10,channels:2});}};
 f.win.OfflineAudioContext.prototype.decodeAudioData=function(data,ok,no){f.decodes.push({data,ok,no});};
 f.complete=(index=0,channels=2,length=240000)=>f.decodes[index].ok({numberOfChannels:channels,length,sampleRate:24000,getChannelData:()=>new Float32Array(length)});
 return f;
}
test('prewarm only runs with enabled, actively playing audible speed and one reusable next episode',async t=>{
 const f=warmFixture(t);
 f.api.chooseSpeed(1);f.api.warm(mediaPath(2));await tick();assert.equal(f.reads.length,0);
 f.api.chooseSpeed(2);f.video.paused=true;f.api.warm(mediaPath(2));await tick();assert.equal(f.reads.length,0);
 f.video.paused=false;f.doc.hidden=true;f.api.warm(mediaPath(2));await tick();assert.equal(f.reads.length,0);f.doc.hidden=false;
 f.api.warm(mediaPath(2));f.api.warm(mediaPath(2));await tick();assert.equal(f.decodes.length,1);assert.equal(f.reads.length,1);
 f.complete();await tick();assert.equal(f.api.diagnostics().prewarm_state,'ready');
 // Same-source play/metadata events must not throw away the next-episode cache.
 f.video.events.play();f.video.events.loadedmetadata();
 f.video.src='';f.video.events.loadedmetadata();f.video.src=mediaPath(2);f.video.events.loadedmetadata();
 const audio=await f.options.requestAudio(mediaPath(2),f.options.createAbort().signal);
 assert(audio.decoded);assert.equal(audio.data,undefined,'encoded track is not retained alongside PCM');
 assert.equal(f.reads.length,1);assert.equal(f.decodes.length,1);assert.equal(f.api.diagnostics().prewarm_hits,1);
});
test('aborting a prefetch or entering background drops PCM, and a late decoder cannot warm another source',async t=>{
 for(const reason of ['cancel','background','speed','source','disable']){
  const f=warmFixture(t),c=f.options.createAbort();f.api.warm(mediaPath(2),c.signal);await tick();
  assert.equal(f.decodes.length,1);
  if(reason==='cancel')c.abort();
  if(reason==='background'){f.doc.hidden=true;f.doc.events.visibilitychange();}
  if(reason==='speed')f.api.chooseSpeed(1);
  if(reason==='source'){f.video.src=mediaPath(3);f.video.events.loadedmetadata();}
  if(reason==='disable')f.api.choose(false);
  assert.equal(f.reads[0].signal.aborted,true,reason);f.complete();await tick();
  assert.notEqual(f.api.diagnostics().prewarm_state,'ready',reason);assert.equal(f.options.decoderBusy(),false);
 }
});
test('a foreground handoff waits for its prewarm and cancels promptly when decode cannot be interrupted',async t=>{
 const f=warmFixture(t);f.api.warm(mediaPath(2));await tick();
 assert.equal(f.options.decoderBusy(),false,'foreground must be allowed to adopt an active warm decode');
 const c=f.options.createAbort(),result=f.options.requestAudio(mediaPath(2),c.signal);c.abort();
 await assert.rejects(result,{code:'WEBOS_AUDIO_CANCELLED'});assert.equal(f.reads[0].signal.aborted,true);
 f.complete();await tick();assert.equal(f.api.diagnostics().prewarm_hits,0);
});
test('switching to another drama waits for the cancelled native decoder before reading a new track',async t=>{
 const f=warmFixture(t);f.api.warm(mediaPath(2));await tick();
 const c=f.options.createAbort(),pending=f.options.requestAudio(mediaPath(3),c.signal);await tick();
 assert.equal(f.reads[0].signal.aborted,true);assert.equal(f.reads.length,1);
 f.complete();const audio=await pending;assert.equal(f.reads.length,2);assert.equal(audio.local,true);assert(!audio.decoded);
});
test('prewarm budgets include current PCM, both native/copy buffers and encoded Range spans',async t=>{
 const f=warmFixture(t);f.audioState.pcm_bytes=62*1024*1024;f.api.warm(mediaPath(2));await tick();
 assert.equal(f.decodes.length,0);assert.equal(f.reads[0].limits.maxPCMBytes,1*1024*1024);assert.equal(f.reads[0].limits.maxReadBytes,16*1024*1024);
 f.audioState.pcm_bytes=0;f.api.warm(mediaPath(2));await tick();assert.equal(f.decodes.length,1);
 f.complete(0,2,5*1024*1024);await tick();assert.equal(f.api.diagnostics().prewarm_state,'skipped');
});
test('failed background extraction falls back to the existing foreground path once',async t=>{
 const f=warmFixture(t);f.win.HongguoWebOSLocalAudio.extract=async()=>{throw Error('offline');};
 f.api.warm(mediaPath(2));await tick();assert.equal(f.api.diagnostics().prewarm_state,'skipped');
 f.win.HongguoWebOSLocalAudio.extract=async()=>({data:new ArrayBuffer(1),duration:1,channels:1});
 const audio=await f.options.requestAudio(mediaPath(2),f.options.createAbort().signal);assert.equal(audio.local,true);assert(!audio.decoded);
});
const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
test('other platform bundles do not load the webOS audio scripts',()=>{
 const html=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'),'utf8');assert(!/src=["'][^"']*webos-(audio|wsola)/.test(html));
});
function element(hidden=false){
 const classes=new Set(hidden?['is-hidden']:[]),attrs={},events={};
 return {attrs,events,children:[],style:{},textContent:'',classList:{contains:c=>classes.has(c),add:c=>classes.add(c),remove:c=>classes.delete(c),toggle(c,value){if(value)classes.add(c);else classes.delete(c);}},getAttribute:k=>attrs[k]??null,hasAttribute:k=>Object.hasOwn(attrs,k),setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k],addEventListener:(k,fn)=>events[k]=fn,appendChild(n){this.children.push(n);},querySelector(){return this.children.find(n=>/is-selected/.test(n.className))||this.children[0]||element();},dataset:{}};
}
function pageFixture(f,webosShell=true){
 const elements={'hero-video':f.video,'webos-audio-settings':element(true),'webos-audio-toggle':element(),'control-progress':element()},speed=element();let saved=0,updates=0,focus=null,closed=0;
 const c={window:{HongguoWebOSAudio:f.api},webosShell,androidShell:false,desktopShell:!webosShell,episodePrefetchPlatform:()=>webosShell?'webos':'desktop',HongguoEpisodePrefetchSettings:require('../core/cmd/hongguotv/ui/episode-prefetch-settings.js'),document:{getElementById:id=>elements[id]||(elements[id]=element()),querySelector:selector=>selector==='[data-action="speed"]'?speed:element(),createElement:()=>element()},media:f.video,
  uiText:(_,text)=>text,showNotice(){},updatePlaybackControls(){updates++;},savePlaybackPreferences(){saved++;},playbackPreferences:{speed:2,quality:'',volume:100},playbackSpeeds:[.5,.75,1,1.25,1.5,2],initRecommendationAutoCinemaSettings(){},
  playerOptionsOpen:false,isPlaybackPage:()=>true,revealControls(){},clearTimeout(){},controlsTimer:null,closePlayerOptions(){closed++;},goFocus:n=>{focus=n;},playbackAudioHold:null,playbackQuality:'',clockText:String,setControlIcon(){},shell:{classList:{contains:()=>false}},setPlaybackMuted(){},updateDanmakuButton(){},localStorage:{getItem:()=>'{"speed":2,"volume":100}'}};
 const a=source.indexOf('  function playbackSpeedAvailable(');
 c.window.HongguoDesktop={platform:'preview'};
 vm.runInNewContext(source.slice(source.indexOf('  function hasDesktopFullscreenWindow('),source.indexOf('  function setCinema(')),c);
 vm.runInNewContext(source.slice(a,source.indexOf('  function updatePlaybackControls(',a)),c);
 const settings=source.indexOf('  var webosAudio = webosShell');vm.runInNewContext(source.slice(settings,source.indexOf('  var licenses =',settings)),c);
 const listener=source.indexOf("  media.addEventListener('webosaudioenabledchange'");vm.runInNewContext(source.slice(listener,source.indexOf("  media.addEventListener('ratechange'",listener)),c);
 return {c,elements,speed,get saved(){return saved;},get updates(){return updates;},get focus(){return focus;},get closed(){return closed;}};
}
test('webOS users can enable the visible experiment and disable it without losing toggle focus',()=>{
 const f=fixture(),p=pageFixture(f),toggle=p.elements['webos-audio-toggle'];
 assert.equal(p.elements['webos-audio-settings'].classList.contains('is-hidden'),false);assert.equal(toggle.attrs['aria-pressed'],'false');assert.equal(p.c.playbackSpeedAvailable(),false);assert.equal(f.counters.controllers,0);
 toggle.events.click();assert.equal(f.api.isEnabled(),true);assert.equal(p.c.playbackSpeedAvailable(),true);assert.equal(toggle.attrs['aria-pressed'],'true');assert.equal(toggle.textContent,'已开启');assert.equal(f.storage.get('hongguo-webos-audible-speed'),'1');assert.equal(p.closed,0);assert.equal(p.focus,null);
 toggle.events.click();assert.equal(f.api.isEnabled(),false);assert.equal(toggle.attrs['aria-pressed'],'false');assert.equal(p.c.playbackPreferences.speed,1);assert.equal(p.saved,1);assert.equal(p.c.playbackSpeedAvailable(),false);assert.equal(p.focus,null);
});
test('opening webOS settings keeps the enabled state and other platforms or unsupported devices hide the setting',()=>{
 const restored=fixture('1'),p=pageFixture(restored);assert.equal(restored.api.isEnabled(),true);assert.equal(p.elements['webos-audio-toggle'].attrs['aria-pressed'],'true');
 const other=pageFixture(fixture(),false);assert.equal(other.elements['webos-audio-settings'].classList.contains('is-hidden'),true);assert.equal(other.c.playbackSpeedAvailable(),true);
 const unsupported=fixture();unsupported.api.supported=false;const u=pageFixture(unsupported);assert.equal(u.elements['webos-audio-settings'].classList.contains('is-hidden'),true);assert.equal(u.c.playbackSpeedAvailable(),false);restored.api.choose(false);
});
test('restoring playback preferences preserves enabled webOS speed and keeps opt-out playback at 1x',()=>{
 const a=source.indexOf('  function restorePlaybackPreferences('),body=source.slice(a,source.indexOf('  function cancelDiagnosticRead(',a));
 const enabled=fixture('1'),p=pageFixture(enabled);vm.runInNewContext(body,p.c);p.c.restorePlaybackPreferences();assert.equal(enabled.api.isEnabled(),true);assert.equal(p.c.playbackPreferences.speed,2);assert.equal(enabled.video.playbackRate,2);
 const off=fixture(),o=pageFixture(off);vm.runInNewContext(body,o.c);o.c.restorePlaybackPreferences();assert.equal(off.video.playbackRate,1);assert.equal(off.api.isEnabled(),false);
 const desktop=fixture(),d=pageFixture(desktop,false);vm.runInNewContext(body,d.c);d.c.restorePlaybackPreferences();assert.equal(desktop.video.playbackRate,2);assert.equal(desktop.api.isEnabled(),false);enabled.api.choose(false);
});
test('the actual player control shows speed only after opt-in on webOS, and remains visible elsewhere',()=>{
 const a=source.indexOf('  function updatePlaybackControls('),body=source.slice(a,source.indexOf('  function savePlaybackPreferences(',a));
 const f=fixture(),p=pageFixture(f);vm.runInNewContext(body,p.c);p.c.updatePlaybackControls();assert.equal(p.speed.classList.contains('is-hidden'),true);assert.equal(p.speed.attrs['aria-hidden'],'true');
 p.elements['webos-audio-toggle'].events.click();assert.equal(p.speed.classList.contains('is-hidden'),false);assert.equal(p.speed.attrs['aria-hidden'],undefined);assert.equal(p.speed.attrs.tabindex,undefined);
 p.elements['webos-audio-toggle'].events.click();assert.equal(p.speed.classList.contains('is-hidden'),true);
 const d=pageFixture(fixture(),false);vm.runInNewContext(body,d.c);d.c.updatePlaybackControls();assert.equal(d.speed.classList.contains('is-hidden'),false);
});
test('the actual webOS speed menu accepts remote selection after opt-in and uses the audio route',()=>{
 const f=fixture(),p=pageFixture(f),a=source.indexOf('  function openPlayerOptions(');vm.runInNewContext(source.slice(a,source.indexOf('  function seekTo(',a)),p.c);
 p.c.openPlayerOptions('speed',p.speed);assert.equal(p.elements['player-options'],undefined);
 p.elements['webos-audio-toggle'].events.click();p.c.openPlayerOptions('speed',p.speed);
 const list=p.elements['player-options-list'];assert.equal(list.children.length,6);assert.equal(p.focus.textContent,'1x');
 const option=list.children.find(n=>n.textContent==='1.5x');option.events.click();assert.equal(f.video.playbackRate,1.5);assert.equal(f.video.nativeRate,1);assert.equal(p.c.playbackPreferences.speed,1.5);assert.equal(p.saved,1);assert.equal(p.closed,1);f.api.choose(false);
});
test('actual remote focus graph enters the experiment and returns from update controls',()=>{
 const cinema={},audio={},updates={},sidebar={};const c={coreConnectionModalOpen:false,scanModalOpen:()=>false,supportModalOpen:false,confirmOpen:false,rankFilterOpen:false,playerOptionsOpen:false,detailModalOpen:false,discussionOpen:false,
 zoneOf:n=>n===cinema?'autoCinema':n===audio?'webosAudio':'appUpdates',firstVisible:s=>({'.webos-audio-action':audio,'.auto-cinema-action':cinema,'.app-update-action':updates})[s]||null,activeSidebar:()=>sidebar};
 const a=source.indexOf('  function moveFrom(');vm.runInNewContext(source.slice(a,source.indexOf('  function accountKeypadOpen(',a)),c);
 assert.equal(c.moveFrom(cinema,'down'),audio);assert.equal(c.moveFrom(audio,'up'),cinema);assert.equal(c.moveFrom(audio,'down'),updates);assert.equal(c.moveFrom(updates,'up'),audio);assert.equal(c.moveFrom(audio,'left'),sidebar);
});
