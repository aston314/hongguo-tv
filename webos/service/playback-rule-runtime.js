'use strict';
require('./runtime-compat');
var fork=require('child_process').fork,path=require('path'),network=require('./playback-rule-network'),cancel=require('./audio-cancel');
var fault=require('./playback-rule-verifier').fault,trust=require('./playback-rule-trust');
function Runtime(options){this.options=options||{};this.child=null;this.current=null;this.sequence=0;this.closed=false;this.broken=false;this.failureCode='';this.tail=Promise.resolve();this.exitWait=Promise.resolve();}
Runtime.prototype.start=function(){
 var self=this;if(self.closed)throw fault('RESOLVER_CLOSED');if(self.child)return;
 // Do not inherit service/account environment, inspectors or exec arguments.
 var env={};['PATH','LD_LIBRARY_PATH','LD_PRELOAD','TZ','LANG'].forEach(function(k){if(k!=='LD_PRELOAD'&&process.env[k])env[k]=process.env[k];});
 var child=fork(path.join(__dirname,'playback-rule-worker.js'),[],{env:env,execArgv:['--max-old-space-size=48'],silent:true});self.child=child;
 self.exitWait=new Promise(function(resolve){
  child.once('exit',function(){if(self.child===child){self.child=null;self.broken=true;self.failureCode='RESOLVER_SCRIPT_FAILED';if(self.current)self.fail(fault('RESOLVER_SCRIPT_FAILED'));}resolve();});
  child.once('error',function(){if(self.child===child){self.child=null;self.broken=true;self.failureCode='RESOLVER_SCRIPT_FAILED';if(self.current)self.fail(fault('RESOLVER_SCRIPT_FAILED'));}resolve();});
 });
 if(child.stdout)child.stdout.resume();if(child.stderr)child.stderr.resume();
 child.on('message',function(m){
  var current=self.current;if(!current||self.child!==child||!m||typeof m!=='object')return;
  if(m.type==='http'){
   if(m.job!==current.id||current.kind!=='resolve'||++current.requests>24||!Number.isSafeInteger(m.id)){self.fail(fault('RESOLVER_SCRIPT_FAILED'));return;}
   var work=current.httpTail.then(function(){if(self.current!==current||self.child!==child)throw fault('RESOLVER_CANCELLED');var remaining=Math.max(1,Math.min(8000,current.deadline-Date.now(),Number(m.timeout)||8000));return (self.options.http||network.http)(m.input,current.cancel.signal,remaining);});current.httpTail=work.catch(function(){});
   work.then(function(r){if(self.current!==current||self.child!==child)return;child.send({type:'http-result',id:m.id,value:{status:r.status,body:r.body.toString('base64'),cookies:r.cookies||{},retry_after:!!r.retry_after,location:r.location||''}},null,function(){});},function(e){if(self.current!==current||self.child!==child)return;child.send({type:'http-result',id:m.id,error:e&&e.code==='UPSTREAM_TIMEOUT'?'UPSTREAM_TIMEOUT':'RULE_NETWORK_FAILED'},null,function(){});});return;
  }
  if(m.id!==current.id)return;
  if(m.type==='error'){self.fail(fault('RESOLVER_SCRIPT_FAILED'));return;}
  if(m.type==='result'){self.current=null;current.finish();current.resolve(m.value);}
 });
};
Runtime.prototype.fail=function(error){this.broken=true;this.failureCode=error.code||'RESOLVER_SCRIPT_FAILED';var c=this.current;if(c){this.current=null;c.finish();c.reject(error);}var child=this.child;this.child=null;if(child)try{child.kill('SIGKILL');}catch(ignored){};};
Runtime.prototype.call=function(kind,payload,signal,timeout){
 var self=this,ticket={},deadline=Date.now()+timeout,expired=false;
 var work=self.tail.catch(function(){}).then(function(){if(!self.child)return self.exitWait;}).then(function(){
  if(self.closed)throw fault('RESOLVER_CLOSED');if(self.broken)throw fault(self.failureCode);if(expired)throw fault('UPSTREAM_TIMEOUT');if(signal&&signal.aborted)throw fault('RESOLVER_CANCELLED');self.start();
  return new Promise(function(resolve,reject){
   var id=++self.sequence,control=cancel.create();
   var current={id:id,ticket:ticket,kind:kind,requests:0,httpTail:Promise.resolve(),deadline:deadline,cancel:control,resolve:resolve,reject:reject,finish:function(){control.abort();}};
   self.current=current;
   var message=Object.assign({type:'call',id:id,kind:kind},payload);
   self.child.send(message,null,function(error){if(error&&self.current===current)self.fail(fault('RESOLVER_SCRIPT_FAILED'));});
  });
 });
 self.tail=work.catch(function(){});
 return new Promise(function(resolve,reject){
  var finished=false,timer=setTimeout(function(){expired=true;stop(fault('UPSTREAM_TIMEOUT'));},Math.max(1,deadline-Date.now()));
  function cleanup(){clearTimeout(timer);if(signal)signal.removeEventListener('abort',aborted);}
  function stop(error){if(finished)return;finished=true;cleanup();if(self.current&&self.current.ticket===ticket)self.fail(error);reject(error);}
  function aborted(){stop(fault('RESOLVER_CANCELLED'));}
  if(signal)signal.addEventListener('abort',aborted);if(signal&&signal.aborted)aborted();
  work.then(function(v){if(finished)return;finished=true;cleanup();resolve(v);},stop);
 });
};
Runtime.prototype.load=function(script,version,signal){return this.call('load',{script:script.toString('utf8'),version:version,vectors:trust.vectors},signal,5000);};
Runtime.prototype.resolve=function(request,signal,timeout){if(!request||!/^[0-9]{1,32}$/.test(request.vid)||!/^\d{1,16}$/.test(request.content_type||'1004')||['','default','standard','auto','mpv_auto','software','mpv_software'].indexOf(request.codec_mode||'')<0)return Promise.reject(fault('INVALID_VIDEO_ID'));return this.call('resolve',{request:JSON.stringify(request)},signal,timeout||8000).then(function(text){
 var r;try{r=JSON.parse(text);}catch(ignored){throw fault('RESOLVER_SCRIPT_FAILED');}
 if(!r||typeof r!=='object'||Array.isArray(r))throw fault('RESOLVER_SCRIPT_FAILED');
 if(r.error_code){if(!/^[A-Z0-9_]{1,64}$/.test(r.error_code)||!/^[a-z_]{1,40}$/.test(r.error_stage))throw fault('RESOLVER_SCRIPT_FAILED');var e=fault(r.error_code);e.stage=r.error_stage;throw e;}
 if(!Array.isArray(r.options)||!r.options.length||r.options.length>32)throw fault('RESOLVER_SCRIPT_FAILED');
 return r.options.map(function(o){if(!o||typeof o!=='object')throw fault('RESOLVER_SCRIPT_FAILED');var u;try{u=require('url').parse(o.URL);}catch(ignored){};if(!u||u.protocol!=='https:'||!u.hostname||u.auth||String(o.URL).length>8192||typeof o.Codec!=='string'||!o.Codec||/bytevc2|h266|vvc/i.test(o.Codec)||typeof o.Quality!=='string'||!o.Quality||!Number.isSafeInteger(o.Width)||o.Width<0||!Number.isSafeInteger(o.Height)||o.Height<0||!Number.isSafeInteger(o.Duration)||o.Duration<0)throw fault('RESOLVER_SCRIPT_FAILED');var key=null;if(o.Key!==null&&o.Key!==undefined){if(typeof o.Key!=='string')throw fault('RESOLVER_SCRIPT_FAILED');key=Buffer.from(o.Key,'base64');if(key.toString('base64')!==o.Key||key.length!==16)throw fault('RESOLVER_SCRIPT_FAILED');}return {url:o.URL,key:key,codec:o.Codec,width:o.Width,height:o.Height,quality:o.Quality,duration:o.Duration};});
 });};
Runtime.prototype.close=function(){this.closed=true;this.fail(fault('RESOLVER_CANCELLED'));return this.exitWait;};
module.exports=function(options){return new Runtime(options);};
