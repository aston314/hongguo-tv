const {test}=require('node:test');
const assert=require('node:assert/strict');
const {supported,preference,choose,install}=require('../core/cmd/hongguotv/ui/windows-wasm-player.js');
function fixture(platform='windows'){
 const map=new Map(), events={},workers=[],nodes=[];
 const gl=new Proxy({COMPILE_STATUS:1,LINK_STATUS:2,getShaderParameter:()=>true,getProgramParameter:()=>true,getAttribLocation:()=>0,getUniformLocation:()=>({})},{get(o,k){return k in o?o[k]:()=>({})}});
 const classes=new Set(),attrs={};
 const dom={className:'hero-video',classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},style:{removeProperty(){}},volume:.7,muted:false,playbackRate:1,currentTime:0,paused:true,readyState:0,
  addEventListener:(name,fn)=>(events[name]||(events[name]=[])).push(fn),getAttribute:n=>attrs[n]||null,setAttribute:(n,v)=>attrs[n]=v,removeAttribute:n=>{delete attrs[n];if(n==='src')dom.src=''},load(){},play(){dom.paused=false;return Promise.resolve()},pause(){dom.paused=true},
  parentNode:{insertBefore(node){nodes.push(node)}}};
 const win={HongguoDesktop:{platform,wasmDecoder:true},document:{getElementById:id=>id==='hero-video'?dom:null,createElement:()=>({className:'',setAttribute(){},getContext:()=>gl,remove(){}})},localStorage:{getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)},Event:class {constructor(type){this.type=type}},addEventListener(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval:()=>1,clearInterval(){},
  Worker:class {constructor(){this.sent=[];this.terminated=false;workers.push(this)}postMessage(v){this.sent.push(v)}terminate(){this.terminated=true}},
  AudioContext:class {constructor(){this.currentTime=0;this.state='running';this.destination={}}createGain(){return {gain:{value:1},connect(){}}}resume(){this.state='running';return Promise.resolve()}suspend(){this.state='suspended';return Promise.resolve()}close(){this.state='closed';return Promise.resolve()}}
 };
 const settings=install(win);return {win,dom,workers,settings,nodes,proxy:win.document.getElementById('hero-video')};
}
test('Windows WASM is opt-in, saved separately, and never installs on Android/macOS/Linux/preview',()=>{
 for(const platform of ['darwin','linux','android','preview']){const f=fixture(platform);assert.equal(f.settings,null);assert.equal(f.proxy,f.dom)}
 assert.equal(supported({platform:'windows'}),false);
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 assert.equal(preference(storage),'default');assert.equal(choose(storage,'wasm'),true);assert.equal(preference(storage),'wasm');
 assert.equal(choose(storage,'invalid'),false);assert.equal(choose({getItem(){return 'wasm'},setItem(){}},'default'),false);
});
test('default playback delegates to HTML5 and creates no worker, audio context or canvas',async()=>{
 const f=fixture();f.proxy.src='http://127.0.0.1:12345/minireel-proxy/media/a.mp4';f.proxy.load();await f.proxy.play();
 assert.equal(f.dom.paused,false);assert.equal(f.proxy.src,f.dom.src);assert.equal(f.workers.length,0);assert.equal(f.nodes.length,0);
 f.proxy.volume=.2;assert.equal(f.dom.volume,.2);
});
test('the chosen mode applies to the next source; obsolete worker callbacks cannot replace its metadata',async()=>{
 const f=fixture();f.proxy.src='one';f.settings.choose('wasm');assert.equal(f.settings.current(),'default');
 f.proxy.src='http://127.0.0.1:12345/minireel-proxy/media/a.mp4';f.proxy.load();await f.proxy.play();
 const first=f.workers[0],id=first.sent[0].generation;
 first.onmessage({data:{type:'meta',generation:id,width:1920,height:1080,duration:10,audio:false}});
 assert.equal(f.proxy.videoWidth,1920);
 f.proxy.src='http://127.0.0.1:12345/minireel-proxy/media/b.mp4';f.proxy.load();
 assert.equal(first.terminated,true);first.onmessage({data:{type:'meta',generation:id,width:10,height:20,duration:50,audio:false}});
 assert.equal(f.proxy.videoWidth,1920); // old callbacks never overwrite the active source
 const next=f.workers.at(-1),nextId=next.sent[0].generation;
 next.onmessage({data:{type:'meta',generation:nextId,width:1280,height:720,duration:12,audio:false}});assert.equal(f.proxy.videoWidth,1280);
 f.proxy.removeAttribute('src');f.proxy.load();assert.equal(f.settings.diagnostics().workers,0);assert.equal(next.terminated,true);
});
test('staged history position and unchanged playback speed do not reopen the decoder recursively',()=>{
 const f=fixture();f.settings.choose('wasm');f.proxy.src='http://127.0.0.1:12345/minireel-proxy/media/a.mp4';
 f.win.HongguoNativePlaybackAdapter.setStartPosition(5);f.proxy.load();
 const first=f.workers.at(-1);assert.equal(first.sent[0].at,5);
 f.proxy.currentTime=5;f.proxy.playbackRate=1;assert.equal(f.workers.length,1);
 assert.equal(f.win.HongguoNativePlaybackAdapter.startPositionApplied(),true);
 f.proxy.removeAttribute('src');
});
test('ByteVC2 is explicitly unsupported and switching back restores the HTML5 path',()=>{
 const f=fixture();f.settings.choose('wasm');f.proxy.src='one';f.proxy.load();f.proxy.setSourceCodec('bytevc2');
 assert.equal(f.proxy.error.code,4);assert.equal(f.settings.diagnostics().workers,0);
 f.settings.choose('default');f.proxy.src='two';f.proxy.load();assert.equal(f.proxy.error,undefined);assert.equal(f.settings.current(),'default');assert.equal(f.proxy.src,'two');
});
