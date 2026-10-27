const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {attach,zoneAt}=require('../core/cmd/hongguotv/ui/playback-pointer.js');
const app=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
function fixture(){
 const handlers={},actions=[];let enabled=true;
 const surface={rect:{left:80,top:60,width:800,height:450},getBoundingClientRect(){return this.rect},
  addEventListener(n,fn){handlers[n]=fn},removeEventListener(n){delete handlers[n]}};
 const dispose=attach(surface,{isEnabled:()=>enabled,onSeek:d=>actions.push(d),onTogglePlayback:()=>actions.push('play'),onToggleControls:()=>actions.push('controls')});
 function fire(type,x,y,detail=1,extra={}){let prevented=false;const r=surface.rect;
  handlers[type]({clientX:r.left+r.width*x,clientY:r.top+r.height*y,detail,button:0,target:{closest:()=>null},
   preventDefault(){prevented=true},...extra});return prevented;}
 function double(x,y){fire('click',x,y);fire('click',x,y,2);fire('dblclick',x,y,2)}
 return {actions,surface,handlers,fire,double,dispose,disable(){enabled=false}};
}
test('left and right double-clicks seek once without toggling playback or controls',()=>{
 const f=fixture();f.double(.1,.5);f.double(.9,.5);assert.deepEqual(f.actions,[-10,10]);
});
test('side single clicks are inert; centre click acts immediately and double click only toggles once',()=>{
 const f=fixture();f.fire('click',.1,.5);f.fire('click',.9,.5);assert.deepEqual(f.actions,[]);
 f.double(.5,.5);assert.deepEqual(f.actions,['play']);
});
test('unspecified blank area toggles controls once per single click, never seeks or pauses',()=>{
 const f=fixture();f.fire('click',.5,.1);f.fire('click',.5,.1);assert.deepEqual(f.actions,['controls','controls']);
 f.actions.length=0;f.double(.5,.9);assert.deepEqual(f.actions,['controls']);
});
test('zones follow a resized/offset surface and the centre remains a square',()=>{
 for(const rect of [{left:80,top:60,width:800,height:450},{left:0,top:0,width:1920,height:1080},{left:300,top:50,width:360,height:640}]){
  const at=(x,y)=>zoneAt(rect,rect.left+rect.width*x,rect.top+rect.height*y);
  assert.equal(at(.1,.5),'back');assert.equal(at(.9,.5),'forward');assert.equal(at(.5,.5),'play');assert.equal(at(.5,.1),'controls');
  const half=Math.min(rect.width*.22,rect.height*.36)/2;
  assert.equal(zoneAt(rect,rect.left+rect.width/2+half+1,rect.top+rect.height/2),'controls');
  assert.equal(zoneAt(rect,rect.left+rect.width/2,rect.top+rect.height/2+half+1),'controls');
  assert.equal(at(-.1,.5),'');assert.equal(at(.5,1.1),'');
 }
 const f=fixture();f.surface.rect={left:0,top:0,width:1920,height:1080};f.double(.9,.5);assert.deepEqual(f.actions,[10]);
});
test('buttons, nested icons, sliders, modal content and editable controls retain their events',()=>{
 const f=fixture();const target={closest:()=>({tagName:'BUTTON'})};
 assert.equal(f.fire('click',.5,.5,1,{target}),false);
 f.fire('click',.9,.5,1,{target});f.fire('click',.9,.5,2,{target});f.fire('dblclick',.9,.5,2,{target});assert.deepEqual(f.actions,[]);
});
test('disabled, prevented, modified, secondary and keyboard clicks never trigger pointer actions',()=>{
 for(const extra of [{defaultPrevented:true},{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{button:2}]){
  const f=fixture();f.fire('click',.5,.5,1,extra);assert.deepEqual(f.actions,[]);
 }
 const f=fixture();f.fire('click',.5,.5,0);f.disable();f.double(.9,.5);f.fire('click',.5,.5);assert.deepEqual(f.actions,[]);
});
test('a double click crossing zones cannot seek; detached listeners do not remain installed',()=>{
 const f=fixture();f.fire('click',.1,.5);f.fire('click',.9,.5,2);f.fire('dblclick',.9,.5,2);assert.deepEqual(f.actions,[]);
 f.dispose();assert.deepEqual(Object.keys(f.handlers),[]);
});
test('seek integration clamps at video boundaries and keeps a paused video paused',()=>{
 const video={currentTime:5,duration:90,paused:true};let reveals=0;
 const feedback=[];
 const c=vm.createContext({document:{getElementById:()=>video},activePlayback:{},updatePlaybackControls(){},revealControls(){reveals++},showPlaybackFeedback:action=>feedback.push(action)});
 vm.runInContext(app.slice(app.indexOf('  function seekTo('),app.indexOf('  function syncNativePlayerBounds(')),c);
 assert.equal(c.seekBy(-10,false),true);assert.equal(video.currentTime,0);
 video.currentTime=85;c.seekBy(10,false);assert.equal(video.currentTime,89.75);
 video.duration=NaN;assert.equal(c.seekBy(10,false),false);
 assert.equal(video.paused,true);assert.equal(reveals,0);
 assert.deepEqual(feedback,['back','forward']);
});
test('manually hidden controls stay hidden on pointer movement; explicit reveal restores hover behaviour',()=>{
 const listeners={};let reveals=0;
 const c=vm.createContext({document:{addEventListener:(n,f)=>listeners[n]=f},window:{PointerEvent:true},controlsManuallyHidden:true,isPlaybackPage:()=>true,revealControls(){reveals++}});
 const line=app.split('\n').find(l=>l.includes("document.addEventListener(window.PointerEvent ? 'pointermove'"));
 vm.runInContext(line,c);listeners.pointermove({target:{closest:()=>true}});assert.equal(reveals,0);
 c.controlsManuallyHidden=false;listeners.pointermove({target:{closest:()=>true}});assert.equal(reveals,1);
});

test('feedback reuses three noninteractive overlays, replaces timers and clears after its duration',()=>{
 const {createFeedback}=require('../core/cmd/hongguotv/ui/playback-pointer.js');
 const nodes=[],tasks=new Map();let next=0;
 const doc={createElement(){const classes=new Set(),attrs={};return {attrs,classes,setAttribute(k,v){attrs[k]=v},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},offsetWidth:76}}};
 const fx=createFeedback({ownerDocument:doc,appendChild:n=>nodes.push(n)}, {setTimeout(fn,ms){const id=++next;tasks.set(id,{fn,ms});return id},clearTimeout:id=>tasks.delete(id)});
 fx.show('play');assert.equal(nodes.length,1);assert.equal(nodes[0].attrs['aria-hidden'],'true');assert.equal([...tasks.values()][0].ms,700);
 fx.show('pause');assert.equal(nodes.length,1);assert.equal(tasks.size,1);assert.match(nodes[0].innerHTML,/M6 5h4/);
 fx.show('back');fx.show('forward');assert.equal(nodes.length,3);assert.match(nodes[1].innerHTML,/10 秒/);assert.match(nodes[2].innerHTML,/10 秒/);
 fx.show('unknown');assert.equal(nodes.length,3);
 for(const task of [...tasks.values()])task.fn();assert.ok(nodes.every(n=>!n.classes.has('is-visible')));
 fx.show('play');fx.show('back');fx.clear();assert.ok(nodes.every(n=>!n.classes.has('is-visible')));
});

test('manual playback feedback reflects success and does not announce a blocked or replaced source',async()=>{
 const video={src:'a',paused:true,pause(){this.paused=true}};const feedback=[],notices=[];let resolve,reject;
 const c=vm.createContext({document:{getElementById:()=>video},showPlaybackFeedback:a=>feedback.push(a),showNotice:n=>notices.push(n),
  uiText:(_k,fallback)=>fallback,isPlaybackPage:()=>true,playMedia:()=>new Promise((a,b)=>{resolve=a;reject=b})});
 vm.runInContext(app.slice(app.indexOf('  function toggleVideo('),app.indexOf('  function activatePage(')),c);
 c.toggleVideo();assert.deepEqual(feedback,[]);video.paused=false;resolve();await new Promise(r=>setImmediate(r));assert.deepEqual(feedback,['play']);
 c.toggleVideo();assert.deepEqual(feedback,['play','pause']);
 c.toggleVideo();reject(new Error('blocked'));await new Promise(r=>setImmediate(r));assert.equal(notices.length,1);assert.equal(feedback.length,2);
 c.toggleVideo();video.src='b';video.paused=false;resolve();await new Promise(r=>setImmediate(r));assert.equal(feedback.length,2);
});

test('a failed decorative overlay cannot interrupt playback controls',()=>{
 const warnings=[];
 const c=vm.createContext({desktopShell:true,playbackFeedback:null,document:{getElementById:()=>({})},
  window:{HongguoPlaybackPointer:{createFeedback(){return {show(){throw new Error('render failure')}}}}},console:{warn:(...args)=>warnings.push(args)}});
 vm.runInContext(app.slice(app.indexOf('  function showPlaybackFeedback('),app.indexOf('  function toggleVideo(')),c);
 assert.doesNotThrow(()=>c.showPlaybackFeedback('pause'));assert.equal(warnings.length,1);
});
