const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create, normalize, blur} = require('../core/cmd/hongguotv/ui/portrait-backdrop.js');

function fixture({native = false, cost = 0, tainted = false} = {}) {
  let time = 10000, seq = 0, jobs = [], reads = 0, images = [];
  const listeners = {}, classes = new Set(), requests = [], draws = [];
  const state = {key:'owner:1:episode', width:360, height:640, native, nativeId:'load_1', paused:false, seeking:false, visible:true};
  const rect = {width:1280, height:720};
  const context = {
    drawImage(...args) { draws.push(args); }, clearRect() {}, fillRect() {},
    createLinearGradient() { return {addColorStop() {}}; },
    getImageData(x,y,w,h) { reads++; if (tainted) throw Error('SecurityError'); time += cost; return {data:new Uint8ClampedArray(w*h*4).fill(200)}; },
    putImageData() {}
  };
  const canvas = {width:0, height:0, parentNode:{getBoundingClientRect:()=>rect}, getContext:()=>context,
    classList:{add:n=>classes.add(n), remove:n=>classes.delete(n)}};
  const media = {addEventListener(n,fn) {(listeners[n] ||= []).push(fn);}, removeEventListener(n,fn) {listeners[n]=listeners[n].filter(x=>x!==fn);}};
  const options = {canvas, media, video:{videoWidth:360, videoHeight:640}, snapshot:()=>state,
    createCanvas:()=>({getContext:()=>context}), createImage:()=>{const img={naturalWidth:108,naturalHeight:192};images.push(img);return img;},
    requestNative:(id,ticket)=>{requests.push({id,ticket});return true;}, now:()=>time,
    setTimeout:(fn,delay)=>{const id=++seq;jobs.push({id,fn,at:time+delay});return id;}, clearTimeout:id=>{jobs=jobs.filter(j=>j.id!==id);}};
  const api = create(options);
  return {api,state,rect,canvas,classes,requests,draws,images,options,
    reads:()=>reads, jobs:()=>jobs.length,
    emit:n=>(listeners[n]||[]).slice().forEach(fn=>fn()),
    advance(ms) {const end=time+ms;let next,turns=0;while((next=jobs.filter(j=>j.at<=end).sort((a,b)=>a.at-b.at||a.id-b.id)[0])){assert.ok(++turns<100);jobs=jobs.filter(j=>j!==next);time=next.at;next.fn();}time=Math.max(time,end);},
    reply(req=requests.at(-1),data='data:image/jpeg;base64,AAAA') {api.receive(req.id,req.ticket,data,9/16);},
    load() {images.at(-1).onload();}
  };
}

test('black default and landscape never start frame work',()=>{
  const f=fixture();f.api.update();f.advance(10000);assert.equal(f.reads(),0);assert.equal(f.jobs(),0);
  assert.equal(normalize('unknown'),'black');f.state.width=1920;f.state.height=1080;f.api.setMode('blur');f.advance(10000);assert.equal(f.reads(),0);
});
test('HTML5 captures only live portrait pixels, caps output size, and stops on pause',()=>{
  const f=fixture();f.api.setMode('blur');f.advance(1000);assert.equal(f.reads(),1);assert.ok(f.classes.has('is-visible'));
  assert.equal(f.canvas.width,1280);assert.equal(f.canvas.height,720);assert.equal(f.draws[0][0],f.options.video);
  f.state.paused=true;f.emit('pause');f.advance(5000);assert.equal(f.reads(),1);assert.equal(f.jobs(),0);assert.ok(f.classes.has('is-visible'));
  f.state.paused=false;f.emit('playing');f.advance(1000);assert.equal(f.reads(),2);
  f.state.visible=false;f.emit('timeupdate');assert.equal(f.canvas.width,0);assert.equal(f.jobs(),0);
});
test('source replacement drops delayed native response and delayed image decode',()=>{
  const f=fixture({native:true});f.api.setMode('blur');f.advance(1000);const old=f.requests[0];f.reply();const staleLoad=f.images[0].onload;
  f.state.key='owner:2:new';f.state.nativeId='load_2';f.emit('emptied');f.emit('playing');f.advance(1000);
  staleLoad();assert.equal(f.reads(),0);f.reply(old);assert.equal(f.images.length,1);
  f.reply();f.load();assert.equal(f.reads(),1);assert.ok(f.classes.has('is-visible'));
});
test('native requests are single flight, reject duplicate replies and time out with a bounded retry budget',()=>{
  const f=fixture({native:true});f.api.setMode('blur');f.advance(1000);f.emit('timeupdate');f.advance(1000);assert.equal(f.requests.length,1);
  f.reply();f.reply();assert.equal(f.images.length,1);f.load();assert.equal(f.reads(),1);
  f.advance(9000);assert.equal(f.requests.length,4);assert.equal(f.api.diagnostics().disabled,'capture_timeout');assert.equal(f.jobs(),0);
  f.api.reset();f.api.update();f.advance(5000);assert.equal(f.requests.length,4,'lifecycle resets do not reopen the failed source budget');
  f.state.key='owner:2:next';f.api.update();f.advance(1000);assert.equal(f.requests.length,5,'new episode gets its own budget');
});
test('native load id and native to HTML5 fallback reject stale frames even with same media identity',()=>{
  for(const change of [s=>s.nativeId='load_2',s=>s.native=false,s=>s.paused=true,s=>s.visible=false]) {
    const f=fixture({native:true});f.api.setMode('blur');f.advance(1000);change(f.state);f.reply();assert.equal(f.images.length,0);assert.equal(f.reads(),0);
  }
});
test('failed image construction and tainted HTML5 canvas degrade to black without media mutations',()=>{
  const f=fixture({native:true});f.api.setMode('blur');f.options.createImage=()=>{throw Error('no memory');};
  for(let i=0;i<3;i++){f.advance(1000);assert.doesNotThrow(()=>f.reply());}
  assert.equal(f.api.diagnostics().disabled,'image_unavailable');assert.equal(f.jobs(),0);
  const h=fixture({tainted:true});h.api.setMode('blur');h.advance(4000);assert.equal(h.reads(),3);assert.equal(h.canvas.width,0);assert.equal(h.api.diagnostics().disabled,'capture_unavailable');
  assert.deepEqual(Object.keys(h.options.video),['videoWidth','videoHeight']);
});
test('slow decoration backs off and disables without repeated work; user toggle can explicitly retry',()=>{
  const f=fixture({cost:30});f.api.setMode('blur');f.advance(1100);assert.equal(f.api.diagnostics().interval_ms,2000);
  f.advance(5000);assert.equal(f.reads(),3);assert.equal(f.api.diagnostics().disabled,'paint_budget');assert.equal(f.canvas.width,0);
  f.emit('seeking');f.state.seeking=false;f.emit('seeked');f.api.layout();f.advance(5000);assert.equal(f.reads(),3);
  f.api.setMode('black');assert.equal(f.jobs(),0);f.api.setMode('blur');f.advance(1100);assert.equal(f.reads(),4);
  const verySlow=fixture({cost:90});verySlow.api.setMode('blur');verySlow.advance(1200);assert.equal(verySlow.reads(),1);assert.equal(verySlow.jobs(),0);
});
test('layout changes invalidate pending images and repeated same layout does not cancel next capture',()=>{
  const f=fixture({native:true});f.api.setMode('blur');f.api.layout();f.advance(1000);f.reply();const late=f.images[0].onload;
  f.rect.width=800;f.api.layout();late();assert.equal(f.reads(),0);f.api.layout();f.advance(1000);f.reply();f.load();assert.equal(f.canvas.width,800);
  f.api.destroy();f.emit('playing');f.advance(5000);assert.equal(f.jobs(),0);assert.equal(f.canvas.width,0);
});
test('small-image blur spreads sharp edges and dims uniformly without transparent holes',()=>{
  const pixels=new Uint8ClampedArray(32*16*4);for(let y=0;y<16;y++)for(let x=16;x<32;x++){const i=(y*32+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=255;}
  blur(pixels,32,16);assert.ok(pixels[(8*32+15)*4]>0);assert.ok(pixels[(8*32+16)*4]<158);
  for(let i=3;i<pixels.length;i+=4)assert.equal(pixels[i],255);
});
