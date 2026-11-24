const {test}=require('node:test'),assert=require('node:assert/strict');
require('../webos/service/runtime-compat');
const create=require('../webos/service/announcements');
test('webOS announcements use explicit enable/expiry, platform and safe actions',async()=>{
 const now=Date.now();const service=create({now:()=>now,read:async()=>({schema:1,channel:'stable',items:[
 {id:'missing',title:'no'},{id:'expired',enabled:true,title:'old',expires_at:new Date(now-100).toISOString()},
 {id:'android',enabled:true,title:'android',platforms:['android']},
 {id:'live',enabled:true,title:'notice',platforms:['webos'],action:{type:'repair_playback',min_revision:7,url:'evil'}}]})});
 const items=await service.active('webos','1');assert.equal(items.length,1);assert.deepEqual(items[0].action,{type:'repair_playback',label:'',min_revision:7});
});
test('webOS malformed proxy data falls back; cached notices expire even offline',async()=>{
 let now=Date.now(),calls=0;const service=create({now:()=>now,read:async()=>{calls++;if(calls===1)throw Error('proxy');if(calls>2)throw Error('offline');return {schema:1,channel:'stable',items:[{id:'live',enabled:true,title:'notice',expires_at:new Date(now+1000).toISOString()}]};}});
 assert.equal((await service.active('webos','1')).length,1);now+=301000;assert.equal((await service.active('webos','1')).length,0);
});
