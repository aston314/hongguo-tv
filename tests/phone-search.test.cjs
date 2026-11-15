const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {create}=require('../core/cmd/hongguotv/ui/phone-search');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture() {
  const requests=[],states=[],values=[],timers=[];let eligible=true;
  const phone=create({request:(method,id,ack,ready)=>new Promise((resolve,reject)=>requests.push({method,id,ack,ready,resolve,reject})),render:s=>states.push(s),canReceive:()=>eligible,complete:q=>values.push(q),
    schedule:fn=>{const t={fn,active:true};timers.push(t);return t},unschedule:t=>{if(t)t.active=false}});
  return {phone,requests,states,values,timers,eligible:value=>eligible=value,tick:()=>{const t=timers.find(t=>t.active);assert(t);t.active=false;t.fn()}};
}
function ready(r,session='lease') {r.resolve({state:'waiting',session,qr:'data:image/png;base64,fixture'})}
test('one reusable lease receives multiple searches, acknowledges responses and ignores duplicates',async()=>{
  const f=fixture();f.phone.start();await flush();ready(f.requests[0]);await flush();
  for(let id=1;id<=2;id++) {
    f.tick();assert.equal(f.requests.at(-1).ack,id-1);f.requests.at(-1).resolve({state:'completed',id,value:'劇名'+id});await flush();
    f.tick();assert.equal(f.requests.at(-1).ack,id);f.requests.at(-1).resolve({state:'completed',id,value:'劇名'+id});await flush();
  }
  assert.deepEqual(f.values,['劇名1','劇名2']);assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
});
test('page departure and background cancel polling and discard late searches',async()=>{
  const f=fixture();f.phone.start();await flush();ready(f.requests[0]);await flush();f.tick();const late=f.requests[1];
  f.phone.stop();late.resolve({state:'completed',id:1,value:'迟到'});await flush();
  assert.equal(f.requests.at(-1).method,'DELETE');assert.deepEqual(f.values,[]);assert.equal(f.timers.filter(t=>t.active).length,0);
  assert.equal(f.phone.snapshot().state,'closed');
});
test('late activation is retired before a new activation and its cancellation cannot target the new lease',async()=>{
  const f=fixture();f.phone.start();await flush();f.phone.stop();f.phone.start();await flush();assert.equal(f.requests.length,1);
  ready(f.requests[0],'old');await flush();assert.equal(f.requests[1].method,'DELETE');assert.equal(f.requests[1].id,'old');
  ready(f.requests[2],'new');await flush();f.tick();assert.equal(f.requests.at(-1).id,'new');
});
test('overlay ineligibility clears pending input without stealing focus and transport failures stop after three polls',async()=>{
  const f=fixture();f.phone.start();await flush();ready(f.requests[0]);await flush();
  f.eligible(false);f.tick();assert.equal(f.requests.at(-1).ready,false);f.requests.at(-1).resolve({state:'completed',id:1,value:'不应执行'});await flush();assert.deepEqual(f.values,[]);
  for(let i=0;i<3;i++){f.tick();f.requests.at(-1).reject(Error('offline'));await flush()}
  assert.equal(f.phone.snapshot().state,'unavailable');assert.equal(f.timers.filter(t=>t.active).length,0);
});
test('invalid text and expired service leases stop without applying a query',async()=>{
  for(const data of [{state:'expired'},{state:'completed',id:1,value:'x'.repeat(101)},{state:'completed',id:1,value:'x\0y'}]) {
    const f=fixture();f.phone.start();await flush();ready(f.requests[0]);await flush();f.tick();f.requests.at(-1).resolve(data);await flush();
    assert.equal(f.phone.snapshot().state,'unavailable');assert.deepEqual(f.values,[]);
  }
});
test('app search gating requires the visible search page and excludes foreground dialogs and desktop',()=>{
  const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
  const code=source.slice(source.indexOf('  function canReceivePhoneSearch('),source.indexOf('  function renderPhoneSearchScan('));
  const c={desktopShell:false,applicationInBackground:false,applicationHidden:()=>false,pageMode:()=> 'search',detailModalOpen:false,actorWorksOpen:false,confirmOpen:false,supportModalOpen:false,accountKeypadOpen:()=>false,
    phoneSearch:{start(){c.started++},stop(){c.stopped++}},started:0,stopped:0};vm.createContext(c);vm.runInContext(code,c);
  assert(c.canReceivePhoneSearch());c.syncPhoneSearch();assert.equal(c.started,1);
  for(const key of ['desktopShell','applicationInBackground','detailModalOpen','actorWorksOpen','confirmOpen','supportModalOpen']){c[key]=true;assert.equal(c.canReceivePhoneSearch(),false);c[key]=false}
  c.pageMode=()=> 'player';assert.equal(c.canReceivePhoneSearch(),false);c.syncPhoneSearch();assert.equal(c.stopped,1);
  c.pageMode=()=> 'search';c.applicationHidden=()=>true;c.syncPhoneSearch();assert.equal(c.stopped,2);
});
