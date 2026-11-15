const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const create=require('../webos/service/phone-search');
function request(method,target,body,headers={}) {
  return new Promise((resolve,reject)=>{
    const bytes=body===undefined?'':JSON.stringify(body);
    const req=http.request(target,{method,agent:false,headers:{'Content-Type':'application/json',...headers}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(text)}catch{}resolve({status:res.statusCode,data,text,headers:res.headers})});
    });req.on('error',reject);req.end(bytes);
  });
}
async function fixture(t,dir) {
  dir=dir||fs.mkdtempSync(path.join(os.tmpdir(),'hongguo-phone-search-'));
  let now=Date.now();
  const manager=create({dataDir:dir,selectIP:()=> '127.0.0.1',now:()=>now});
  t.after(()=>manager.close());
  const start=await manager.start(),saved=JSON.parse(fs.readFileSync(path.join(dir,'phone-search.json')));
  return {manager,start,saved,dir,url:`http://127.0.0.1:${saved.port}/search/${saved.token}/`,advance:ms=>now+=ms};
}
test('webOS phone search accepts repeated Traditional Chinese queries and acknowledges each exactly once',async t=>{
  const f=await fixture(t);t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  for(const [i,query] of ['  繁體   劇名 ','第二部劇'].entries()) {
    const state=await request('GET',f.url+'state');assert.equal(state.data.ready,true);
    const sent=await request('POST',f.url+'state',{nonce:state.data.nonce,query});assert.equal(sent.status,200);
    assert.equal((await request('POST',f.url+'state',{nonce:state.data.nonce,query})).status,409);
    const value=f.manager.poll(f.start.session,i,true,false);assert.equal(value.state,'completed');assert.equal(value.id,i+1);assert.equal(value.value,query.trim().replace(/\s+/g,' '));
    assert.deepEqual(f.manager.poll(f.start.session,i,true,false),value);
    assert.equal(f.manager.poll(f.start.session,value.id,true,false).state,'waiting');
  }
  const savedInfo=fs.statSync(path.join(f.dir,'phone-search.json'));
  if(process.platform!=='win32') assert.equal(savedInfo.mode&0o777,0o600);
});
test('webOS bookmark and port survive restart while every foreground lease gets a fresh form key',async t=>{
  const f=await fixture(t);t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  const old=(await request('GET',f.url+'state')).data;
  f.manager.poll(f.start.session,0,false,true);
  assert.equal((await request('GET',f.url+'state')).data.ready,false);
  assert.equal((await request('POST',f.url+'state',{nonce:old.nonce,query:'停止'})).status,409);
  const second=await f.manager.start();assert.equal(second.qr,f.start.qr);assert.notEqual(second.session,f.start.session);
  assert.equal(f.manager.poll(f.start.session,0,true,true).state,'expired');
  assert.equal((await request('POST',f.url+'state',{nonce:old.nonce,query:'旧表单'})).status,409);
  f.manager.close();
  const restored=await fixture(t,f.dir);assert.equal(restored.url,f.url);assert.equal(restored.start.qr,f.start.qr);
});
test('webOS stale lease, inactive page, abandoned heartbeat and bounded pending input cannot search',async t=>{
  const f=await fixture(t);t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  let state=(await request('GET',f.url+'state')).data;
  await request('POST',f.url+'state',{nonce:state.nonce,query:'已发送'});
  state=(await request('GET',f.url+'state')).data;assert.equal(state.pending,true);
  assert.equal((await request('POST',f.url+'state',{nonce:state.nonce,query:'不能覆盖'})).data.error,'PENDING_INPUT');
  f.manager.poll(f.start.session,0,false,false);assert.equal(f.manager.poll(f.start.session,0,true,false).state,'waiting');
  f.advance(10001);assert.equal(f.manager.poll(f.start.session,0,true,false).state,'expired');
  const inactive=(await request('GET',f.url+'state')).data;assert.equal(inactive.ready,false);assert.equal(inactive.nonce,undefined);
  assert.equal((await request('POST',f.url+'state',{nonce:state.nonce,query:'不能恢复'})).status,409);
});
test('webOS delayed phone upload cannot reach a replacement search page',async t=>{
  const f=await fixture(t);t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  const state=(await request('GET',f.url+'state')).data;
  const body=JSON.stringify({nonce:state.nonce,query:'旧页面搜索'});
  let upload;
  const response=new Promise((resolve,reject)=>{
    upload=http.request(f.url+'state',{method:'POST',agent:false,headers:{'Content-Type':'application/json'}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });upload.on('error',reject);upload.write(body.slice(0,1));
  });
  // A second request round-trip guarantees the server has processed the headers.
  await request('GET',f.url+'state');
  assert.equal(f.manager.poll(f.start.session,0,false,true).state,'closed');
  const next=await f.manager.start();
  upload.end(body.slice(1));
  assert.equal(await response,409);
  assert.equal(f.manager.poll(next.session,0,true,false).state,'waiting');
});
test('webOS phone listener exposes only search assets and rejects wrong host, origin, capability and invalid input',async t=>{
  const f=await fixture(t);t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  const root=new URL(f.url).origin;
  for(const target of [root+'/api/v1/account',root+'/search/wrong/state']) assert.equal((await request('GET',target)).status,404);
  assert.equal((await request('GET',f.url+'state',undefined,{Host:'attacker.invalid'})).status,404);
  assert.equal((await request('POST',f.url+'state',{}, {Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await request('DELETE',f.url+'state')).status,405);
  const state=(await request('GET',f.url+'state')).data;
  for(const query of ['', '字'.repeat(101), '剧\0名']) assert.equal((await request('POST',f.url+'state',{nonce:state.nonce,query})).status,400);
  for(const asset of ['', 'mobile.js']) {
    const result=await request('GET',f.url+asset);assert.equal(result.status,200);assert(result.text.length>100);
    assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['access-control-allow-origin'],undefined);
  }
});
test('webOS port conflict chooses a new saved address and shutdown closes the listener',async t=>{
  const f=await fixture(t);t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));f.manager.close();
  const occupied=http.createServer((_,res)=>res.end());await new Promise(r=>occupied.listen(f.saved.port,'127.0.0.1',r));t.after(()=>occupied.close());
  const next=await fixture(t,f.dir);assert.notEqual(next.saved.port,f.saved.port);assert.equal(next.saved.token,f.saved.token);
  next.manager.close();await assert.rejects(request('GET',next.url+'state'));
});

test('webOS core routes keep reusable search separate from one-time input and close it on shutdown',async t=>{
  const f=await fixture(t);t.after(()=>fs.rmSync(f.dir,{recursive:true,force:true}));
  const createService=require('../webos/service/service');
  const service=createService({service:{register(){}},provider:{},account:{},numberInput:{close(){}},phoneSearch:f.manager,updates:{},port:0});
  await service.ensureReady();t.after(()=>service.shutdown());
  const endpoint=`http://127.0.0.1:${service.address().port}/api/v1/search/phone`;
  const opened=await request('POST',endpoint,{});assert.equal(opened.status,200);assert.equal(opened.data.data.qr,f.start.qr);
  const session=opened.data.data.session;
  const state=(await request('GET',f.url+'state')).data;
  await request('POST',f.url+'state',{nonce:state.nonce,query:'手機搜尋'});
  const polled=await request('GET',endpoint+'?session='+session+'&ready=1');assert.equal(polled.data.data.value,'手機搜尋');
  assert.equal((await request('DELETE',endpoint+'?session='+session)).data.data.state,'closed');
  assert.equal((await request('POST',endpoint,{}, {Origin:'https://attacker.invalid'})).status,403);
  await service.shutdown();await assert.rejects(request('GET',f.url+'state'));
});
