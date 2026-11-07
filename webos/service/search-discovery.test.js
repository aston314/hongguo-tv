'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var discovery = require('./search-discovery');
function normalize(row) { return { series_id: String(row.series_id), title: row.title }; }
function fixture() {
  return { code:0, data:[{lynx_data:JSON.stringify([
    {cell_name:'猜你想搜', search_tag_data:[{tag_title:'都市逆袭'}]},
    {cell_data:[
      {cell_name:'热搜榜', video_data:[{series_id:'7391234567890123456',title:'漫剧样例',content_type:1004,card_tips:'120万热搜值'}, {series_id:'7391234567890123457',title:'短剧样例',content_type:1}, {series_id:'0',title:'无效',content_type:1}, {series_id:'7391234567890123458',title:'小说',content_type:3}]},
      {cell_name:'预约榜',video_data:[{series_id:'123',title:'未开播'}]}
    ]}
  ])}]};
}
test('current Lynx tags and generic board classify explicit types and preserve exact IDs', function () {
  var result=discovery.parse(fixture(),normalize,JSON.parse);
  assert.equal(result.guesses[0].query,'都市逆袭');
  assert.deepEqual(result.boards.map(function(b){return b.id;}),['short','comic']);
  assert.equal(result.boards[0].items[0].position,2);
  assert.equal(result.boards[1].items[0].series_id,'7391234567890123456');
  assert.equal(result.boards[1].items[0].search_score,'120万热搜值');
  assert.throws(function(){ discovery.parse({code:1},normalize,JSON.parse); });
  assert.deepEqual(discovery.parse({code:0,data:[{lynx_data:'invalid'}]},normalize,JSON.parse),{guesses:[],boards:[]});
});
test('webOS coalesces hot reads and independently caches optional failures', async function () {
  var reads=0, stamp=100, reject=false;
  var read=discovery.create({now:function(){return stamp;},normalize:normalize,decode:JSON.parse,request:async function(query){
    reads++; assert.equal(query.from,'search_input_page'); assert.equal(query.user_is_login,'0');
    if(reject)throw Error('offline'); return fixture();
  }});
  var values=await Promise.all([read(),read()]); assert.equal(reads,1); assert.equal(values[0].boards.length,2);
  await read(); assert.equal(reads,1);
  stamp+=600001; reject=true; await assert.rejects(read()); await assert.rejects(read()); assert.equal(reads,2);
  stamp+=60001; reject=false; assert.equal((await read()).boards.length,2); assert.equal(reads,3);
});
test('provider makes a bounded, signed anonymous read and keeps full series IDs', async function () {
  var https=require('https'), EventEmitter=require('events'), PassThrough=require('stream').PassThrough;
  var original=https.request, calls=0;
  https.request=function(options){
    calls++; var req=new EventEmitter(); req.write=function(){}; req.destroy=function(error){if(error)req.emit('error',error);};
    assert.ok(options.path.indexOf('/reading/bookapi/plan/v1/?')===0);
    var params=new URL('https://fixture'+options.path).searchParams;
    assert.equal(params.get('user_is_login'),'0'); assert.equal(params.get('search_middle_page_version'),'4');
    assert.ok(options.headers['X-Gorgon']); assert.equal(options.headers['X-Tt-Token'],undefined);
    req.end=function(){process.nextTick(function(){var res=new PassThrough();res.statusCode=200;res.headers={};req.emit('response',res);res.end(JSON.stringify(fixture()));});};
    return req;
  };
  try {
    delete require.cache[require.resolve('./provider')];
    var provider=require('./provider'); var data=await provider.searchDiscovery();
    assert.equal(data.boards[1].items[0].series_id,'7391234567890123456');
    await provider.searchDiscovery(); assert.equal(calls,1);
  } finally { https.request=original; }
});
