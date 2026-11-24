(function(root,factory){'use strict';var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HongguoPlaybackRepair=api;}(typeof window!=='undefined'?window:this,function(){
 'use strict';
 var stages=['video_tab','video_model','multi_video_model','multi_video_model_transport','device_register','fallback_api','source_select'];
 var codes=['VIDEO_TAB_EMPTY','VIDEO_TAB_JSON','VIDEO_TAB_MODEL_MISSING','VIDEO_TAB_HTTP','VIDEO_TAB_TRANSPORT','VIDEO_TAB_READ','VIDEO_MODEL_EMPTY','VIDEO_MODEL_MISSING','VIDEO_MODEL_LIST_EMPTY','VIDEO_MODEL_JSON','VIDEO_MODEL_NO_QUALITY','VIDEO_MODEL_HTTP','VIDEO_MODEL_TRANSPORT','VIDEO_MODEL_READ','DEVICE_REGISTER_FAILED','DEVICE_REGISTER_READ','DEVICE_REGISTER_HTTP'];
 function eligible(failure,state){return !!(state&&state.supported&&!state.enabled&&failure&&stages.indexOf(failure.stage)>=0&&codes.indexOf(failure.code)>=0);}
 function create(options){
  var state={supported:false,enabled:false,checking:false,source:'native',event:'loading'},pending=null,timer=null,destroyed=false,seenChange=null;
  var later=options.setTimeout||setTimeout,clear=options.clearTimeout||clearTimeout;
  function snapshot(){return Object.assign({},state);}
  function accept(payload){
   if(!payload||payload.ok!==true||!payload.data||typeof payload.data.supported!=='boolean'||typeof payload.data.enabled!=='boolean')throw Error('invalid repair response');
   var next=payload.data;
   if(typeof state.change==='number'&&typeof next.change==='number'&&next.change<state.change)return snapshot();
   if(seenChange!==null&&next.change!==seenChange&&next.event==='updated'&&options.updated)options.updated();
   seenChange=next.change;state=next;if(options.render)options.render(snapshot());
   schedule();return snapshot();
  }
  function schedule(){
   clear(timer);timer=null;
   if(destroyed||!state.supported)return;
   if(state.checking)timer=later(function(){refresh().catch(function(){});},800);
   else if(state.enabled&&(!options.visible||options.visible()))timer=later(function(){refresh().catch(function(){});},15000);
  }
  function request(action){return options.request(action).then(accept);}
  function refresh(){
   if(pending)return pending;
   pending=request(null).then(function(v){pending=null;return v;},function(e){pending=null;schedule();throw e;});return pending;
  }
  function act(action){
   if(destroyed)return Promise.reject(Error('repair controller closed'));
   return request(action).catch(function(e){if(options.failed)options.failed();throw e;});
  }
  function enableAndWait(current){
   var started=Date.now();
   function wait(value){
    if(destroyed||current&&!current()){var error=Error('stale repair retry');error.name='AbortError';throw error;}
    if(value.source==='repair'&&value.enabled)return value;
    if(!value.enabled||!value.checking||Date.now()-started>75000)throw Error('repair unavailable');
    return new Promise(function(resolve){later(resolve,500);}).then(refresh).then(wait);
   }
   return act('enable').then(wait);
  }
  return {refresh:refresh,act:act,snapshot:snapshot,eligible:function(f){return eligible(f,state);},enableAndWait:enableAndWait,destroy:function(){destroyed=true;clear(timer);}};
 }
 return {create:create,eligible:eligible};
}));
