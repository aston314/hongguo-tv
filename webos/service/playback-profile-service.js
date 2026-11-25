'use strict';
require('./runtime-compat');
var fs=require('fs'),path=require('path'),createManager=require('./playback-repair'),profile=require('./playback-profile');
var cancel=require('./audio-cancel');
module.exports=function(options){
 options=options||{};
 var baseline=profile.parse(fs.readFileSync(path.join(__dirname,'playback-profile.json'))),closed=false, pending=[];
 function runtime(){var p=null;return {
  load:function(bytes,version,signal){return Promise.resolve().then(function(){if(signal&&signal.aborted)throw Error('cancelled');p=profile.parse(bytes);});},
  resolve:function(request,signal){if(closed||signal&&signal.aborted){var e=Error('cancelled');e.name='AbortError';return Promise.reject(e);}return options.resolve(p,request,signal);},
  close:function(){p=null;return Promise.resolve();}
 };}
 var manager=createManager(Object.assign({},options,{kind:'json',runtimeFactory:runtime}));
 return {
  start:function(){closed=false;manager.start();},
  check:function(){return manager.check();},
  status:function(){return Object.assign({},manager.status(),{automatic:true,format:'json'});},
  resolve:function(request,signal){
   if(closed){var error=Error('profile closed');error.name='AbortError';return Promise.reject(error);}
   var control=cancel.create();pending.push(control);var timer=setTimeout(function(){control.abort();},3000);
   function aborted(){control.abort();}if(signal)signal.addEventListener('abort',aborted);if(signal&&signal.aborted)aborted();
   var active=!!manager.state.active;
   var result=Promise.resolve().then(function(){return active?manager.resolve(request,control.signal):options.resolve(baseline,request,control.signal);});
   return result.then(function(value){finish();return value;},function(e){finish();throw e;});
   function finish(){var index=pending.indexOf(control);if(index>=0)pending.splice(index,1);clearTimeout(timer);if(signal)signal.removeEventListener('abort',aborted);}
  },
  close:function(){closed=true;pending.slice().forEach(function(c){c.abort();});return manager.close();}
 };
};
