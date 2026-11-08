const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {create}=require('../core/cmd/hongguotv/ui/desktop-mini-player.js');

// Small DOM double: media ownership is deliberately outside the controller.
function fixture(native, options={}) {
  class Node {
    constructor(tag='div') { this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.listeners={};this.disabled=false;this.id='';
      const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){on=on===undefined?!classes.has(x):on;on?classes.add(x):classes.delete(x);return on}}; }
    set className(v){v.split(/\s+/).forEach(x=>this.classList.add(x))}
    set innerHTML(v){this.markup=v;this.parts={};for(const tag of ['use','span']){this.parts[tag]=new Node(tag)}this.parts['.control-label']=this.parts.span}
    querySelector(s){return this.parts&&this.parts[s]||null}
    querySelectorAll(s){return this.children.flatMap(c=>(s==='button,input'&&/^(BUTTON|INPUT)$/.test(c.tagName)?[c]:[]).concat(c.querySelectorAll(s)))}
    setAttribute(k,v){this.attrs[k]=v} setAttributeNS(ns,k,v){this.setAttribute(k,v)}
    appendChild(n){this.children.push(n);n.parentElement=this;return n}
    insertBefore(n,old){this.children.unshift(n);n.parentElement=this}
    addEventListener(k,f){(this.listeners[k]||=[]).push(f)}
    dispatch(k){for(const f of this.listeners[k]||[])f()}
    click(){if(!this.disabled)this.dispatch('click')}
    contains(n){return n===this||this.children.some(c=>c.contains(n))}
  }
  const hero=new Node(),group=new Node(),shell=new Node(),video={src:'unchanged.mp4',currentTime:19,paused:false,muted:true,volume:.6,playbackRate:1.5,listeners:{},addEventListener:Node.prototype.addEventListener};
  const settingCard=new Node(),settingToggle=new Node('button'),settingState=new Node();
  const ids={'hero':hero,'hero-video':video,'desktop-mini-titlebar-settings':settingCard,'desktop-mini-titlebar-toggle':settingToggle,'desktop-mini-titlebar-state':settingState};
  const doc={documentElement:new Node('html'),activeElement:null,createElement:t=>new Node(t),getElementById:id=>ids[id]||null,
    querySelector:s=>s==='.app-shell'?shell:group};
  const s={available:true,canPlay:true,paused:false,position:19,duration:100,volume:60,portrait:true,episode:1,nextEpisode:true,nextDrama:true,title:'test'};
  const commands=[],changed=[],notices=[];
  const timers=new Map();let nextTimer=0;
  const storage=options.storage||new Map();
  const win={document:doc,localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>{if(options.storageFails)throw Error('storage');storage.set(key,value)}},wails:{flags:{}},setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id},clearTimeout:id=>timers.delete(id),HongguoTV:{miniPlayerState:()=>s,
    miniPlayerFocus:n=>{doc.activeElement=n},miniPlayerCommand:(...a)=>commands.push(a),miniPlayerChanged:(...a)=>changed.push(a),miniPlayerNotify:m=>notices.push(m)}};
  if(native)win.go={main:{desktopApp:{SetMiniPlayer:native,SetMiniPlayerTitlebarHidden:options.setTitlebar||(()=>({active:true,titlebar_hidden:false}))}}};
  const mini=create(win,{platform:options.platform||(native?'darwin':'preview')});
  const nodes=()=>hero.children[0].querySelectorAll('button,input');
  return {win,doc,s,video,hero,group,shell,mini,commands,changed,notices,timers,storage,settingCard,settingToggle,settingState,nodes,find:id=>nodes().find(n=>n.id===id),
    fireTimer(delay){const timer=[...timers].find(([,value])=>value.delay===delay);if(!timer)return false;timers.delete(timer[0]);timer[1].callback();return true}};
}

test('enter/restore keeps video source, position, pause, mute, volume and speed untouched',async()=>{
  const f=fixture();f.shell.classList.add('is-cinema');const before=Object.assign({},f.video);
  assert.equal(await f.mini.request(true),true);assert.equal(f.mini.isActive(),true);
  assert.equal(f.doc.documentElement.classList.contains('desktop-mini-player'),true);
  assert.equal(await f.mini.request(false),true);assert.deepEqual(f.video,before);assert.deepEqual(f.commands,[]);
  assert.deepEqual(f.changed.at(-1),[false,true]);
});

test('duplicate async requests and old native polls cannot restore a newly entered mini player',async()=>{
  let resolve,calls=0;const f=fixture(()=>{calls++;return new Promise(r=>resolve=r)});
  const old=f.mini.revision(),enter=f.mini.request(true);await Promise.resolve();
  assert.equal(await f.mini.request(true),false);assert.equal(calls,1);
  resolve('{"active":true}');assert.equal(await enter,true);
  f.mini.render({mini_player:false},old);assert.equal(f.mini.isActive(),true);
  assert.equal(f.group.children[0].disabled,false);
});

test('native failure rolls layout back and restores the previous cinema state',async()=>{
  const f=fixture(async()=>{throw Error('unavailable')});f.shell.classList.add('is-cinema');
  assert.equal(await f.mini.request(true),false);assert.equal(f.mini.isActive(),false);
  assert.equal(f.doc.documentElement.classList.contains('desktop-mini-player'),false);
  assert.deepEqual(f.changed.at(-1),[false,true]);assert.equal(f.notices.length,1);
});

test('mini controls use shared commands and respect episode/recommendation boundaries',async()=>{
  const f=fixture();await f.mini.request(true);
  f.find('mini-player-previousDrama').click();f.find('mini-player-previousEpisode').click();assert.deepEqual(f.commands,[]);
  for(const action of ['nextEpisode','nextDrama','pause'])f.find('mini-player-'+action).click();
  assert.deepEqual(f.commands,[['nextEpisode',undefined],['nextDrama',undefined],['toggle',undefined]]);
  f.s.nextDrama=false;f.s.nextEpisode=false;f.mini.render();
  assert.equal(f.find('mini-player-nextDrama').disabled,true);assert.equal(f.find('mini-player-nextEpisode').disabled,true);
  const ranges=f.nodes().filter(n=>n.tagName==='INPUT');ranges[0].value='42';ranges[0].dispatch('input');ranges[1].value='0';ranges[1].dispatch('input');
  assert.deepEqual(f.commands.slice(-2),[['seek',42],['volume',0]]);
});

test('controls auto-hide again after next episode playback resumes',async()=>{
  const f=fixture();await f.mini.request(true);const overlay=f.hero.children[0];
  assert.equal(f.fireTimer(2500),true);assert.equal(overlay.classList.contains('is-visible'),false);
  f.s.paused=true;f.video.paused=true;f.video.listeners.pause.forEach(callback=>callback());
  assert.equal(overlay.classList.contains('is-visible'),true);
  f.s.episode=2;f.s.paused=false;f.video.paused=false;
  f.video.listeners.playing.forEach(callback=>callback());
  assert.equal(overlay.classList.contains('is-visible'),true);
  assert.equal(f.fireTimer(2500),true);assert.equal(overlay.classList.contains('is-visible'),false);
});

test('keyboard interaction still keeps mini controls visible after playback resumes',async()=>{
  const f=fixture();await f.mini.request(true);const overlay=f.hero.children[0];
  f.mini.handleKey({preventDefault(){},stopPropagation(){}},'ArrowRight',node=>{f.doc.activeElement=node});
  f.s.paused=false;f.video.paused=false;
  f.video.listeners.playing.forEach(callback=>callback());
  assert.equal(overlay.classList.contains('is-visible'),true);
  assert.equal([...f.timers.values()].some(timer=>timer.delay===2500),false);
});

test('keyboard navigation skips disabled controls; sliders keep native arrows and Escape restores',async()=>{
  const f=fixture();await f.mini.request(true);let prevented=0;
  const event={preventDefault(){prevented++},stopPropagation(){}};
  assert.equal(f.mini.handleKey(event,'ArrowRight',n=>f.doc.activeElement=n),true);assert.equal(f.doc.activeElement.id,'mini-player-nextEpisode');
  f.mini.handleKey(event,'Enter',()=>{});assert.deepEqual(f.commands.at(-1),['nextEpisode',undefined]);
  f.doc.activeElement=f.nodes().find(n=>n.tagName==='INPUT');prevented=0;
  f.mini.handleKey(event,'ArrowRight',()=>assert.fail('slider focus moved'));assert.equal(prevented,0);
  f.mini.handleKey(event,'Tab',n=>f.doc.activeElement=n);assert.equal(prevented,1);assert.equal(f.doc.activeElement.id,'mini-player-pause');
  f.mini.handleKey(event,'Escape',()=>{});await new Promise(r=>setImmediate(r));assert.equal(f.mini.isActive(),false);
});

test('shared state permits mini mode while hidden, disables standalone drama navigation and guards background commands',()=>{
  const app=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
  const source=app.slice(app.indexOf('  function miniPlayerState()'),app.indexOf('  if (desktopShell) {\n    window.HongguoTV.miniPlayerState'));
  const video={videoWidth:720,videoHeight:1280,currentTime:10,duration:99,volume:.5,getAttribute:()=>'/test.mp4'};
  const c=vm.createContext({document:{getElementById:()=>video},activePlayback:{episode:2,item:{series_id:'a',title:'A',episode_count:3}},playbackRequest:null,
    feedItems:[],feedIndex:0,featuredItem:null,coreConnectionModalOpen:false,detailModalOpen:false,playerOptionsOpen:false,confirmOpen:false,discussionOpen:false,
    endRecommendations:null,isPlaybackPage:()=>true,pageMode:()=> 'player',playbackAudioHold:null,desktopShell:true,applicationInBackground:true,applicationHidden:()=>true});
  vm.runInContext(source,c);assert.equal(c.miniPlayerState().available,true);assert.equal(c.miniPlayerState().nextDrama,false);assert.equal(c.miniPlayerCommand('toggle'),false);
});

test('titlebar is opt-in, persists, and only enables hiding for the requested small window',async()=>{
  const calls=[];const f=fixture((...args)=>{calls.push(args);return {active:args[0],titlebar_hidden:args[0]&&args[2]}});
  assert.equal(f.settingToggle.attrs['aria-pressed'],'false');
  await f.mini.request(true);assert.deepEqual(calls[0],[true,true,false]);await f.mini.request(false);
  assert.equal(await f.mini.chooseTitlebar(true),true);
  await f.mini.request(true);assert.deepEqual(calls.at(-1),[true,true,true]);
  assert.equal(f.find('mini-player-titlebar').classList.contains('is-hidden'),false);
  await f.mini.request(false);assert.deepEqual(calls.at(-1),[false,true,false]);
  assert.equal(f.doc.documentElement.classList.contains('desktop-mini-titlebar-hidden'),false);
  const restarted=fixture(undefined,{storage:f.storage});
  assert.equal(restarted.settingToggle.attrs['aria-pressed'],'true');
});

test('native titlebar failure retains mini playback and switches the preference back off',async()=>{
  const f=fixture(()=>({active:true,titlebar_hidden:false,titlebar_fallback:true}));
  await f.mini.chooseTitlebar(true);
  assert.equal(await f.mini.request(true),true);
  assert.equal(f.mini.isActive(),true);assert.equal(f.settingToggle.attrs['aria-pressed'],'false');
  assert.equal(f.doc.documentElement.classList.contains('desktop-mini-titlebar-hidden'),false);
  assert.equal(f.notices.length,1);
});

test('recovery restores the titlebar in place, removes Linux resize handling and persists the old mode',async()=>{
  let restored=0;
  const f=fixture((enabled,portrait,hidden)=>({active:enabled,titlebar_hidden:hidden}),{platform:'linux',setTitlebar:()=>{restored++;return {active:true,titlebar_hidden:false}}});
  await f.mini.chooseTitlebar(true);await f.mini.request(true);const before=Object.assign({},f.video);
  assert.equal(f.win.wails.flags.enableResize,true);
  f.find('mini-player-titlebar').click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(restored,1);assert.equal(f.mini.isActive(),true);
  assert.equal(f.win.wails.flags.enableResize,false);assert.equal(f.settingToggle.attrs['aria-pressed'],'false');
  assert.deepEqual(f.video,before);assert.deepEqual(f.commands,[]);
});

test('titlebar restoration failure keeps recovery controls and preference available',async()=>{
  const f=fixture((enabled,portrait,hidden)=>({active:enabled,titlebar_hidden:hidden}),{setTitlebar:()=>({active:true,titlebar_hidden:true,error:'restore failed'})});
  await f.mini.chooseTitlebar(true);await f.mini.request(true);
  assert.equal(await f.mini.chooseTitlebar(false),false);
  assert.equal(f.mini.isActive(),true);assert.equal(f.find('mini-player-titlebar').classList.contains('is-hidden'),false);
  assert.equal(f.settingToggle.attrs['aria-pressed'],'true');
});

test('failed persistence keeps the default and other platforms do not expose desktop settings',async()=>{
  const f=fixture(undefined,{storageFails:true});assert.equal(await f.mini.chooseTitlebar(true),false);
  assert.equal(f.settingToggle.attrs['aria-pressed'],'false');
  for(const platform of ['android','webos']) {
    const other=fixture(undefined,{platform});
    assert.equal(other.settingCard.classList.contains('is-hidden'),true);
    assert.equal(await other.mini.chooseTitlebar(true),false);
  }
});
