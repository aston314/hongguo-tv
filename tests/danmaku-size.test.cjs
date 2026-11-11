const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const content = require('../core/cmd/hongguotv/ui/danmaku-content.js');
const engagement = require('../core/cmd/hongguotv/ui/engagement.js');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const slice = (a,b) => source.slice(source.indexOf('  function '+a+'('), source.indexOf('  function '+b+'('));
const presets = [100,125,150,175,200];
function node(tag) {
  const classes = new Set();
  return {tag,children:[],attrs:{},events:{},style:{},textContent:'',
    appendChild(child){this.children.push(child);return child;},
    set innerHTML(value){assert.equal(value,'');this.children=[];},
    setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},
    addEventListener(k,v){this.events[k]=v;},
    classList:{add(k){classes.add(k);},remove(...keys){keys.forEach(k=>classes.delete(k));},toggle(k,v){v?classes.add(k):classes.delete(k);},contains:k=>classes.has(k)}
  };
}
const descendants = n => [n,...n.children.flatMap(descendants)];
function fixture({android=false,webos=false,saved={},fail=false}={}) {
  let stored=JSON.stringify(saved), resets=0,ticks=0,writes=0,notices=0,localeChange;
  const nodes={};
  const buttons=presets.map(size=>{const b=node('button');b.attrs['data-size']=String(size);return b;});
  const video={};
  const document={
    createElement:node,createElementNS:(_,tag)=>node(tag),createTextNode:text=>Object.assign(node('#text'),{textContent:text}),
    getElementById:id=>id==='hero-video'?video:nodes[id]||(nodes[id]=node('div')),
    querySelector:()=>node('button'),querySelectorAll:()=>buttons
  };
  function write(value){writes++;if(fail)throw Error('storage full');stored=value;}
  const c=vm.createContext({
    document,window:{HongguoTVPreferences:{read:()=>stored,write},HongguoI18n:{onChange(fn){localeChange=fn;}}},
    androidShell:android,webosShell:webos,localStorage:{getItem:()=>stored,setItem:(_,v)=>write(v)},
    HongguoDanmakuContent:content,HongguoEngagement:engagement,HongguoEpisodePrefetchSettings:{normalize:()=> 'full',supports:()=>true},
    episodePrefetchPlatform:()=>android?'android':webos?'webos':'desktop',
    playbackPreferences:{speed:1,volume:100,quality:'',danmaku:false,danmaku_region:'current',danmaku_size:100},
    playbackSpeeds:[1,1.25,1.5,2],playbackSpeedAvailable:()=>true,showNotice:()=>notices++,
    uiText:(_,fallback,params)=>fallback.replace('{size}',params?params.size:''),
    setPlaybackMuted:()=>{},updateDanmakuButton:()=>{},updatePlaybackControls:()=>{}
  });
  vm.runInContext(slice('normalizeDanmakuRegion','resetDanmaku')+slice('savePlaybackPreferences','cancelDiagnosticRead')+slice('initDanmakuSizeSettings','initEpisodePrefetchSettings'),c);
  c.resetDanmaku=()=>resets++;c.tickDanmaku=()=>ticks++;
  c.restorePlaybackPreferences();c.initDanmakuSizeSettings();
  return {c,buttons,nodes,video,choose:size=>buttons[presets.indexOf(size)].events.click(),
    locale:()=>localeChange(),get saved(){return JSON.parse(stored);},get counts(){return {resets,ticks,writes,notices};}};
}

test('only the five enlarged presets are accepted; old and malformed preferences keep 100%',()=>{
  for(const value of [undefined,null,'200',0,50,99,101,201,Infinity,NaN,{},[]]){
    const f=fixture({saved:{danmaku_size:value}});
    assert.equal(f.c.playbackPreferences.danmaku_size,100);
    assert.equal(f.c.danmakuFontSize(),22);
  }
  for(const size of presets)assert.equal(fixture({saved:{danmaku_size:size}}).c.danmakuFontSize(),22*size/100);
});

test('larger comments get wider lane spacing and only complete rows fit, including short quarter regions',()=>{
  const f=fixture();
  for(const region of ['current','half','quarter']){
    f.c.playbackPreferences.danmaku_region=region;
    for(const height of [0,20,35,44,72,90,135,270,500]){
      let previous=Infinity;
      for(const size of presets){
        f.c.playbackPreferences.danmaku_size=size;
        const layout=f.c.danmakuLaneLayout({clientHeight:height});
        assert.equal(layout.font,22*size/100);
        assert.equal(layout.step,Math.ceil(38*size/100));
        assert.ok(layout.count<=previous);previous=layout.count;
        assert.ok(layout.count>=0&&layout.count<=(region==='half'?6:4));
        if(layout.count)assert.ok((layout.count-1)*layout.step+Math.ceil(layout.font*1.6)<=height);
      }
    }
  }
  assert.equal(f.c.danmakuLaneLayout({clientHeight:0}).count,0);
  f.c.playbackPreferences.danmaku_size=100;
  assert.equal(f.c.danmakuLaneLayout({clientHeight:270}).count,4);
  assert.equal(f.c.danmakuLaneLayout({clientHeight:270}).step,38);
});

test('browser, native Android and webOS save and restore size alongside unrelated playback preferences',()=>{
  for(const platform of [{},{android:true},{webos:true}]){
    const f=fixture({...platform,saved:{speed:1.25,volume:80,quality:'720P',danmaku:true,danmaku_region:'quarter'}});
    f.choose(175);
    assert.equal(f.saved.danmaku_size,175);
    assert.equal(f.saved.quality,'720P');assert.equal(f.saved.speed,1.25);
    assert.equal(f.saved.danmaku,true);assert.equal(f.saved.danmaku_region,'quarter');
    assert.equal(fixture({...platform,saved:f.saved}).c.playbackPreferences.danmaku_size,175);
    assert.equal(f.video.playbackRate,1.25,'no player restart or speed change');
    assert.equal(f.counts.resets,1);assert.equal(f.counts.ticks,1);
    const before=f.counts.writes;f.choose(175);assert.equal(f.counts.writes,before,'selected preset is a no-op');
  }
});

test('preview uses the real local emoji and likes renderer; failures roll back without clearing live comments',()=>{
  const f=fixture({fail:true});f.choose(200);
  assert.equal(f.c.playbackPreferences.danmaku_size,100);
  assert.equal(f.buttons[0].attrs['aria-pressed'],'true');
  assert.equal(f.buttons[4].attrs['aria-pressed'],'false');
  assert.equal(f.counts.resets,0);assert.equal(f.counts.ticks,0);
  assert.match(f.nodes['danmaku-size-state'].textContent,/未能保存/);
  const good=fixture();
  for(const size of presets){
    good.choose(size);
    const lines=good.nodes['danmaku-size-preview'].children;
    assert.equal(lines.length,1);
    assert.equal(lines[0].style.fontSize,22*size/100+'px');
    const all=descendants(lines[0]);
    assert.equal(all.filter(n=>n.tag==='img')[0].src,'emoji/hongguo/20.webp');
    assert.equal(all.filter(n=>n.className==='danmaku-likes').length,1);
    assert.equal(all.filter(n=>n.textContent==='128').length,1);
  }
  good.locale();assert.equal(good.nodes['danmaku-size-preview'].children.length,1);
  assert.equal(good.c.playbackPreferences.danmaku_size,200);
});

test('remote paths enter and leave the new card, including wrapped rows and hidden platform settings',()=>{
  const visible=new Set(['.danmaku-region-action','.danmaku-size-action','.episode-prefetch-action','.playback-custom-device-input']);
  const c=vm.createContext({
    coreConnectionModalOpen:false,endRecommendations:null,detailModalOpen:false,actorWorksOpen:false,confirmOpen:false,playerOptionsOpen:false,
    discussionOpen:false,accountCountryModalOpen:false,supportModalOpen:false,rankFilterOpen:false,
    scanModalOpen:()=>false,accountKeypadOpen:()=>false,zoneOf:n=>n.zone,firstVisible:s=>visible.has(s)?s:null,
    activeSidebar:()=> 'sidebar',moveWithinZone:()=>null,moveGrid:()=>null
  });
  vm.runInContext(slice('moveFrom','accountKeypadFocus'),c);
  const move=(zone,direction)=>c.moveFrom({zone},direction);
  assert.equal(move('danmakuRegion','down'),'.danmaku-size-action');
  assert.equal(move('danmakuSize','up'),'.danmaku-region-action');
  assert.equal(move('danmakuSize','down'),'.episode-prefetch-action');
  assert.equal(move('episodePrefetch','up'),'.danmaku-size-action');
  assert.equal(move('danmakuSize','left'),'sidebar');
  assert.equal(move('danmakuSize','right'),null);
  visible.delete('.episode-prefetch-action');
  assert.equal(move('danmakuSize','down'),'.playback-custom-device-input');
  assert.equal(move('playbackCustomDevice','up'),'.danmaku-size-action');
  c.moveGrid=()=> 'same-card-next-row';
  assert.equal(move('danmakuSize','down'),'same-card-next-row');
  assert.equal(move('danmakuSize','up'),'same-card-next-row');
});

test('the live emitter uses the chosen size and waits when a complete line cannot fit',()=>{
  const f=fixture({saved:{danmaku_size:200,danmaku_region:'quarter'}});
  const layer=f.nodes['danmaku-layer'];layer.clientHeight=60;
  f.video.paused=false;f.video.currentTime=10;f.video.duration=60;
  Object.assign(f.c,{
    danmakuEnabled:true,activePlayback:{vid:'video',item:{series_id:'series'}},
    isPlaybackPage:()=>true,applicationHidden:()=>false,applicationInBackground:false,
    danmakuWindow:0,danmakuBusy:false,danmakuLast:-1,danmakuLane:0,
    danmakuRows:[{text:'[捂脸]测试',likes:128,offset_ms:10000}],
    fetchData:()=>{throw Error('size selection must not resolve or download a video');}
  });
  vm.runInContext(slice('tickDanmaku','pageMode'),f.c);
  f.c.tickDanmaku();
  assert.equal(layer.children.length,0,'do not emit a clipped row or calculate a zero-lane modulo');
  assert.equal(f.c.danmakuRows[0].shown,undefined);
  layer.clientHeight=160;f.c.tickDanmaku();
  assert.equal(layer.children.length,1);
  assert.equal(layer.children[0].style.fontSize,'44px');
  assert.equal(layer.children[0].style.top,'0px');
  assert.equal(f.c.danmakuRows[0].shown,true);
  assert.equal(f.c.danmakuLast,10000);
});
