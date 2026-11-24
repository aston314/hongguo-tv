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
