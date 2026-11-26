'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const cp=require('node:child_process');
const directory=require('../webos/service/series-directory');
const sid='9000000000000000001';
const raw=fs.readFileSync(path.join(__dirname,'../core/cmd/hongguotv/testdata/series-directory.json'),'utf8');
const fixture=()=>JSON.parse(raw.replace(/("(?:vid|series_id)"\s*:\s*)(\d{16,})/g,'$1"$2"'));

test('App directory retains exact IDs and rejects partial, duplicate, foreign and out-of-order rows',()=>{
  const result=directory.parse(fixture(),sid).directory;
  assert.equal(result.vid_list[3],'9000000000000000014');
  assert.equal(result.episodes.length,5);
  assert.equal(result.episodes[4].locked,true);
  assert.equal(result.episodes[4].locked_inferred,undefined);
  const mutations=[
    (p,v)=>{p.code=403;},(p,v)=>{v.series_id_str='9000000000000000002';},
    (p,v)=>{v.series_id='9000000000000000002';},(p,v)=>{v.video_list.pop();},
    (p,v)=>{delete v.episode_cnt;},(p,v)=>{v.has_more=true;},
    (p,v)=>{p.data[sid].has_more=true;},(p,v)=>{v.content_type=1003;},
    (p,v)=>{v.video_list[3].vid=v.video_list[0].vid;},(p,v)=>{v.video_list[3].vid='v1_preview';},
    (p,v)=>{v.video_list[3].vid='0';},(p,v)=>{v.video_list[3].vid_index=5;},
    (p,v)=>{delete v.video_list[3].vid_index;},(p,v)=>{v.video_list[3].series_id='9000000000000000002';}
  ];
  for(const change of mutations){const p=fixture();change(p,p.data[sid].video_data);assert.throws(()=>directory.parse(p,sid));}
  assert.equal(directory.complete({episode_count:5,vid_list:['1','2','3']}),false);
  assert.equal(directory.complete({episode_count:1,vid_list:['v1_preview']}),false);
  const upcoming=fixture();upcoming.data[sid].video_data.episode_cnt=0;upcoming.data[sid].video_data.video_list=[];
  assert.equal(directory.parse(upcoming,sid).directory.vid,'');
  assert.equal(directory.complete({episode_count:0,vid_list:[]}),true);
});

function lab(t,options={}){
  const calls=[];
  const file=require.resolve('../webos/service/provider'),m=new Module(file,module);
  m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
  const original=m.require.bind(m);
  m.require=name=>{
    if(name==='./__directory_clock')return {setTimeout:(fn,ms)=>setTimeout(fn,options.shortTimers?(ms===6000?15:ms===20000?40:ms):ms),clearTimeout};
    if(name!=='https')return original(name);
    return {request(reqOptions){
      const req=new EventEmitter(),chunks=[];calls.push(reqOptions);
      req.write=chunk=>chunks.push(chunk);
      req.destroy=error=>process.nextTick(()=>req.emit('error',error||Error('closed')));
      req.end=()=>process.nextTick(()=>{
        const app=reqOptions.path.startsWith('/novel/player/multi_video_detail/preload/v1');
        if(app){
          assert.equal(JSON.parse(Buffer.concat(chunks).toString()).series_id,sid);
          assert.ok(reqOptions.headers['X-Gorgon']);assert.ok(reqOptions.headers['X-Medusa']);
          assert.equal(reqOptions.headers.Cookie,undefined);
          if(options.app==='hang')return;
        }else if(options.web==='hang')return;
        const res=new PassThrough();res.statusCode=!app&&options.web==='fail'?503:200;res.headers={};req.emit('response',res);
        if(app){res.end(options.app==='invalid'?'{}':raw);return;}
        const vids=options.web==='complete'?['9000000000000000011','9000000000000000012','9000000000000000013','9000000000000000014','9000000000000000015']:['v1_first','v1_second','v1_third'];
        res.end('<script>window._ROUTER_DATA='+JSON.stringify({loaderData:{detail_page:{
          seriesDetail:options.web==='missing'?null:{series_id:options.web==='wrong'?'9000000000000000002':sid,series_name:'网页片名',series_intro:'网页简介',score:'9.1',episode_cnt:options.web==='upcoming'?0:5,vid_list:options.web==='upcoming'?[]:vids,
            celebrities:[{celebrity_id:'7377326001203713305',nickname:'演员'}]},
          related_list:[{series_id:'9000000000000000020',series_title:'相关推荐',episode_cnt:9}],
          reviews:[{review_id:'r1',user_name:'观众',content:'剧评'}]
        }}})+';</script>');
      });return req;
    }};
  };
  m._compile("var setTimeout=require('./__directory_clock').setTimeout,clearTimeout=require('./__directory_clock').clearTimeout;\n"+fs.readFileSync(file,'utf8'),file);
  t.after(()=>m.exports.closeCache());return {provider:m.exports,calls};
}
test('provider repairs the three opaque website IDs using a signed full directory without losing social metadata',async t=>{
  const f=lab(t),d=await f.provider.detail(sid);
  assert.equal(d.episodes.length,5);assert.equal(d.vid_list[3],'9000000000000000014');
  assert.equal(d.title,'网页片名');assert.equal(d.intro,'网页简介');assert.equal(d.score,'9.1');
  assert.equal(d.actors.length,1);assert.equal(d.reviews[0].content,'剧评');assert.equal(d.related.length,1);
  assert.equal(f.calls.length,2);assert.equal(d.episodes[4].locked,true);
});
test('complete numeric website avoids another request; website failure can use App metadata',async t=>{
  const good=lab(t,{web:'complete'}),d=await good.provider.detail(sid);
  assert.equal(d.episodes.length,5);assert.equal(good.calls.length,1);
  const down=lab(t,{web:'fail'}),app=await down.provider.detail(sid);
  assert.equal(app.title,'完整目录样例');assert.equal(app.episodes.length,5);
  const missing=lab(t,{web:'missing'});assert.equal((await missing.provider.detail(sid)).episodes.length,5);
  const upcoming=lab(t,{web:'upcoming'});assert.equal((await upcoming.provider.detail(sid)).episodes.length,0);assert.equal(upcoming.calls.length,1);
});
test('a failed App directory never turns a three-episode preview into a success; wrong web identity is rejected',async t=>{
  const bad=lab(t,{app:'invalid'});await assert.rejects(bad.provider.detail(sid));assert.equal(bad.calls.length,2);
  const foreign=lab(t,{web:'wrong'});await assert.rejects(foreign.provider.detail(sid));assert.equal(foreign.calls.length,1);
});
test('absolute website deadline advances to App; overall deadline aborts an unfinished App read',async t=>{
  const web=lab(t,{web:'hang',shortTimers:true});assert.equal((await web.provider.detail(sid)).episodes.length,5);
  const app=lab(t,{app:'hang',shortTimers:true});await assert.rejects(app.provider.detail(sid));assert.equal(app.calls.length,2);
});
test('packaged directory parser runs in the configured legacy Node without transpilation',()=>{
  const driver=path.join(__dirname,'fixtures/series-directory-legacy.cjs');
  cp.execFileSync(process.env.WEBOS_LEGACY_NODE||process.execPath,[driver],{timeout:15000});
});
