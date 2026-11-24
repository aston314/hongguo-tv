'use strict';
require('./runtime-compat');
var fs=require('fs'),path=require('path'),verify=require('./playback-rule-verifier'),network=require('./playback-rule-network');
var createRuntime=require('./playback-rule-runtime'),cancel=require('./audio-cancel'),fault=verify.fault;
function mkdir(dir){try{fs.mkdirSync(dir,448);}catch(e){if(e.code==='ENOENT'){mkdir(path.dirname(dir));fs.mkdirSync(dir,448);}else if(e.code!=='EEXIST')throw e;}}
function readJSON(file,max){var stat=fs.statSync(file);if(!stat.isFile()||stat.size>max)throw fault('RULE_STORAGE_REJECTED');return JSON.parse(fs.readFileSync(file,'utf8'));}
function atomic(file,value){mkdir(path.dirname(file));var temp=file+'.tmp-'+require('crypto').randomBytes(8).toString('hex'),fd;
 try{fd=fs.openSync(temp,'wx',384);var written=0;while(written<value.length){var n=fs.writeSync(fd,value,written,value.length-written,null);if(!n)throw fault('RULE_STORAGE_REJECTED');written+=n;}fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(temp,file);}finally{if(fd!==undefined&&fd!==null)try{fs.closeSync(fd);}catch(ignored){}try{fs.unlinkSync(temp);}catch(ignored2){}}
}
function Manager(options){
 this.options=options||{};this.manifests=[];this.dir=path.join(this.options.dataDir,'playback-repair');this.enabled=false;this.started=false;this.closed=false;this.checking=false;this.change=0;this.generation=0;this.event='native';this.lastChecked=0;
 this.state={control:null,active:null,previous:null,verified:false,quarantine:[]};this.runtime=null;this.loading=null;this.retired=[];this.checkCancel=null;this.checkPromise=null;this.lastUpdated=0;this.storageError=false;
 try{this.enabled=readJSON(path.join(this.dir,'preference.json'),1024).enabled===true;}catch(ignored){}
}
Manager.prototype.control=function(e,stored){var found=stored&&this.manifests.filter(function(row){return row.payload===e.payload&&row.signature===e.signature;})[0];if(found)return found.value;var value=verify.verify(e,{publicKey:this.options.publicKey,stored:!!stored,now:this.options.now?this.options.now():Date.now()});if(stored){this.manifests.push({payload:e.payload,signature:e.signature,value:value});if(this.manifests.length>4)this.manifests.shift();}return value;};
Manager.prototype.artifact=function(e){return e?this.control(e,true).module:null;};
Manager.prototype.script=function(e){var a=this.artifact(e),file=path.join(this.dir,'modules',a.sha256+'.js'),stat=fs.statSync(file);if(!stat.isFile()||stat.size!==a.size)throw fault('RULE_CACHE_REJECTED');var b=fs.readFileSync(file);if(verify.digest(b)!==a.sha256)throw fault('RULE_CACHE_REJECTED');return b;};
Manager.prototype.persist=function(state){atomic(path.join(this.dir,'state.json'),Buffer.from(JSON.stringify(state)));};
Manager.prototype.restore=function(){
 var self=this;self.storageError=false;
 try{
  var state=readJSON(path.join(self.dir,'state.json'),32768);if(!state.control)throw fault('RULE_STATE_REJECTED');var high=self.control(state.control,true);
  state.quarantine=Array.isArray(state.quarantine)?state.quarantine.filter(function(h){return /^[a-f0-9]{64}$/.test(h);}).slice(-8):[];
  [state.active,state.previous].forEach(function(e){if(e&&self.control(e,true).revision>high.revision)throw fault('RULE_STATE_REJECTED');});
  if(!high.enabled){state.active=null;state.previous=null;state.verified=false;}
  else {
   var available=function(e){if(!e)return false;try{var a=self.artifact(e);if(!a||state.quarantine.indexOf(a.sha256)>=0)return false;self.script(e);return true;}catch(ignored){return false;}};
   if(!available(state.active)){state.active=available(state.previous)?state.previous:null;state.previous=null;state.verified=!!state.active;}
   if(state.previous&&!available(state.previous))state.previous=null;
  }
  self.state=state;
 }catch(error){if(error.code!=='ENOENT'){self.storageError=true;self.event='check_failed';}self.state={control:null,active:null,previous:null,verified:false,quarantine:[]};}
};
Manager.prototype.status=function(){var s={supported:true,enabled:this.enabled,checking:this.checking,source:'native',revision:0,event:this.event,change:this.change};
 if(this.lastChecked)s.last_checked=this.lastChecked;if(this.lastUpdated)s.last_updated=this.lastUpdated;
 if(this.enabled&&this.state.active){var m=this.control(this.state.active,true);s.source='repair';s.revision=m.revision;s.version=m.module.version;}
 if(this.enabled&&this.state.control&&!this.control(this.state.control,true).enabled)s.event='remote_disabled';return s;
};
Manager.prototype.start=function(){if(this.started)return;this.started=true;this.closed=false;if(this.enabled){this.restore();this.check();}};
Manager.prototype.retire=function(runtime){if(!runtime)return Promise.resolve();if(runtime._retired)return runtime._retired;var resolve;
 var result=new Promise(function(r){resolve=r;});runtime._retired=result;runtime._release=function(){if((runtime._leases||0)>0)return;Promise.resolve(runtime.close()).then(resolve,resolve);};runtime._release();this.retired.push(result);return result;
};
Manager.prototype.drain=function(){var pending=this.retired;this.retired=[];return Promise.all(pending);};
Manager.prototype.getRuntime=function(signal){
 var self=this;if(self.runtime&&self.runtime.broken){self.retire(self.runtime);self.runtime=null;}if(self.runtime)return Promise.resolve(self.runtime);if(self.loading)return self.loading.promise;if(!self.state.active)return Promise.resolve(null);
 var generation=self.generation,active=self.state.active,artifact=self.artifact(active),script;try{script=self.script(active);}catch(error){return Promise.reject(error);}
 var runtime=null,loading={runtime:null};self.loading=loading;
 loading.promise=self.drain().then(function(){if(!self.enabled||self.closed||generation!==self.generation||signal&&signal.aborted)throw fault('RESOLVER_CANCELLED');runtime=(self.options.runtimeFactory||createRuntime)(self.options.runtimeOptions);loading.runtime=runtime;return runtime.load(script,artifact.version,signal);}).then(function(){if(!self.enabled||self.closed||generation!==self.generation||self.state.active!==active)throw fault('RESOLVER_CANCELLED');self.runtime=runtime;self.loading=null;return runtime;}).catch(function(error){if(self.loading===loading)self.loading=null;return self.retire(runtime).then(function(){throw error;});});return loading.promise;
};
Manager.prototype.setEnabled=function(enabled){
 var self=this;if(self.closed)throw fault('RULE_SERVICE_CLOSED');if(enabled===self.enabled){if(enabled)self.check();return self.status();}
 atomic(path.join(self.dir,'preference.json'),Buffer.from(JSON.stringify({enabled:enabled})));self.enabled=enabled;self.generation++;self.change++;self.event='native';
 if(!enabled){if(self.checkPromise)self.retired.push(self.checkPromise);if(self.checkCancel)self.checkCancel.abort();self.checking=false;self.checkPromise=null;self.checkCancel=null;if(self.loading){self.retired.push(self.loading.promise.catch(function(){}));if(self.loading.runtime)self.retire(self.loading.runtime);self.loading=null;}self.retire(self.runtime);self.runtime=null;}
 else{self.restore();self.check();}return self.status();
};
Manager.prototype.check=function(){
 var self=this;if(self.closed||!self.enabled)return Promise.resolve(self.status());if(self.checkPromise)return self.checkPromise;
 var generation=self.generation,control=cancel.create(),candidate=null,timer=setTimeout(function(){control.abort();},70000);self.checkCancel=control;self.checking=true;self.event='checking';self.change++;
 function valid(){if(control.signal.aborted||self.closed||!self.enabled||generation!==self.generation)throw fault('RESOLVER_CANCELLED');}
 function incoming(b){var e;try{e=JSON.parse(b.toString('utf8'));}catch(ignored){throw fault('RULE_MANIFEST_REJECTED');}var m=self.control(e,false),old=self.state.control&&self.control(self.state.control,true);
  if(old&&(m.revision<old.revision||m.revision===old.revision&&e.payload!==self.state.control.payload))throw fault('RULE_REPLAY_REJECTED');
  if(old&&old.module&&m.module&&old.module.version===m.module.version&&old.module.sha256!==m.module.sha256)throw fault('RULE_MODULE_REJECTED');
  if(m.module&&self.state.quarantine.indexOf(m.module.sha256)>=0)throw fault('RULE_QUARANTINED');return {envelope:e,manifest:m};
 }
 var fetch=self.options.fetch||network.fetch;
 var promise=self.drain().then(function(){valid();if(self.storageError)throw fault('RULE_STORAGE_REJECTED');var active=self.state.active;return active?self.getRuntime(control.signal).catch(function(error){if(error.code==='RESOLVER_SCRIPT_FAILED')self.rollback(active);else throw error;}):null;}).then(function(){
  return fetch(verify.manifest,8192,incoming,control.signal);
 }).then(function(bytes){valid();var next=incoming(bytes),m=next.manifest,e=next.envelope;
  if(!m.enabled){var off={control:e,active:null,previous:null,verified:false,quarantine:self.state.quarantine};self.persist(off);self.state=off;self.retire(self.runtime);self.runtime=null;self.event='remote_disabled';return;}
  var a=m.module,old=self.state.active&&self.artifact(self.state.active);
  if(old&&a.sha256===old.sha256){if(a.version!==old.version)throw fault('RULE_MODULE_REJECTED');var same={control:e,active:e,previous:self.state.previous,verified:self.state.verified,quarantine:self.state.quarantine};self.persist(same);self.state=same;self.event='up_to_date';return;}
  return fetch(a.url,1048576,function(b){if(b.length!==a.size||verify.digest(b)!==a.sha256)throw fault('RULE_HASH_REJECTED');},control.signal).then(function(b){valid();candidate=(self.options.runtimeFactory||createRuntime)(self.options.runtimeOptions);return candidate.load(b,a.version,control.signal).then(function(){
   valid();if(self.state.quarantine.indexOf(a.sha256)>=0)throw fault('RULE_QUARANTINED');
   // Derive rollback from current state after validation: a concurrent runtime
   // failure must not resurrect a quarantined module captured before download.
   var active=self.state.active,previous=active&&self.state.verified?active:self.state.previous;
   var state={control:e,active:e,previous:previous,verified:false,quarantine:self.state.quarantine};
   atomic(path.join(self.dir,'modules',a.sha256+'.js'),b);self.persist(state);var retired=self.runtime;self.runtime=candidate;candidate=null;self.state=state;self.retire(retired);self.event='updated';self.lastUpdated=Date.now();self.trim();
  });});
 }).catch(function(error){if(generation===self.generation&&self.enabled&&!self.closed)self.event='check_failed';}).then(function(){
  clearTimeout(timer);if(candidate)return candidate.close();
 }).then(function(){if(generation===self.generation){self.checking=false;self.checkCancel=null;self.checkPromise=null;self.lastChecked=Date.now();self.change++;}return self.status();});
 self.checkPromise=promise;return promise;
};
Manager.prototype.trim=function(){var self=this,keep=[];[self.state.active,self.state.previous].forEach(function(e){if(e)keep.push(self.artifact(e).sha256+'.js');});try{fs.readdirSync(path.join(self.dir,'modules')).forEach(function(name){if(/^[a-f0-9]{64}\.js$/.test(name)&&keep.indexOf(name)<0)fs.unlinkSync(path.join(self.dir,'modules',name));});}catch(ignored){}};
Manager.prototype.rollback=function(envelope){
 if(!this.state.active||this.artifact(this.state.active).sha256!==this.artifact(envelope).sha256)return;var a=this.artifact(envelope),quarantine=this.state.quarantine.concat([a.sha256]).slice(-8),previous=this.state.previous;
 var state={control:this.state.control,active:previous,previous:null,verified:!!previous,quarantine:quarantine};
 try{this.persist(state);}catch(ignored){state.active=null;state.verified=false;this.storageError=true;}
 this.state=state;this.event='rolled_back';this.change++;this.retire(this.runtime);this.runtime=null;this.trim();
};
Manager.prototype.resolve=function(request,signal){
 var self=this;if(self.closed||!self.enabled||!self.state.active)return Promise.resolve(null);
 if(!request||!/^[0-9]{1,32}$/.test(request.vid))return Promise.reject(fault('INVALID_VIDEO_ID'));
 var active=self.state.active,control=cancel.create(),timer=setTimeout(function(){control.abort();},8000),runtime=null;
 function aborted(){control.abort();}if(signal)signal.addEventListener('abort',aborted);if(signal&&signal.aborted)aborted();
 return self.getRuntime(control.signal).then(function(r){if(!r||!self.enabled||self.closed||self.state.active!==active)return null;runtime=r;runtime._leases=(runtime._leases||0)+1;return r.resolve(request,control.signal,8000);}).then(function(options){
  if(options&&self.state.active===active&&!self.state.verified){var state=Object.assign({},self.state,{verified:true});self.persist(state);self.state=state;}return options;
 }).catch(function(error){if(error.code==='RESOLVER_SCRIPT_FAILED')self.rollback(active);throw error;}).then(function(value){finish();return value;},function(error){finish();throw error;});
 function finish(){clearTimeout(timer);if(signal)signal.removeEventListener('abort',aborted);if(runtime){runtime._leases--;if(runtime._release)runtime._release();}}
};
Manager.prototype.close=function(){this.closed=true;this.started=false;this.generation++;var pending=[];if(this.checkPromise)pending.push(this.checkPromise);if(this.checkCancel)this.checkCancel.abort();this.checking=false;this.checkPromise=null;if(this.runtime)pending.push(this.runtime.close());if(this.loading&&this.loading.runtime)pending.push(this.loading.runtime.close());this.runtime=null;this.loading=null;return Promise.all(pending.concat(this.retired)).then(function(){});};
module.exports=function(options){return new Manager(options);};
