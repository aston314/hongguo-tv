const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create,eligible}=require('../core/cmd/hongguotv/ui/playback-repair.js');
const base={supported:true,enabled:false,checking:false,source:'native',event:'native',change:0};
const payload=data=>({ok:true,data:{...base,...data}});
const opts=request=>({request,setTimeout:()=>1,clearTimeout:()=>{}});
test('repair suggestion is restricted to model/address failures with the option off',()=>{
 for(const stage of ['video_tab','multi_video_model','video_model','fallback_api'])assert.equal(eligible({stage,code:'VIDEO_MODEL_EMPTY'},base),true);
 for(const failure of [{stage:'media_download',code:'MEDIA_DOWNLOAD_FAILED'},{stage:'media_decrypt',code:'MEDIA_DECRYPT_FAILED'},{stage:'video_tab',code:'ACCOUNT_EXPIRED'},{stage:'playback_prepare',code:'PLAYBACK_PREPARE_FAILED'},{stage:'device_register',code:'INVALID_DEVICE_ID'}])assert.equal(eligible(failure,base),false);
 assert.equal(eligible({stage:'video_tab',code:'VIDEO_MODEL_EMPTY'},{...base,enabled:true}),false);
 assert.equal(eligible({stage:'video_tab',code:'VIDEO_MODEL_EMPTY'},{...base,supported:false}),false);
});
test('enable, background check and restore are independent of native decoding',async()=>{
 const actions=[];const c=create(opts(async action=>{actions.push(action);return payload(action==='enable'?{enabled:true,source:'repair',version:'v1',change:1}:action==='restore'?{change:2}:{});}));
 await c.refresh();assert.equal(c.snapshot().enabled,false);
 const result=await c.enableAndWait(()=>true);assert.equal(result.source,'repair');
 await c.act('restore');assert.equal(c.snapshot().enabled,false);assert.deepEqual(actions,[null,'enable','restore']);c.destroy();
});
test('late GET cannot overwrite a newer saved option',async()=>{
 let release;const c=create(opts(action=>action?Promise.resolve(payload({enabled:true,checking:true,change:3})):new Promise(r=>release=r)));
 const stale=c.refresh();await c.act('enable');release(payload({change:1}));await stale;
 assert.equal(c.snapshot().enabled,true);c.destroy();
});
test('navigation during enable-and-retry prevents stale playback',async()=>{
 const c=create(opts(async()=>payload({enabled:true,source:'repair',change:1})));
 await assert.rejects(c.enableAndWait(()=>false),{name:'AbortError'});c.destroy();
});
test('download failure preserves current resolver and is not a successful repair',async()=>{
 const c=create(opts(async()=>payload({enabled:true,event:'check_failed',checking:false,change:1})));
 await assert.rejects(c.enableAndWait(()=>true));assert.equal(c.snapshot().source,'native');c.destroy();
});
test('background polling never writes preferences and manual updates deduplicate announcements',async()=>{
 let notify=0,mode=0,scheduled=0;const actions=[];
 const c=create({...opts(async action=>{actions.push(action);return payload({enabled:true,source:'repair',event:mode?'updated':'up_to_date',change:mode?2:1});}),setTimeout:()=>{scheduled++;return 1;},updated:()=>notify++,visible:()=>false});
 await c.refresh();mode=1;await c.refresh();await c.refresh();assert.equal(notify,1);assert.deepEqual(actions,[null,null,null]);assert.equal(scheduled,0);c.destroy();
});

const {view}=require('../core/cmd/hongguotv/ui/playback-repair.js');
const profile={automatic:true,format:'json',source:'embedded',version:'builtin.1',event:'embedded_ready',checking:false,change:0};
test('current priority follows an actual JS rule, never just the saved switch',()=>{
 const data={...base,native_profile:profile};
 assert.deepEqual(view(data),{nameKey:'defaultRule',format:'JSON',version:'builtin.1',checking:false,lastChecked:0,statusKey:'defaultReady',automatic:true});
 assert.equal(view({...data,enabled:true}).nameKey,'defaultRule');
 assert.equal(view({...data,enabled:true}).statusKey,'pendingDefault');
 assert.equal(view({...data,enabled:true,source:'repair',version:'js.2',revision:9}).format,'JS');
 assert.equal(view({...data,enabled:false,source:'repair',version:'js.2'}).format,'JSON');
 assert.equal(view({...data,enabled:true,source:'native',event:'remote_disabled'}).statusKey,'disabled');
 assert.equal(view(base).nameKey,'builtinRule');
 assert.equal(view({...data,native_profile:{...profile,source:'downloaded',version:'json.3',revision:3}}).version,'json.3');
});
test('JSON checks are displayed and polled with JS off without changing JS state or announcement revisions',async()=>{
 let remote={...base,revision:0,native_profile:{...profile,checking:true,event:'checking',change:1}},scheduled=[];
 const c=create({...opts(async()=>({ok:true,data:remote})),setTimeout:(fn,ms)=>{scheduled.push(ms);return 1;},visible:()=>false});
 await c.refresh();assert.equal(c.snapshot().checking,false);assert.equal(c.snapshot().enabled,false);assert.equal(c.snapshot().revision,0);
 assert.equal(view(c.snapshot()).checking,true);assert.equal(view(c.snapshot()).statusKey,'checking');assert.deepEqual(scheduled,[800]);
 scheduled=[];remote={...remote,native_profile:{...profile,last_checked:1200,event:'check_failed',change:2}};await c.refresh();assert.equal(view(c.snapshot()).statusKey,'failed');assert.equal(view(c.snapshot()).lastChecked,1200);assert.equal(c.snapshot().checking,false);assert.deepEqual(scheduled,[]);c.destroy();
});
test('late status reads cannot overwrite a completed JSON check even when JS change is identical',async()=>{
 let release;let actionCalls=[];
 const c=create(opts(action=>{actionCalls.push(action);return action?Promise.resolve(payload({native_profile:{...profile,version:'json.2',change:2,last_checked:2000}})):new Promise(resolve=>release=resolve);}));
 const read=c.refresh();await c.act('check');release(payload({native_profile:{...profile,version:'json.1',change:1,last_checked:1000}}));await read;
 assert.equal(view(c.snapshot()).version,'json.2');assert.equal(c.snapshot().enabled,false);assert.deepEqual(actionCalls,[null,'check']);c.destroy();
});
test('JSON alone cannot satisfy JS enable-and-retry or report a JS announcement ready',async()=>{
 const c=create(opts(async()=>payload({enabled:true,event:'check_failed',native_profile:{...profile,source:'downloaded',version:'json.2',revision:99,event:'updated'}})));
 await assert.rejects(c.enableAndWait(()=>true));
 const {repairState}=require('../core/cmd/hongguotv/ui/announcements.js');assert.equal(repairState({type:'repair_playback',min_revision:1},c.snapshot()),'announcementPending');assert.equal(c.snapshot().source,'native');assert.equal(c.snapshot().revision,undefined);c.destroy();
});
test('failed and disabled JSON checks retain current default identity without false latest status',()=>{
 for(const event of ['check_failed','update_unavailable','candidate_rejected'])assert.equal(view({...base,native_profile:{...profile,event,last_checked:2000}}).statusKey,'failed');
 assert.equal(view({...base,native_profile:{...profile,event:'remote_disabled',last_checked:2000}}).statusKey,'defaultDisabled');
 assert.equal(view({...base,native_profile:{...profile,event:'up_to_date',last_checked:2000}}).statusKey,'latest');
 assert.equal(view({...base,native_profile:{...profile,event:'updated',last_checked:2000}}).statusKey,'ready');
});
test('a historic JS check does not claim an unchecked default JSON is latest',()=>{
 const state={...base,last_checked:1000,native_profile:profile};assert.equal(view(state).lastChecked,1000);assert.equal(view(state).statusKey,'defaultReady');
});
