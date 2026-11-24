'use strict';
// Packaged worker only. The parent verifies downloaded bytes before sending them.
// vm is a namespace boundary, not an adversarial-code security sandbox. The
// separate process protects the account/media event loop and has a heap limit.
require('./runtime-compat');
var vm=require('vm'),fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
var RuleBuffer=require('./vendor/bytes/browser-buffer').Buffer;
var context,api,job=null,httpID=0,pending=Object.create(null),requests=0;
function send(value){if(process.connected)process.send(value);}
function bytes(value,max){var b=Buffer.from(value);if(b.length>(max||5242880))throw new Error('byte size');return b;}
function wrap(value){var b=RuleBuffer.from(value);if(b.length>5242880)throw new Error('byte size');return b;}
function host(){return {
 hash:function(name,b){b=bytes(b);if(['md5','sha256','sha512','sm3'].indexOf(name)<0)throw new Error('hash');if(name==='sm3'){try{return wrap(crypto.createHash(name).update(b).digest());}catch(ignored){return wrap(require('./passport-sign').sm3(b));}}return wrap(crypto.createHash(name).update(b).digest());},
 random:function(n){if(!Number.isSafeInteger(n)||n<0||n>4096)throw new Error('random');return wrap(crypto.randomBytes(n));},
 cipher:function(name,k,iv,data,decrypt,padding){k=bytes(k);iv=bytes(iv);data=bytes(data);if(['aes-128-cbc','aes-128-ctr'].indexOf(name)<0||k.length!==16||iv.length!==16)throw new Error('cipher');var c=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)(name,k,iv);c.setAutoPadding(!!padding);return wrap(Buffer.concat([c.update(data),c.final()]));},
 gzip:function(b,level){return wrap(zlib.gzipSync(bytes(b),{level:level}));},
 gunzip:function(b){return wrap(zlib.gunzipSync(bytes(b)));},
 http:function(method,url,headers,body,timeout){
  if(!job||job.kind!=='resolve'||++requests>24)throw new Error('HTTP unavailable');
  var id=++httpID;return new Promise(function(resolve,reject){pending[id]={resolve:resolve,reject:reject};send({type:'http',job:job.id,id:id,input:{method:method,url:url,headers:headers,body:bytes(body,16384).toString('base64')},timeout:timeout});});
 }
};}
function result(id,value){job=null;pending=Object.create(null);send({type:'result',id:id,value:value});}
function failed(id){job=null;pending=Object.create(null);send({type:'error',id:id,code:'RESOLVER_SCRIPT_FAILED'});}
process.on('message',function(message){
 if(!message||typeof message!=='object')return;
 if(message.type==='http-result'){
  var p=pending[message.id];if(!p)return;delete pending[message.id];
  if(message.error){var e=new Error('HTTP failed');e.code=message.error;p.reject(e);return;}
  var r=message.value;r.body=RuleBuffer.from(r.body||'','base64');p.resolve(r);return;
 }
 if(message.type!=='call'||job)return;
 var id=message.id;job={id:id,kind:message.kind};requests=0;
 try{
  if(message.kind==='load'){
   if(typeof message.script!=='string'||Buffer.byteLength(message.script)>1048576)throw new Error('script size');
   context=vm.createContext({Buffer:RuleBuffer,__resolverHost:host()});
   new vm.Script(fs.readFileSync(path.join(__dirname,'runtime-compat.js'),'utf8')).runInContext(context,{timeout:1000});
   api=new vm.Script(message.script,{filename:'playback-rule.js'}).runInContext(context,{timeout:1500});
   context.__rule=api;
   var metadata=new vm.Script('__rule.metadata()').runInContext(context,{timeout:1500});
   context.__vectors=JSON.stringify(message.vectors);
   var passed=new vm.Script('__rule.selfTest(__vectors)').runInContext(context,{timeout:2500});
   delete context.__vectors;
   if(!metadata||metadata.name!=='hongguo-playback-resolver'||metadata.protocol!==1||metadata.version!==message.version||passed!==4)throw new Error('self-test');
   result(id,{metadata:{name:metadata.name,protocol:metadata.protocol,version:metadata.version},passed:passed});return;
  }
  if(message.kind!=='resolve'||!api||typeof message.request!=='string'||Buffer.byteLength(message.request)>16384)throw new Error('request');
  context.__request=message.request;
  var value=new vm.Script('__rule.resolve(__request)').runInContext(context,{timeout:2000});delete context.__request;
  Promise.resolve(value).then(function(text){if(typeof text!=='string'||Buffer.byteLength(text)>262144){failed(id);return;}result(id,text);},function(){failed(id);});
 }catch(ignored){failed(id);}
});
process.on('disconnect',function(){process.exit(0);});
