'use strict';
// Executed by the actual target Node, including 0.12. No modern syntax here.
var assert=require('assert'),fs=require('fs'),path=require('path');
var root=path.resolve(__dirname,'../..');require(path.join(root,'webos/service/runtime-compat'));
var runtime=require(path.join(root,'webos/service/playback-rule-runtime'));
var script=fs.readFileSync(path.join(root,'core/internal/jsresolver/resolver.js'));
var regs=0,tabs=0,fallbackMode=false,v5Calls=0,codecs=[],worker=runtime({http:function(input){
 var u=require('url').parse(input.url,true),body;
 if(u.pathname==='/service/2/device_register/'){regs++;body='{"device_id":7390000000000000001,"install_id":7390000000000000002}';}
 else if(u.pathname==='/fallback'){
  codecs.push(String(u.query.codec_type));var compatible={video_id:'123',video_duration:90,video_list:{q:{codec_type:u.query.codec_type==='3'?'h265':'bytevc2',definition:'720P',vwidth:1280,vheight:720,main_url:'https://cdn.example/episode.mp4'}}};body=JSON.stringify({code:0,video_info:{code:0,data:compatible}});
 }else if(fallbackMode&&u.pathname==='/novel/player/multi_video_model/player/v1'){
  v5Calls++;assert(input.headers['X-Medusa']);assert.strictEqual(u.query.device_id,'7390000000000000001');
  if(v5Calls===1)return Promise.resolve({status:200,body:Buffer.alloc(0)});
  var compressed=require('zlib').gunzipSync(Buffer.from(input.body,'base64'));assert.strictEqual(JSON.parse(compressed.toString('utf8')).mixed_video_id_map['1004'][0],'123');
  var model={video_id:'123',video_duration:90,fallback_api:'https://api.fqnovel.com/fallback?signed=a%2Fb&codec_type=4',video_list:{q:{codec_type:'bytevc2',definition:'720P',vwidth:1280,vheight:720,main_url:'https://cdn.example/episode.mp4'}}};body=JSON.stringify({code:0,data:{'1004':{'123':{video_model:model}}}});
 }else {assert.strictEqual(u.pathname,'/reading/bookapi/video_tab/multi_video_model/v1/');assert.strictEqual(u.query.device_id,'7390000000000000001');tabs++;if(fallbackMode)return Promise.resolve({status:200,body:Buffer.alloc(0)});body=JSON.stringify({code:0,data:{video_model_data:{'123':{video_model:{video_id:'123',video_duration:90,video_list:{q:{codec_type:'h265',definition:'720P',vwidth:1280,vheight:720,main_url:'https://cdn.example/episode.mp4'}}}}}}});}
 return Promise.resolve({status:200,body:Buffer.from(body),cookies:{}});
}});
var timer=setTimeout(function(){console.error('rule runtime probe timeout');worker.close().then(function(){process.exit(1);});},16000),pid;
worker.load(script,'2026.11.24.1').then(function(meta){assert.strictEqual(meta.passed,4);pid=worker.child.pid;return worker.resolve({vid:'123',codec_mode:'default',content_type:'1004'});}).then(function(options){
 assert.strictEqual(options[0].codec,'h265');assert.strictEqual(options[0].quality,'720P');return worker.resolve({vid:'123'});
}).then(function(){assert.strictEqual(worker.child.pid,pid);assert.strictEqual(regs,1);assert.strictEqual(tabs,2);fallbackMode=true;return worker.resolve({vid:'123',content_type:'1004'});}).then(function(options){assert.strictEqual(options[0].codec,'h265');assert.strictEqual(v5Calls,2);assert.deepEqual(codecs,['4','1','0','3']);assert.strictEqual(worker.child.pid,pid);return worker.close();}).then(function(){
 assert.strictEqual(worker.child,null);clearTimeout(timer);console.log('webOS rule runtime '+process.version+': shared bundle, independent signing vectors, exact IDs, real child IPC, reuse and cleanup PASS');
},function(error){console.error(error.stack||error);worker.close().then(function(){process.exit(1);});});
