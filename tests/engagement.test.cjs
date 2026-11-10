const {test}=require('node:test');
const assert=require('node:assert/strict');
const api=require('../core/cmd/hongguotv/ui/engagement.js');
function fixture(){
 const calls=[],paints=[];
 const state=api.create({render:(target,data)=>paints.push({target,data:data&&{...data}}),request:target=>{
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});
  const call={target,resolve,reject,aborted:false};calls.push(call);return {promise,abort(){call.aborted=true}};
 }});
 return {state,calls,paints};
}
const a={series_id:'7654321098765432100',vid:'1111111111111111111'};
const b={series_id:a.series_id,vid:'2222222222222222222'};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('counts format zero, missing values, Chinese units and integer limits',()=>{
 assert.equal(api.countText(0),'0');assert.equal(api.countText(529),'529');assert.equal(api.countText(13000),'1.3万');assert.equal(api.countText(388000),'38.8万');assert.equal(api.countText(100000000),'1亿');
 for(const value of [null,undefined,-1,NaN,'529',1.3])assert.equal(api.countText(value),'—');
});
test('a late previous episode cannot overwrite current counts',async()=>{
 const f=fixture();f.state.select(a);f.state.select(b);assert.equal(f.calls[0].aborted,true);
 f.calls[1].resolve({...b,likes:5,comments:0,favorites:10,metadata:{content_type:'1',tags:['悬疑']}});await settle();
 f.calls[0].resolve({...a,likes:13000,comments:529,favorites:388000,metadata:{content_type:'1004',tags:['玄幻']}});await settle();
 assert.equal(f.paints.at(-1).data.likes,5);assert.equal(f.paints.at(-1).data.comments,0);
 assert.deepEqual(f.paints.at(-1).data.metadata,{content_type:'1',tags:['悬疑']});
});
test('clearing and changing account discard in-flight responses and cached counts',async()=>{
 const f=fixture();f.state.select(a);f.calls[0].resolve({...a,likes:4,comments:0,favorites:10});await settle();
 f.state.select(b);f.state.select(a);assert.equal(f.calls.length,2);
 f.state.resetAccount();f.calls[1].resolve({...b,likes:99,comments:1,favorites:10});await settle();
 assert.equal(f.paints.at(-1).target,null);f.state.select(a);assert.equal(f.calls.length,3);
});
test('failure and mismatched identity do not invent statistics',async()=>{
 const f=fixture();f.state.select(a);f.calls[0].resolve({...b,likes:100,comments:5,favorites:10});await settle();assert.equal(f.paints.at(-1).data,null);
 f.state.select(b);f.calls[1].reject(Error('offline'));await settle();assert.equal(f.paints.at(-1).data,null);
});
test('episode cover travels with exact-VID statistics and repeated selection renders cached cover',async()=>{
 const f=fixture();f.state.select(a);f.calls[0].resolve({...a,likes:1,favorites:2,comments:3,episode_cover:'https://img.example/episode-1.jpg'});await settle();
 assert.equal(f.paints.at(-1).data.episode_cover,'https://img.example/episode-1.jpg');
 f.state.select(a);assert.equal(f.paints.at(-1).data.episode_cover,'https://img.example/episode-1.jpg');assert.equal(f.calls.length,1);
 f.state.select(b);assert.equal(f.paints.at(-1).data,null);
});
test('confirmed changes adjust the exact episode once and preserve series favorite totals',async()=>{
 const f=fixture();f.state.select(a);f.calls[0].resolve({...a,likes:4,comments:0,favorites:10});await settle();
 f.state.adjust('like',1,b);assert.equal(f.paints.at(-1).data.likes,4);
 f.state.adjust('like',1,a);assert.equal(f.paints.at(-1).data.likes,5);
 f.state.adjust('favorite',1,a);assert.equal(f.paints.at(-1).data.favorites,11);
 f.state.commentTotal(a,529);assert.equal(f.paints.at(-1).data.comments,529);
 f.state.select(b);f.calls[1].resolve({...b,likes:1,comments:0,favorites:11});await settle();
 f.state.adjust('favorite',-1,b);f.state.select(a);assert.equal(f.paints.at(-1).data.favorites,10);assert.equal(f.paints.at(-1).data.likes,5);
});
