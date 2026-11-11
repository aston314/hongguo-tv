const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const album = require('../webos/service/creator-album');
const prefetch = require('../core/cmd/hongguotv/ui/episode-prefetch');
const fixture = require('../core/cmd/hongguotv/testdata/creator-album.json');
const id = fixture.data.album_data.album_id_str;
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const fn = name => source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'))[0];
const copy = () => JSON.parse(JSON.stringify(fixture));

test('creator directory retains official order, repeated titles, full episode count and separate album identity', () => {
 const detail = album.parse(copy(),id);
 assert.equal(detail.content_type,'1003'); assert.equal(detail.episodes.length,15);
 assert.equal(detail.vid,'7699812380099742744'); assert.equal(detail.vid_list[14],'7704677415305350168');
 for(let i=0;i<15;i++) {assert.equal(detail.episodes[i].index,i+1);assert.equal(detail.episodes[i].video_id,detail.vid_list[i]);assert.equal(detail.episodes[i].locked,false);}
 assert.deepEqual(prefetch.nextPrefetchEpisode(detail,1),{episode:2,vid:detail.vid_list[1]});
 assert.equal(prefetch.nextPrefetchEpisode(detail,15),null);
 const card=album.normalize({...fixture.data.album_data,video_detail_list:fixture.data.album_data.video_detail_list.slice(0,1)},{series_id:id});
 assert.equal(card.episode_count,15);assert.equal(card.vid,undefined);assert.equal(card.vid_list,undefined);
});
test('creator directory fails on mismatched identity, partial pages, duplicates and unexpected upload types', () => {
 for(const mutate of [p=>p.code=101001,p=>delete p.code,p=>p.data.album_data.album_id_str='999',p=>p.data.album_data.video_detail_list.pop(),
  p=>p.data.has_more=1,p=>p.data.album_data.video_detail_list[1]=p.data.album_data.video_detail_list[0],
  p=>p.data.album_data.video_detail_list[0].content_type=1004,p=>p.data.album_data.video_detail_list[0].series_id_str='bad']){
  const p=copy();mutate(p);assert.throws(()=>album.parse(p,id));
 }
 assert.equal(album.normalize(fixture.data.album_data,{series_id:'999'}),null);
});
test('shared UI requests album details, preserves history identity and maps every playback operation to creator type',async()=>{
 const calls=[],detail=album.parse(copy(),id),c={detailCache:{},Promise,fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true,data:detail})}}};
 vm.createContext(c);vm.runInContext(fn('getDetail')+'\n'+fn('playbackContentType')+'\n'+fn('basicDrama'),c);
 const card={series_id:id,content_type:'1003'},controller=new AbortController();
 assert.equal(await c.getDetail(card,controller.signal),detail);
 assert.equal(calls[0].url,'/api/v1/series/detail?series_id='+id+'&content_type=1003');assert.equal(calls[0].options.signal,controller.signal);
 assert.equal(c.playbackContentType(card),'1001');assert.equal(c.playbackContentType(detail),'1001');
 assert.equal(c.basicDrama(detail).content_type,'1003');assert.equal(c.basicDrama(detail).series_id,id);
 assert.equal(c.basicDrama(detail).vid_list,undefined);
 await c.getDetail(card);assert.equal(calls.length,1,'reuse bounded detail cache');
 await c.getDetail({series_id:'123',content_type:'1004'});assert.equal(calls[1].url,'/api/v1/series/detail?series_id=123');
 for(const type of ['1004','1','1001','',null])assert.equal(c.playbackContentType({content_type:type}),type||'');
});
