const {test} = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../core/cmd/hongguotv/ui/watch-statistics.js');
function collector(start = new Date(2026, 10, 10, 12).getTime()) {
  let mono = 0, wall = start, tasks = [], sent = [], fail = null;
  const state = {key:'session:1',owner:'',eligible:true,position:0,rate:1,type:'real',tags:['悬疑','都市']};
  const c = stats.createCollector({clock:()=>wall,monotonic:()=>mono,snapshot:()=>({...state}),setTimeout:(fn)=>{tasks.push(fn);return tasks.length;},clearTimeout:()=>{},request:async b=>{sent.push(JSON.parse(JSON.stringify(b)));if(fail)throw fail;}});
  function step(ms, advance=ms/1000*state.rate) {mono+=ms;wall+=ms;state.position+=advance;c.observe();}
  const total=()=>sent.flatMap(b=>b.items).reduce((n,r)=>n+r.ms,0);
  return {c,state,step,sent,total,setFail:e=>fail=e};
}
test('counts real playback, excluding pause/buffer/seek/background and session/account changes',async()=>{
  const f=collector();f.c.observe();f.step(1000);f.step(1000);f.c.stop(true);
  f.state.eligible=false;f.step(10000,0);f.state.position=100;f.c.stop(false);
  f.state.eligible=true;f.c.observe();f.step(1000);f.state.key='session:2';f.state.position=0;f.step(1000,0);f.step(1000);
  f.c.stop(false);f.state.owner='account';f.c.observe();f.step(1000);f.c.stop(true);await f.c.flush();
  assert.equal(f.total(),5000);assert.deepEqual(f.sent.map(b=>[b.owner_id,b.items.reduce((n,r)=>n+r.ms,0)]),[['',4000],['account',1000]]);
});
test('2x speed uses elapsed wall time, rounded native clocks keep time, large stalls never backfill',async()=>{
  const f=collector();f.state.rate=2;f.c.observe();for(let i=0;i<10;i++)f.step(1000,2);
  f.state.rate=1;f.c.stop(true);f.c.observe();for(let i=0;i<4;i++)f.step(250,i===3?1:0);
  f.step(60000,60);f.step(1000);f.c.stop(true);await f.c.flush();assert.equal(f.total(),12000);
});
test('seeking forward or backward never counts as watching',async()=>{
  const f=collector();f.c.observe();f.step(1000);f.c.stop(false);f.state.position=100;f.c.observe();f.step(1000);f.c.stop(false);f.state.position=20;f.c.observe();f.step(1000);f.c.stop(true);await f.c.flush();assert.equal(f.total(),3000);
});
test('midnight divides real elapsed time between local dates',async()=>{
  const f=collector(new Date(2026,10,10,23,59,59).getTime());f.c.observe();f.step(2000);f.c.stop(true);await f.c.flush();assert.deepEqual(f.sent[0].items.map(r=>[r.day,r.ms]),[['2026-11-10',1000],['2026-11-11',1000]]);
});
test('failed delivery retries the same id, while new playback is independent',async()=>{
  const f=collector();f.c.observe();f.step(1000);f.setFail({status:503});assert.equal(await f.c.flush(),false);
  f.step(1000);f.c.stop(true);f.setFail(null);await f.c.flush();assert.equal(f.sent[0].id,f.sent[1].id);assert.notEqual(f.sent[1].id,f.sent[2].id);
});
test('daily totals respect Monday weeks/month boundaries and exclude future dates',()=>{
  const row=ms=>({ms,types:{real:ms},genres:{悬疑:ms}});
  const s=stats.summary({days:{'2026-10-31':row(1),'2026-11-01':row(2),'2026-11-08':row(4),'2026-11-09':row(8),'2026-11-10':row(16),'2026-11-11':row(32)}},'2026-11-10');
  assert.equal(s.today,16);assert.equal(s.week,24);assert.equal(s.month,30);assert.equal(s.recent.length,7);assert.equal(s.types.real,30);assert.equal(s.recent[6].day,'2026-11-10');
});
test('primary genre skips type labels, invalid tags and object prototype keys',()=>{
 assert.equal(stats.genreFor(['真人','短剧','__proto__','constructor','悬疑','都市']),'悬疑');assert.equal(stats.genreFor(['https://example','\u0000bad']),'');
});
test('recommended first-episode statistics enrich genre from details in the background and strip transient identity',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
 let calls=0;
 const context=vm.createContext({Promise,AbortController,setTimeout,clearTimeout,window:{HongguoWatchStatistics:stats},dramaType:()=>'',getDetail:async item=>{calls++;assert.equal(item.series_id,'123');return {tags:['恋爱','乡村']};}});
 vm.runInContext(source.slice(source.indexOf('  var watchStatisticsObserved ='),source.indexOf('  function watchStatisticsRequest(')),context);
 const batch={owner_id:'',id:'test-background-1',items:[{day:'2026-11-10',ms:30000,type:'real',genre:'',series_id:'123'}]};
 const enriched=await context.enrichWatchStatisticsBatch(batch);assert.equal(enriched.items[0].genre,'恋爱');assert.equal(enriched.items[0].type,'real');assert.equal(enriched.items[0].series_id,undefined);
 assert.equal(batch.items[0].genre,'');await context.enrichWatchStatisticsBatch(batch);assert.equal(calls,1);
 const nativeTags=await context.enrichWatchStatisticsBatch({...batch,items:[{...batch.items[0],series_id:'789',genre:'爱情'}]});
 assert.equal(nativeTags.items[0].genre,'爱情');assert.equal(calls,1,'existing recommendation tags never fetch details');
 context.getDetail=async()=>{throw Error('unavailable');};const fallback=await context.enrichWatchStatisticsBatch({...batch,items:[{...batch.items[0],series_id:'456'}]});assert.equal(fallback.items[0].genre,'');
 vm.runInContext(source.match(/  function dramaType\(item\) \{[\s\S]*?\n  \}/)[0],context);
 for(const [item,type] of [[{content_type:'1'},'real'],[{content_type:'1004'},'comic'],[{content_type:'1004',video_category_type:'ai_video'},'ai'],[{},'']])assert.equal(context.dramaType(item),type);
 context.rememberWatchStatisticsMetadata('456',{content_type:'1',tags:['都市']});
 const fromCard=await context.enrichWatchStatisticsBatch({...batch,items:[{...batch.items[0],series_id:'456',type:'unknown'}]});
 assert.equal(fromCard.items[0].type,'real');assert.equal(fromCard.items[0].genre,'都市');
});
