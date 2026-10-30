const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { create } = require('../core/cmd/hongguotv/ui/account-scan.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function data(id, state='pending', extra={}) { return { qr_login: {id, state, image: 'data:image/png;base64,fixture', expires_at: Date.now()+60000}, ...extra }; }
function fixture(request) {
  const timers = new Map(), calls = [], statuses = []; let completed=0, next=0;
  const controller=create({request(action,id) { calls.push([action,id]); return request(action,id); },
    setTimeout(callback) { const id=++next; timers.set(id,callback); return id; }, clearTimeout(id) {timers.delete(id);},
    onStatus(value) { statuses.push(value); }, onComplete() { completed++; }});
  return {controller,calls,statuses,timers,completed:()=>completed, async poll() {const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await tick();} };
}
test('refresh waits for old creation and cancels only its ID before creating the next session',async()=>{
  const old=deferred(); let starts=0;
  const f=fixture(action=>action==='start' ? (++starts===1 ? old.promise : data('new')) : {});
  f.controller.start(); await tick(); f.controller.start(); await tick(); assert.equal(starts,1);
  old.resolve(data('old')); await tick();
  assert.deepEqual(f.calls,[['start',undefined],['cancel','old'],['start',undefined]]);
  assert.equal(f.controller.snapshot().id,'new'); assert.equal(f.timers.size,1);
});
test('cancel during creation cancels its late response without displaying or polling it',async()=>{
  const pending=deferred(), f=fixture(action=>action==='start'?pending.promise:{});
  f.controller.start(); await tick(); f.controller.cancel(); pending.resolve(data('old')); await tick();
  assert.equal(f.controller.snapshot().active,false); assert.equal(f.statuses.length,0);assert.equal(f.timers.size,0);
  assert.deepEqual(f.calls,[['start',undefined],['cancel','old']]);
});
test('late poll cannot overwrite a refreshed session and polling never overlaps',async()=>{
  const old=deferred(); let starts=0;
  const f=fixture((action,id)=>action==='start'?data(++starts===1?'old':'new'):action==='status'&&id==='old'?old.promise:{});
  f.controller.start(); await tick(); const poll=f.poll(); await tick(); assert.equal(f.timers.size,0);
  f.controller.start(); await tick(); old.resolve(data('old','signed_in',{logged_in:true})); await poll; await tick();
  assert.equal(f.controller.snapshot().id,'new'); assert.equal(f.completed(),0); assert.equal(f.timers.size,1);
});
test('confirmation stops polling and reports the common account status once',async()=>{
  const f=fixture(action=>action==='start'?data('id'):data('id','signed_in',{logged_in:true,profile:{uid:'123'}}));
  f.controller.start();await tick();await f.poll();
  assert.equal(f.controller.snapshot().state,'signed_in');assert.equal(f.controller.snapshot().active,false);
  assert.equal(f.completed(),1);assert.equal(f.timers.size,0);assert.equal(f.statuses[1].profile.uid,'123');
});
test('transient errors retry; expired codes stay visible for refresh, while processing may finish after expiry',async()=>{
  const f=fixture(action=>{if(action==='status')throw Error('offline');return data('id');});
  f.controller.start();await tick();await f.poll();assert.equal(f.controller.snapshot().error,'network');assert.equal(f.timers.size,1);
  const expired=fixture(action=>{if(action==='status')throw Error('offline');return data('expired','pending',{qr_login:{id:'expired',state:'pending',expires_at:1}});});
  expired.controller.start();await tick();await expired.poll();assert.equal(expired.controller.snapshot().state,'expired');assert.equal(expired.timers.size,0);
  const processing=fixture(action=>{if(action==='status')throw Error('offline');return data('processing','processing',{qr_login:{id:'processing',state:'processing',expires_at:1}});});
  processing.controller.start();await tick();await processing.poll();assert.equal(processing.controller.snapshot().state,'processing');assert.equal(processing.timers.size,1);
});
test('synchronous start failure allows retry without an unhandled rejection',async()=>{
  let starts=0;const f=fixture(action=>{if(action==='start'&&++starts===1)throw Error('offline');return data('new');});
  f.controller.start();await tick();assert.equal(f.controller.snapshot().state,'failed');
  f.controller.start();await tick();assert.equal(f.controller.snapshot().id,'new');
});
test('webOS hides QR capability and QR is first and default without changing the webOS login UI',()=>{
  const source=fs.readFileSync('core/cmd/hongguotv/ui/app.js','utf8');const nodes={};
  const document={getElementById(id) {return nodes[id]||(nodes[id]={disabled:false,attrs:{},classes:new Set(),classList:{toggle(n,v){v?nodes[id].classes.add(n):nodes[id].classes.delete(n);},add(n){nodes[id].classes.add(n);}},setAttribute(n,v){this.attrs[n]=v;},getAttribute(n){return this.attrs[n]||'';},removeAttribute(n){delete this.attrs[n];}});}};
  let started=0; const context=vm.createContext({startAccountQR:()=>started++,document,accountLoginMethod:'qr',pageMode:()=> 'player',webosShell:true,accountData:{qr_login_available:true},accountQR:{snapshot:()=>({active:true,image:'https://bad',state:'pending'})},accountBusy:false,uiText:k=>k});
  vm.runInContext(source.slice(source.indexOf('  function renderAccountQR('),source.indexOf('  function cancelAccountQR(')),context);
  context.renderAccountQR();assert.ok(nodes['account-login-methods'].classes.has('is-hidden'));assert.ok(nodes['account-qr-panel'].classes.has('is-hidden'));assert.equal(nodes['account-login-qr-image'].attrs.src,undefined);
  context.webosShell=false;context.accountLoginMethod='phone';context.accountQR.snapshot=()=>({active:false});context.renderAccountQR();assert.ok(!nodes['account-login-methods'].classes.has('is-hidden'));assert.ok(nodes['account-qr-panel'].classes.has('is-hidden'));
  context.accountLoginMethod='qr';context.accountQR.snapshot=()=>({active:true,state:'pending'});context.renderAccountQR();assert.ok(!nodes['account-qr-panel'].classes.has('is-hidden'));assert.ok(nodes['account-login-form'].classes.has('is-hidden'));
  context.accountQR.snapshot=()=>({active:false,state:'idle'});context.renderAccountQR();assert.equal(started,0);
  context.pageMode=()=> 'account';context.renderAccountQR();assert.equal(started,1);
  context.accountQR.snapshot=()=>({active:false,state:'cancelled'});context.renderAccountQR();assert.equal(started,1);
  context.accountLoginMethod='phone';context.accountQR.snapshot=()=>({active:false,state:'idle'});context.renderAccountQR();assert.equal(started,1);
  const html=fs.readFileSync('core/cmd/hongguotv/ui/index.html','utf8');assert.ok(html.indexOf('id="account-method-qr"')<html.indexOf('id="account-method-phone"'));
});
