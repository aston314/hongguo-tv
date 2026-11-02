const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {create} = require('../webos/app/webos-updates');
const {create:updates} = require('../core/cmd/hongguotv/ui/updates');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
const start = source.indexOf('      if (webosShell && data.manual_install)');
const body = source.slice(start,source.indexOf('      if (data.desktop)',start));
function latest() {return {schema:1,platform:'webos',app_id:'com.aston314.hongguo.webos',version_name:'0.2.118',release_tag:'webos-v0.2.118-test.26',release_url:'https://github.com/aston314/hongguo-tv-releases/releases/tag/webos-v0.2.118-test.26',release_notes:'修复说明',artifact_name:'hongguo-webos-0.2.118-test.26.ipk',artifact_size:123,artifact_sha256:'a'.repeat(64)}}
test('the real settings renderer defers notice during playback, preserves focus, and remembers the shown version',async()=>{
  let allowed=false, noticeCount=0;const storage=new Map();
  const bridge=create({version:'0.2.117',storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},check:async()=>latest()});
  const field={id:'app-check-update'};
  const notes={textContent:'',classList:{toggle(){},add(){}},setAttribute(){}};
  const context=vm.createContext({webosShell:true,window:{HongguoTVUpdates:bridge},document:{activeElement:field,getElementById:()=>notes},
    canShowAppUpdate:()=>allowed,showNotice:()=>{noticeCount++},uiText:(_k,fallback,params)=>fallback.replace('{version}',params?.version||'')});
  const controller=updates({bridge,canPrompt:()=>allowed,render:data=>{context.data=data;vm.runInContext(body,context)}});
  await bridge.check();controller.refresh();controller.refresh();
  assert.equal(noticeCount,0);assert.equal(context.document.activeElement,field);
  allowed=true;controller.refresh();controller.refresh();controller.refresh();
  assert.equal(noticeCount,1);assert.equal(context.document.activeElement,field);
  assert.match(notes.textContent,/webOS Dev Manager/);assert.match(notes.textContent,/releases\/tag\/webos-v0.2.118-test.26/);
  allowed=false;controller.refresh();allowed=true;controller.refresh();controller.refresh();assert.equal(noticeCount,1);
  const restored=create({version:'0.2.117',storage:{getItem:k=>storage.get(k)},check:async()=>latest()});
  assert.equal(JSON.parse(restored.getStatus()).notified,true);
});
test('other platforms do not enter the webOS settings branch',()=>{
  for(const webosShell of [false,undefined]) {
    vm.runInNewContext(body,{webosShell,data:{manual_install:true},document:{getElementById(){throw Error('other platform DOM touched')}}});
  }
});
test('remote can enter and scroll the update notes, then return to the check button',()=>{
  const check={id:'app-check-update'};
  const notes={id:'desktop-update-notes',scrollTop:0,clientHeight:200,classList:{contains:name=>name==='webos-update-notes'}};
  const c=vm.createContext({coreConnectionModalOpen:false,scanModalOpen:()=>false,supportModalOpen:false,confirmOpen:false,rankFilterOpen:false,playerOptionsOpen:false,detailModalOpen:false,discussionOpen:false,
    zoneOf:node=>node===notes?'webosUpdateNotes':'appUpdates',document:{getElementById:()=>check},firstVisible:selector=>selector==='.webos-update-notes'?notes:null});
  const a=source.indexOf('  function moveFrom('),b=source.indexOf('  function accountKeypadOpen(',a);
  vm.runInContext(source.slice(a,b),c);
  assert.equal(c.moveFrom(check,'down'),notes);
  assert.equal(c.moveFrom(notes,'down'),notes);assert.equal(notes.scrollTop,130);
  assert.equal(c.moveFrom(notes,'up'),notes);assert.equal(notes.scrollTop,0);
  assert.equal(c.moveFrom(notes,'up'),check);assert.equal(c.moveFrom(notes,'left'),check);
});
