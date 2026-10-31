const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const moduleApi=require('../core/cmd/hongguotv/ui/portrait-backdrop.js');
const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
const start=source.indexOf('  function initPortraitBackground('), end=source.indexOf('  function initEpisodePrefetchSettings(',start);
function fixture({android=false,webos=false,nativeSupported=true,save=true}={}) {
  const nodes={},calls=[],listeners={},buttons=['black','blur'].map(mode=>node(mode));let options;
  function node(mode='') { const classes=new Set();return {textContent:'',attrs:{},click:null,getAttribute:()=>mode,setAttribute(k,v){this.attrs[k]=v;},classList:{toggle(n,on){on?classes.add(n):classes.delete(n);},contains:n=>classes.has(n)},addEventListener(n,fn){this[n]=fn;}}; }
  const rawVideo={};const adapter={domVideo:()=>rawVideo,isNative:()=>false};
  const c={window:{HongguoPortraitBackdrop:moduleApi,HongguoNativePlaybackAdapter:adapter,HongguoNativePlayer:{portraitBackdropSupported:()=>nativeSupported},addEventListener(n,fn){listeners[n]=fn;}},
    HongguoPortraitBackdrop:{normalize:moduleApi.normalize,create(o){options=o;calls.push('create');return {setMode:m=>calls.push(m),reset:()=>calls.push('reset'),update:()=>calls.push('update'),layout:()=>calls.push('layout'),receive:(...args)=>calls.push(args)};}},
    androidShell:android,webosShell:webos,portraitBackdrop:null,media:{},playbackPreferences:{portrait_background:'black'},
    activePlayback:null,feedGeneration:1,accountEpoch:1,
    document:{getElementById:id=>nodes[id]||(nodes[id]=node()),querySelector:()=>rawVideo,querySelectorAll:()=>buttons,addEventListener(n,fn){listeners[n]=fn;}},
    savePlaybackPreferences:()=>save,uiText:(key,fallback)=>fallback};
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);c.initPortraitBackground();
  return {c,nodes,buttons,calls,listeners,get options(){return options;}};
}
test('webOS and old Android hide the card and instantiate no capture controller',()=>{
  for(const flags of [{webos:true},{android:true,nativeSupported:false}]) {
    const f=fixture(flags);assert.ok(f.nodes['portrait-background-settings'].classList.contains('is-hidden'));assert.deepEqual(f.calls,[]);assert.equal(f.c.window.HongguoPortraitBackdropReceive,undefined);
  }
});
test('supported platforms persist a choice, initialize black, and forward exact callback arguments',()=>{
  for(const android of [false,true]) {
    const f=fixture({android});assert.deepEqual(f.calls,['create','black']);assert.equal(f.buttons[0].attrs['aria-pressed'],'true');
    f.buttons[1].click();assert.equal(f.c.playbackPreferences.portrait_background,'blur');assert.equal(f.buttons[1].attrs['aria-pressed'],'true');assert.equal(f.options.video,f.c.window.HongguoNativePlaybackAdapter.domVideo());
    f.c.window.HongguoPortraitBackdropReceive('load','12','data',0.5625);assert.deepEqual(f.calls.at(-1),['load','12','data',0.5625]);
    f.listeners.resize();assert.equal(f.calls.at(-1),'layout');f.listeners.pagehide();assert.equal(f.calls.at(-1),'reset');
  }
});
test('failed persistence preserves the actual selected mode and does not activate work',()=>{
  const f=fixture({save:false});f.buttons[1].click();assert.equal(f.c.playbackPreferences.portrait_background,'black');assert.deepEqual(f.calls,['create','black']);assert.equal(f.buttons[0].attrs['aria-pressed'],'true');
});
