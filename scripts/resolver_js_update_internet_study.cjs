'use strict';
const fs=require('node:fs'),cp=require('node:child_process');
const evidenceRoot=process.env.RESOLVER_JS_EVIDENCE_DIR||'/tmp/hongguo-js-update-lab';fs.mkdirSync(evidenceRoot,{recursive:true});
const expectedRevision=Number(process.env.RESOLVER_JS_EXPECT_REVISION||101);
const serial=process.argv[2],port=Number(process.argv[3]),pkg='rocks.aston.hongguoresolverjsdiag';
function adb(...a){return cp.execFileSync('adb',['-P','5038','-s',serial,...a],{encoding:'utf8',timeout:30000}).trim();}
const shell=s=>adb('shell',s),pause=ms=>new Promise(r=>setTimeout(r,ms));
const outfile=evidenceRoot+'/'+serial.split(':')[0]+'-internet.json';
const evidence={serial,health:[]};
function save(){fs.writeFileSync(outfile,JSON.stringify(evidence,null,2));}
const identity=()=>shell('dumpsys package '+pkg).split('\n').filter(l=>/firstInstallTime=|lastUpdateTime=|versionCode=|versionName=/.test(l)).map(l=>l.trim());
async function json(p,data,timeout=100000){const r=await fetch('http://127.0.0.1:'+port+p,{method:data===undefined?'GET':'POST',body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error(p+' '+r.status);return r.json();}
async function launch(){
 shell('am force-stop '+pkg);shell('am start -n '+pkg+'/.ResolverDiagnosticActivity --es engine js --ez update_internet true --ez simulate_stale true');
 let first=true;
 for(let n=0;n<150;n++){
  await pause(500);
  if(first){const logs=adb('logcat','-d','-s','ResolverJSProbe:I','*:S'),ports=[...logs.matchAll(/HONGGUO_TV_READY (\d+) resolver-js-current/g)];if(!ports.length)continue;adb('forward','tcp:'+port,'tcp:'+ports.at(-1)[1]);}
  try{const h=await json('/health',undefined,1500);first=false;if(!evidence.health.length||evidence.health.at(-1).update.event!==h.update.event){evidence.health.push(h);save();console.log(serial,'INTERNET',h.update);}
  if(h.update.source==='downloaded'&&h.update.version==='2026.11.24.100'&&h.update.revision===expectedRevision)return h;
  if(h.update.event==='update_unavailable')throw Error('internet automatic update unavailable');
  }catch(e){if(String(e).includes('automatic update'))throw e;}
 }
 throw Error('internet update did not finish');
}
class CDP{
 constructor(url){this.n=0;this.calls=new Map();this.ready=new Promise((r,j)=>{this.ws=new WebSocket(url);this.ws.onopen=r;this.ws.onerror=j;this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const c=this.calls.get(m.id);if(c){this.calls.delete(m.id);m.error?c[1](Error(JSON.stringify(m.error))):c[0](m.result);}}};});}
 async send(method,params){await this.ready;return new Promise((r,j)=>{const id=++this.n;this.calls.set(id,[r,j]);this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error('WebView evaluation failed');return r.result.value;}
 close(){this.ws.close();}
}


async function observePlayback(){
 const sdk=Number(shell('getprop ro.build.version.sdk')),ps=sdk>=26?shell('ps -A -o PID,PPID,NAME,ARGS'):shell('ps');
 const line=ps.split('\n').find(l=>l.includes('libresolverjsprobe.so')&&!l.includes('grep'));if(!line)throw Error('core missing');const host=line.trim().split(/\s+/)[sdk>=26?1:2],cdpPort=port+100;
 adb('forward','tcp:'+cdpPort,'localabstract:webview_devtools_remote_'+host);
 const tabs=await(await fetch('http://127.0.0.1:'+cdpPort+'/json/list')).json();const tab=tabs.find(t=>t.type==='page');if(!tab||!tab.webSocketDebuggerUrl)throw Error('WebView target missing');
 const cdp=new CDP(tab.webSocketDebuggerUrl);await cdp.ready;
 try{
  await cdp.eval("(function(){if(typeof stop==='function')stop();window.__internetPlay=null;var v=document.getElementById('video');v.src='/media/current.mp4?internet=1';var p=v.play();if(p&&p.catch)p.catch(function(){});var start=Date.now();var timer=setInterval(function(){if(v.error||v.currentTime>=10||Date.now()-start>45000){clearInterval(timer);var q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():{};window.__internetPlay={position:v.currentTime,width:v.videoWidth,height:v.videoHeight,frames:q.totalVideoFrames||v.webkitDecodedFrameCount||0,error:v.error?v.error.code:0};v.pause();}},200);return true;})()");
  let row;for(let n=0;n<100&&!row;n++){await pause(500);row=await cdp.eval('window.__internetPlay');}
  if(!row||row.position<10||row.error||sdk>=26&&row.frames<=0)throw Error('internet module playback failed');
  if(sdk<26){for(let n=0;n<2;n++){await cdp.eval("document.getElementById('video').play();true");await pause(1300);fs.writeFileSync(evidenceRoot+'/'+serial.split(':')[0]+'-internet-play-'+n+'.png',cp.execFileSync('adb',['-P','5038','-s',serial,'exec-out','screencap','-p'],{timeout:30000}));}await cdp.eval("document.getElementById('video').pause();true");}
  return row;
 }finally{cdp.close();adb('forward','--remove','tcp:'+cdpPort);}
}

(async()=>{
 evidence.install_before=identity();
 // ADB reverse is removed: this mode must reach the public fixed GitHub fixture
 // via the app's standard proxy/direct routes, never the loopback fixture host.
 try{adb('reverse','--remove','tcp:18872');}catch(e){}
 await launch();evidence.resolve=await json('/api/resolve',{vid:'7706514645208534041'});if(!evidence.resolve.ok)throw Error('downloaded internet script did not resolve');
 evidence.media=await json('/api/run',{vid:'7702841946812714008'});if(!evidence.media.ok)throw Error('internet script media download failed');evidence.playback=await observePlayback();save();
 await launch();evidence.resolve_after_restart=await json('/api/resolve',{vid:'7706514815799282713'});if(!evidence.resolve_after_restart.ok)throw Error('internet cached restore failed');
 evidence.install_after=identity();if(JSON.stringify(evidence.install_after)!==JSON.stringify(evidence.install_before))throw Error('APK install changed');
 shell('am force-stop '+pkg);await pause(800);const sdk=Number(shell('getprop ro.build.version.sdk')),ps=sdk>=26?shell('ps -A -o PID,PPID,NAME,ARGS'):shell('ps');evidence.core_stopped=!ps.includes('libresolverjsprobe.so');if(!evidence.core_stopped)throw Error('probe core remained');evidence.completed=true;save();console.log(serial,'INTERNET COMPLETED',outfile);
})().catch(e=>{evidence.failure=String(e.stack);save();console.error(e.stack);process.exitCode=1;});
