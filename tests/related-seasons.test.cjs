'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const related=require('../webos/service/related-seasons');
const fixtures=require('../core/cmd/hongguotv/testdata/related-seasons-20261128.json');
const normalize=row=>({
  series_id:String(row.series_id),title:row.title,season_index:Number(row.season_index)||0,
  episode_count:Number(row.episode_cnt)||0,vid:row.vid||''
});
const ids={one:'7691938290202577944',two:'7700477891418524696',three:'7708355462780947518',
  other:'7710278988953832472',single:'7693071659686693913',thirteen:'7690163276214176792',fourteen:'7702763145030290457'};

test('recorded metadata confirms differently-worded seasons, preserves upcoming and rejects same-IP season indices',async()=>{
  const calls=[],loader=related.create({normalize,request:async values=>{calls.push(values.book_id);return fixtures[values.book_id]}});
  for(const [id,next]of [[ids.one,ids.two],[ids.two,ids.three],[ids.thirteen,ids.fourteen]]){
    const result=await loader.load(id),current=result.items.find(r=>r.series_id===id);
    assert.equal(result.source,'related-seasons');
    const successor=result.items.find(r=>r.season_index===current.season_index+1);
    assert.equal(successor.series_id,next);assert.equal(successor.playable,true);
  }
  const third=await loader.load(ids.three),fourth=third.items.find(r=>r.season_index===4);
  assert.equal(fourth.upcoming,true);assert.equal(fourth.playable,false);assert.equal(fourth.vid,'');
  for(const id of [ids.other,ids.single]){
    const result=await loader.load(id);
    assert.deepEqual(result,{items:[],source:'related-no-seasons'});
  }
  assert.ok(calls.includes(ids.three),'successor needs its own reciprocal request');
});

test('missing/derived labels, duplicate seasons, conflicting titles and malformed data never authorize autoplay',()=>{
  const row={series_id:'2',title:'某剧第二季',season_index:2,content_type:1004,episode_cnt:10,vid:'21',tag_info:{text:'第2季'}};
  const payload=rows=>({code:0,data:[{show_type:547,video_data:rows}]});
  for(const tag of ['', '同IP']){
    assert.deepEqual(related.parse(payload([{...row,tag_info:{text:tag}}]),'1',normalize),[]);
  }
  for(const p of [
    {},{code:101116,data:[]},{code:0,data:{}},{code:0,data:[{show_type:547}]},
    payload([row,row]),payload([row,{...row,series_id:'3'}]),
    payload([{...row,season_index:3}]),payload([{...row,title:'某剧第三季完结篇'}])
  ])assert.throws(()=>related.parse(p,'1',normalize));
});

test('failed or wrong reciprocal relations remain errors, never successful no-season responses',async()=>{
  for(const mode of ['failure','missing','same-IP','wrong-season']){
    const loader=related.create({normalize,request:async values=>{
      if(values.book_id===ids.two)return fixtures[ids.two];
      if(values.book_id===ids.one)return fixtures[ids.one];
      if(mode==='failure')throw Error('timeout');
      const p=JSON.parse(JSON.stringify(fixtures[ids.three]));
      const cell=p.data.find(b=>b.show_type===547);
      if(mode==='missing')cell.video_data=cell.video_data.filter(r=>r.series_id!==ids.two);
      else {
        const back=cell.video_data.find(r=>r.series_id===ids.two);
        back.tag_info.text=mode==='same-IP'?'同IP':'第3季';
      }
      return p;
    }});
    await assert.rejects(loader.load(ids.two));
  }
});

function providerLab(t,mode){
  const requests=[],file=require.resolve('../webos/service/provider'),m=new Module(file,module);
  m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);
  m.require=name=>{
    if(name!=='https')return original(name);
    return {request(options){
      const req=new EventEmitter();req.write=()=>{};
      req.destroy=error=>process.nextTick(()=>req.emit('error',error||Error('closed')));
      req.end=()=>process.nextTick(()=>{
        const u=new URL('https://fixture.invalid'+options.path),query=u.searchParams;
        requests.push({host:options.hostname,path:u.pathname,query,headers:options.headers});
        const res=new PassThrough();res.statusCode=200;res.headers={};req.emit('response',res);
        if(u.pathname==='/reading/bookapi/plan/v'){
          assert.equal(query.get('from'),'single_col_same_ip_series');
          assert.ok(options.headers['X-Medusa']);
          res.end(mode==='primary'?JSON.stringify({code:0,data:[{video_data:[{
            series_id:ids.two,title:'公路求生他第二季',season_index:2,episode_cnt:172,vid:ids.two+'1'
          }]}]}):'{"code":101116}');return;
        }
        assert.equal(u.pathname,'/reading/bookapi/plan/v:version/');
        assert.equal(query.get('from'),'detail_page_more_related');assert.equal(query.get('version_code'),'72232');
        assert.ok(options.headers['X-Gorgon']);assert.ok(options.headers['X-Medusa']);
        assert.equal(options.headers.Cookie,undefined);
        if(mode==='empty')res.end(JSON.stringify(fixtures[ids.single]));
        else if(mode==='failure')res.end('{"code":101116}');
        else if(mode==='first-host-down'&&options.hostname==='api5-normal-sinfonlinec.fqnovel.com')res.end('');
        else res.end(JSON.stringify(fixtures[query.get('book_id')]));
      });return req;
    }};
  };
  m._compile(fs.readFileSync(file,'utf8'),file);
  t.after(()=>m.exports.closeCache());return {provider:m.exports,requests};
}

test('webOS provider uses complete-selector fast path and bounds related-work host fallback',async t=>{
  const normal=providerLab(t,'primary'),p=await normal.provider.seasons(ids.two);
  assert.equal(p.source,'webos-plan');assert.equal(normal.requests.length,1);
  const fallback=providerLab(t,'first-host-down'),f=await fallback.provider.seasons(ids.two);
  assert.equal(f.source,'related-seasons');
  assert.equal(f.items.find(r=>r.season_index===3).series_id,ids.three);
  assert.equal(fallback.requests.length,7,'one primary and two hosts per reciprocal read');
  const empty=providerLab(t,'empty');
  assert.deepEqual(await empty.provider.seasons(ids.single),{items:[],source:'related-no-seasons'});
  const failed=providerLab(t,'failure');
  await assert.rejects(failed.provider.seasons(ids.single));
  assert.equal(failed.requests.length,4);
});
