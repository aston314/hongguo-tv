'use strict';
const fs=require('node:fs'),cp=require('node:child_process');
const evidenceRoot=process.env.RESOLVER_JS_EVIDENCE_DIR||'/tmp/hongguo-js-update-lab';fs.mkdirSync(evidenceRoot,{recursive:true});
const serial=process.argv[2],port=Number(process.argv[3]),apk=process.argv[4];
const pkg='rocks.aston.hongguoresolverjsdiag',lab='http://127.0.0.1:18872',base='http://127.0.0.1:'+port;
const ids=['7706514645208534041','7706514815799282713','7702841946812714008'];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const out=evidenceRoot+'/'+serial.split(':')[0]+'-update.json';
const evidence={serial,apk_sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),phases:[],media:[],memory:[]};
function save(){fs.writeFileSync(out,JSON.stringify(evidence,null,2));}
function adb(...args){return cp.execFileSync('adb',['-P','5038','-s',serial,...args],{encoding:'utf8',timeout:35000}).trim();}
function shell(s){return adb('shell',s);}
function expect(ok,msg){if(!ok)throw Error(msg);}
async function req(origin,path,data,ms=100000){const r=await fetch(origin+path,{method:data===undefined?'GET':'POST',body:data===undefined?undefined:JSON.stringify(data),headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(ms)});expect(r.ok,path+' HTTP '+r.status);return r.json();}
const get=(p,data,ms)=>req(base,p,data,ms),control=(mode,revision,extra={})=>req(lab,'/control',{mode,revision,...extra});
async function phase(label,fn){const result=await fn();evidence.phases.push({label,result});save();console.log(serial,label,JSON.stringify(result));return result;}
async function launch(){
 shell('am force-stop '+pkg);shell('am start -n '+pkg+'/.ResolverDiagnosticActivity --es engine js --ez update_lab true --ez simulate_stale true');
 for(let i=0;i<30;i++){
  await pause(500);const log=adb('logcat','-d','-s','ResolverJSProbe:I','*:S');
  const ports=[...log.matchAll(/HONGGUO_TV_READY (\d+) resolver-js-current/g)];if(!ports.length)continue;
  const remote=ports.at(-1)[1];adb('forward','tcp:'+port,'tcp:'+remote);
  try{const h=await get('/health',undefined,2000);if(h.update){evidence.remote_port=remote;return h;}}catch(e){}
 }
 throw Error('test core not ready');
}
function installIdentity(){const dump=shell('dumpsys package '+pkg);return dump.split('\n').filter(l=>/firstInstallTime=|lastUpdateTime=|versionCode=|versionName=/.test(l)).map(l=>l.trim());}
async function status(){return (await get('/health')).update;}
async function resolve(vid=ids[0]){return get('/api/resolve',{vid});}
async function check(){return get('/api/update',{});}
async function memory(label){
 const heap=await get('/memory',{}),sdk=evidence.device.sdk,ps=sdk>=26?shell('ps -A -o PID,PPID,NAME,ARGS'):shell('ps');
 const line=ps.split('\n').find(l=>l.includes('libresolverjsprobe.so')&&!l.includes('grep'));expect(line,'core PID missing');
 const tokens=line.trim().split(/\s+/),core=tokens[sdk>=26?0:1],host=tokens[sdk>=26?1:2];evidence.core=core;evidence.host=host;
 const dump=shell('dumpsys meminfo '+core),m=dump.match(/TOTAL PSS:\s+(\d+)/)||dump.match(/^\s*TOTAL\s+(\d+)/m);
 evidence.memory.push({label,heap,pss_kib:m?Number(m[1]):null});save();return evidence.memory.at(-1);
}
class CDP{
 constructor(url){this.n=0;this.calls=new Map();this.ready=new Promise((r,j)=>{this.ws=new WebSocket(url);this.ws.onopen=r;this.ws.onerror=j;this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const c=this.calls.get(m.id);if(c){this.calls.delete(m.id);m.error?c[1](Error(JSON.stringify(m.error))):c[0](m.result);}}};});}
 async send(method,params){await this.ready;return new Promise((r,j)=>{const id=++this.n;this.calls.set(id,[r,j]);this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error('WebView evaluation failed');return r.result.value;}
 close(){this.ws.close();}
}
async function playMedia(vid,index){
 const row=await get('/api/run',{vid});expect(row.ok,'real media failed '+row.code);
 await memory('media_'+index+'_prepared');
 const socket='webview_devtools_remote_'+evidence.host,cdpPort=port+100;adb('forward','tcp:'+cdpPort,'localabstract:'+socket);
 const tabs=await req('http://127.0.0.1:'+cdpPort,'/json/list');
 const tab=tabs.find(t=>t.type==='page'&&t.url.includes('127.0.0.1:'+evidence.remote_port));expect(tab&&tab.webSocketDebuggerUrl,'debug page unavailable');
 const cdp=new CDP(tab.webSocketDebuggerUrl);await cdp.ready;
 try{
  await cdp.eval(`(function(){if(typeof stop==='function')stop();window.__updatePlayback=null;var v=document.getElementById('video');v.src='/media/current.mp4?test=${index}';var p=v.play();if(p&&p.catch)p.catch(function(){});var start=Date.now();var t=setInterval(function(){if(v.error||v.currentTime>=10||Date.now()-start>45000){clearInterval(t);var q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():{};window.__updatePlayback={position:v.currentTime,width:v.videoWidth,height:v.videoHeight,decoded_frames:q.totalVideoFrames||v.webkitDecodedFrameCount||0,dropped_frames:q.droppedVideoFrames||v.webkitDroppedFrameCount||0,error:v.error?v.error.code:0};v.pause();}},200);return true;})()`);
  let playback=null;for(let n=0;n<100&&!playback;n++){await pause(500);playback=await cdp.eval('window.__updatePlayback');}
  expect(playback&&playback.position>=10&&playback.error===0,'video failed '+JSON.stringify(playback));
  if(evidence.device.sdk>=26)expect(playback.decoded_frames>0,'positive decode frames missing');
  // Old WebView has no usable frame counters; save screenshot as corroborating
  // evidence and do not interpret its zeros as zero drops or a decode failure.
  if(evidence.device.sdk<26){for(let n=0;n<2;n++){await cdp.eval("document.getElementById('video').play();true");await pause(1300);fs.writeFileSync(evidenceRoot+'/'+serial.split(':')[0]+'-media'+index+'-'+n+'.png',cp.execFileSync('adb',['-P','5038','-s',serial,'exec-out','screencap','-p'],{timeout:30000}));}await cdp.eval("document.getElementById('video').pause();true");}
  const result={...row,playback};evidence.media.push(result);save();console.log(serial,'MEDIA',index,row.codec,row.media_bytes,playback.position,playback.decoded_frames);
  await cdp.eval("(function(){var v=document.getElementById('video');v.pause();v.removeAttribute('src');v.load();return true;})()");return result;
 }finally{cdp.close();adb('forward','--remove','tcp:'+cdpPort);}
}
(async()=>{
 await control('offline',1);
 let installed=cp.spawnSync('adb',['-P','5038','-s',serial,'install','-r',apk],{encoding:'utf8',timeout:60000});
 if(installed.status!==0){expect((installed.stdout+installed.stderr).includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE'),'install failed '+installed.stdout+installed.stderr);adb('uninstall',pkg);adb('install',apk);}
 expect(shell('pm clear '+pkg).includes('Success'),'isolated package clear failed');
 if(!process.env.SKIP_ADB_REVERSE)adb('reverse','tcp:18872','tcp:18872');
 evidence.device={model:shell('getprop ro.product.model'),sdk:Number(shell('getprop ro.build.version.sdk')),abi:shell('getprop ro.product.cpu.abi')};evidence.install_before=installIdentity();
 await launch();await phase('old_embedded_fails',async()=>{const r=await resolve();expect(!r.ok&&r.code==='SIMULATED_OLD_ALGORITHM','stale test not active');return {r,status:await status()};});
 await phase('bad_signature_rejected',async()=>{await control('bad_signature',2);const r=await check();expect(!r.ok&&(await status()).source==='embedded','bad signature activated');return r;});
 await phase('good_download_activated',async()=>{await control('good',3);const r=await check();expect(r.ok&&r.update.version==='2026.11.24.3','activation failed');return r;});
 for(let i=0;i<ids.length;i++)await playMedia(ids[i],i);
 await phase('offline_restart_uses_cached_script',async()=>{await control('offline',4);await launch();const r=await resolve();expect(r.ok&&(await status()).version==='2026.11.24.3','cached restore failed');return {r,status:await status()};});
 for(const [mode,rev]of [['corrupt',5],['syntax',6],['infinite',7]])await phase(mode+'_rejected',async()=>{await control(mode,rev);const r=await check();expect(!r.ok&&(await status()).version==='2026.11.24.3','bad candidate activated');expect((await resolve()).ok,'bad candidate damaged active');return {r,status:await status()};});
 await phase('interrupted_download_preserves_active',async()=>{
  await control('slow',8,{delay_ms:15000});const pending=check().catch(e=>({interrupted:true}));await pause(500);shell('am force-stop '+pkg);await pending;await control('offline',8);await launch();const r=await resolve();expect(r.ok&&(await status()).version==='2026.11.24.3','interrupted update damaged active');return {r,status:await status()};
 });
 await phase('signed_remote_disable',async()=>{await control('disable',9);const r=await check(),p=await resolve();expect(r.ok&&r.update.source==='embedded'&&p.code==='SIMULATED_OLD_ALGORITHM','disable did not switch embedded');return {r,p};});
 await phase('disable_survives_offline_restart_and_replay',async()=>{await control('offline',9);await launch();await control('replay',3);const r=await check(),s=await status(),p=await resolve();expect(!r.ok&&s.revision===9&&!s.enabled&&p.code==='SIMULATED_OLD_ALGORITHM','old control reenabled disabled module');return {r,s,p};});
 await phase('reenable',async()=>{await control('good',10);const r=await check(),p=await resolve();expect(r.ok&&p.ok,'reenable failed');return {r,p};});
 await phase('runtime_fault_rolls_back_verified_version',async()=>{await control('broken_abi',11);const r=await check();expect(r.ok,'ABI candidate not activated');const failed=await resolve(),s=await status(),next=await resolve();expect(!failed.ok&&s.version==='2026.11.24.10'&&next.ok,'runtime rollback failed');return {r,failed,s,next};});
 await phase('rollback_survives_restart',async()=>{await control('offline',11);await launch();const s=await status(),p=await resolve();expect(s.version==='2026.11.24.10'&&s.revision===11&&p.ok,'rollback restore failed');return {s,p};});
 await phase('upstream_empty_does_not_rollback',async()=>{await control('upstream_empty',12);const r=await check(),p=await resolve(),s=await status();expect(r.ok&&p.code==='VIDEO_MODEL_EMPTY'&&s.version==='2026.11.24.12','business failure misclassified');return {r,p,s};});
 await phase('final_working_update',async()=>{await control('good',13);const r=await check(),p=await resolve();expect(r.ok&&p.ok,'final module failed');return {r,p};});
 await memory('end_gc');evidence.install_after=installIdentity();expect(JSON.stringify(evidence.install_before)===JSON.stringify(evidence.install_after),'APK changed during script updates');
 shell('am force-stop '+pkg);await pause(700);const ps=evidence.device.sdk>=26?shell('ps -A -o PID,PPID,NAME,ARGS'):shell('ps');evidence.core_stopped=!ps.includes('libresolverjsprobe.so');expect(evidence.core_stopped,'probe child remained running');
 evidence.completed=true;save();console.log(serial,'COMPLETED',out);
})().catch(e=>{evidence.failure=String(e.stack);save();console.error(e.stack);process.exitCode=1;});
