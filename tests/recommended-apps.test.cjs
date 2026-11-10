const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create, model} = require('../core/cmd/hongguotv/ui/recommended-apps.js');
const text = (key, args) => key + (args ? JSON.stringify(args) : '');
function setup(options = {}) {
  const calls = [], timers = new Map(), renders = [];
  let status = {apps: [{id:'doudou',state:'available',min_sdk:23}, {id:'sports',state:'installed',min_sdk:23}, {id:'yunying',state:'available',min_sdk:23}]};
  let serial = 0;
  const bridge = {getStatus:()=>JSON.stringify(status),setVisible:x=>calls.push(['visible',x]),refresh:()=>calls.push(['refresh']),activate:id=>calls.push(['activate',id])};
  const controller = create({android:true,bridge,render:x=>renders.push(x),setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),...options});
  return {controller,calls,timers,renders,setStatus:x=>{status=x;}};
}
test('only Android with the installation bridge exposes the catalog; construction performs no work',()=>{
  const x=setup();assert.equal(x.controller.supported,true);assert.deepEqual(x.calls,[]);assert.equal(x.timers.size,0);
  for (const options of [{android:false},{bridge:null},{bridge:{getStatus:()=> '{}'}}]) {
    const x=setup(options);assert.equal(x.controller.supported,false);x.controller.show();assert.equal(x.timers.size,0);assert.deepEqual(x.calls,[]);
  }
});
test('page entry refreshes metadata once and leaving stops polling without an update timer',()=>{
  const x=setup();x.controller.show();x.controller.show();
  assert.deepEqual(x.calls,[['visible',true],['refresh']]);assert.equal(x.timers.size,1);assert.equal(x.renders.length,1);
  x.controller.hide();assert.equal(x.timers.size,0);x.controller.activate('doudou');assert.equal(x.calls.length,3);
  x.controller.show();assert.equal(x.timers.size,1);x.controller.destroy();assert.equal(x.timers.size,0);x.controller.show();assert.equal(x.timers.size,0);
});
test('only catalog IDs reach the bridge and invalid status does not break the page',()=>{
  const x=setup();x.controller.show();x.controller.activate('../x');x.controller.activate('doudou');x.controller.activate('yunying');
  assert.deepEqual(x.calls.filter(x=>x[0]==='activate'),[['activate','doudou'],['activate','yunying']]);
  x.setStatus({apps:[{id:'doudou',state:'installed'},{id:'foreign',state:'installed'}]});x.controller.refresh();assert.equal(x.renders.at(-1).length,1);
  x.setStatus({});x.controller.refresh();assert.equal(x.renders.at(-1)[0].error,'metadata');
});
test('installed apps never offer Open or Update, and incompatible apps cannot download',()=>{
  for(const state of ['installed','incompatible','installing','loading']) assert.equal(model({state},text).blocked,true);
  assert.equal(model({state:'installed'},text).label,'apps.installed');
  assert.equal(model({state:'available',busy:true},text).blocked,true);
  assert.equal(model({state:'available',min_sdk:23},text).android,'apps.android{"version":"6.0"}');
});
test('download, permission, errors and cancelled installation have explicit actions',()=>{
  const x=model({state:'downloading',size:100,downloaded:36},text);assert.equal(x.percent,36);assert.equal(x.label,'apps.cancel');
  assert.equal(model({state:'downloading',size:100,downloaded:200},text).percent,100);
  assert.equal(model({state:'permission'},text).label,'apps.permission');
  assert.equal(model({state:'ready'},text).label,'apps.continue');
  assert.equal(model({state:'ready',alternative:true},text).label,'apps.alternative');
  assert.match(model({state:'error',error:'metadata'},text).status,/metadataError/);
  assert.match(model({state:'error',error:'download'},text).status,/downloadError/);
});
