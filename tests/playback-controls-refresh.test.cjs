const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');

// Count writes even when the assigned value is unchanged: those are the
// redundant DOM operations this playback hot path must avoid.
function fixture({hidden=false,webos=false}={}) {
 const writes=[],calls=[],classes=new Set(hidden?['is-controls-hidden']:[]);
 function element(name) {
  const attrs={},ownClasses=new Set();let text='',disabled=false,width='';
  const node={
   get textContent(){return text;},set textContent(value){writes.push(name+'.text');text=value;},
   get disabled(){return disabled;},set disabled(value){writes.push(name+'.disabled');disabled=value;},
   set tabIndex(value){this.setAttribute('tabindex',String(value));},
   getAttribute:k=>attrs[k]??null,hasAttribute:k=>Object.hasOwn(attrs,k),
   setAttribute(k,v){writes.push(name+'.'+k);attrs[k]=String(v);},
   setAttributeNS(_,k,v){this.setAttribute(k,v);},
   removeAttribute(k){writes.push(name+'.remove.'+k);delete attrs[k];},
   classList:{contains:k=>ownClasses.has(k),toggle(k,on){writes.push(name+'.class');if(on)ownClasses.add(k);else ownClasses.delete(k);}},
   style:{get width(){return width;},set width(value){writes.push(name+'.width');width=value;}},
   querySelector:k=>node.children[k],children:{}
  };
  return node;
 }
 const buttons={};
 for(const action of ['pause','speed','volume','quality','fullscreen']) {
  const node=element(action);node.children['.control-label']=element(action+'.label');node.children.use=element(action+'.use');buttons[action]=node;
 }
 const video={duration:100,currentTime:25,paused:false,ended:false,playbackRate:1,muted:false,volume:1};
 const progress=element('progress'),time=element('time');progress.children.span=element('fill');
 const events={};let enabled=false;
 const c={document:{getElementById:id=>id==='hero-video'?video:progress,
  querySelector:s=>s==='.time-label'?time:buttons[s.match(/data-action="([^"]+)"/)[1]]},
  shell:{classList:{contains:k=>classes.has(k),remove(k){calls.push(['reveal',time.textContent]);classes.delete(k);}}},
  webosShell:webos,window:{HongguoWebOSAudio:{supported:true,isEnabled:()=>enabled,diagnostics:()=>({actual_video_rate:1.5,phase:'playing'})}},
  uiText:(_,fallback)=>fallback,clockText:n=>String(Math.floor(n)),playbackAudioHold:null,playbackQuality:'',playbackPreferences:{quality:''},
  scheduleControlsHide(){calls.push('schedule');},controlsManuallyHidden:true,
  media:{addEventListener:(k,fn)=>events[k]=fn},activePlayback:{started:true},
  tickDanmaku(){calls.push('danmaku');},checkPlaybackProgress(){calls.push('check');},
  updateNextSeasonHint(){},
  maybePrefetchNextEpisode(){calls.push('prefetch');},saveProgress(force){calls.push(['save',force]);}
 };
 const begin=source.indexOf('  function setControlIcon(');
 vm.runInNewContext(source.slice(begin,source.indexOf('  function savePlaybackPreferences(',begin)),c);
 const reveal=source.indexOf('  function revealControls(');
 vm.runInNewContext(source.slice(reveal,source.indexOf('  function hideControls(',reveal)),c);
 const tick=source.indexOf("  media.addEventListener('timeupdate'");
 vm.runInNewContext(source.slice(tick,source.indexOf("  media.addEventListener('pause'",tick)),c);
 return {c,video,progress,time,buttons,writes,calls,events,classes,enableSpeed(value){enabled=value;}};
}

test('unchanged control refreshes perform no DOM writes; subsecond progress still moves',()=>{
 const f=fixture();f.c.updatePlaybackControls();f.writes.length=0;
 f.c.updatePlaybackControls();assert.deepEqual(f.writes,[]);
 f.video.currentTime=25.25;f.c.updatePlaybackControls();
 assert.deepEqual(f.writes,['fill.width']);assert.equal(f.progress.children.span.style.width,'25.25%');
 f.writes.length=0;f.video.currentTime=26;f.c.updatePlaybackControls();
 assert.equal(f.time.textContent,'26 / 100');assert.equal(f.progress.getAttribute('aria-valuenow'),'26');
 assert(f.writes.includes('time.text'));assert(!f.writes.some(k=>k.startsWith('speed.')||k.startsWith('pause.')));
});

test('seek, duration reset, pause, volume, quality and cinema changes update immediately',()=>{
 const f=fixture();f.c.updatePlaybackControls();
 f.video.currentTime=10;f.video.paused=true;f.video.volume=.5;f.video.playbackRate=1.5;f.c.playbackQuality='720P';f.classes.add('is-cinema');
 f.c.updatePlaybackControls();
 assert.equal(f.time.textContent,'10 / 100');assert.equal(f.progress.getAttribute('aria-valuenow'),'10');
 assert.equal(f.buttons.pause.getAttribute('aria-label'),'播放');assert.equal(f.buttons.pause.children.use.getAttribute('href'),'#icon-play');
 assert.equal(f.buttons.volume.getAttribute('aria-label'),'音量 50%');assert.equal(f.buttons.speed.getAttribute('aria-label'),'1.5x');
 assert.equal(f.buttons.quality.getAttribute('aria-label'),'自动 · 720P');assert.equal(f.buttons.fullscreen.getAttribute('aria-label'),'退出全屏');
 f.video.duration=NaN;f.c.updatePlaybackControls();
 assert.equal(f.progress.disabled,true);assert.equal(f.time.textContent,'0 / 0');assert.equal(f.progress.children.span.style.width,'0%');
 f.video.duration=200;f.video.currentTime=150;f.video.ended=true;f.video.paused=false;f.c.updatePlaybackControls();
 assert.equal(f.progress.disabled,false);assert.equal(f.progress.getAttribute('aria-valuemax'),'200');assert.equal(f.progress.children.span.style.width,'75%');
 assert.equal(f.buttons.pause.getAttribute('aria-label'),'播放');
});

test('hidden timeupdate still syncs danmaku, checks playback, prefetches and saves without control writes',()=>{
 const f=fixture({hidden:true});f.events.timeupdate();
 assert.deepEqual(f.writes,[]);assert.deepEqual(f.calls,['danmaku','check','prefetch',['save',false]]);
 f.c.activePlayback.started=false;f.calls.length=0;f.events.timeupdate();assert.deepEqual(f.calls,['danmaku','check']);
 f.c.activePlayback=null;f.calls.length=0;f.events.timeupdate();assert.deepEqual(f.calls,['danmaku','check']);
});

test('revealing hidden controls paints latest state before they become visible; repeated pointer reveals do not repaint',()=>{
 const f=fixture({hidden:true});f.video.currentTime=68;f.video.paused=true;f.video.muted=true;
 f.c.revealControls();
 assert.deepEqual(f.calls,[['reveal','68 / 100'],'schedule']);assert.equal(f.c.controlsManuallyHidden,false);assert(!f.classes.has('is-controls-hidden'));
 assert.equal(f.buttons.pause.getAttribute('aria-label'),'播放');assert.equal(f.buttons.volume.getAttribute('aria-label'),'静音');
 f.writes.length=0;f.c.revealControls();assert.deepEqual(f.writes,[]);
 f.video.currentTime=69;f.events.timeupdate();assert.equal(f.time.textContent,'69 / 100');
});

test('webOS speed visibility and accessibility react even while controls are hidden',()=>{
 const f=fixture({hidden:true,webos:true});f.c.updatePlaybackControls();
 assert(f.buttons.speed.classList.contains('is-hidden'));assert.equal(f.buttons.speed.getAttribute('tabindex'),'-1');assert.equal(f.buttons.speed.getAttribute('aria-hidden'),'true');
 f.writes.length=0;f.c.updatePlaybackControls();assert.deepEqual(f.writes,[]);
 f.enableSpeed(true);f.c.updatePlaybackControls();
 assert(!f.buttons.speed.classList.contains('is-hidden'));assert.equal(f.buttons.speed.hasAttribute('tabindex'),false);assert.equal(f.buttons.speed.hasAttribute('aria-hidden'),false);assert.equal(f.buttons.speed.getAttribute('aria-label'),'1.5x');
 f.enableSpeed(false);f.c.updatePlaybackControls();assert.equal(f.buttons.speed.getAttribute('tabindex'),'-1');
});
