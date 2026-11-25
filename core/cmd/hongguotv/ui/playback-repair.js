(function(root,factory){'use strict';var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HongguoPlaybackRepair=api;}(typeof window!=='undefined'?window:this,function(){
 'use strict';
 var stages=['video_tab','video_model','multi_video_model','multi_video_model_transport','device_register','fallback_api','source_select'];
 var codes=['VIDEO_TAB_EMPTY','VIDEO_TAB_JSON','VIDEO_TAB_MODEL_MISSING','VIDEO_TAB_HTTP','VIDEO_TAB_TRANSPORT','VIDEO_TAB_READ','VIDEO_MODEL_EMPTY','VIDEO_MODEL_MISSING','VIDEO_MODEL_LIST_EMPTY','VIDEO_MODEL_JSON','VIDEO_MODEL_NO_QUALITY','VIDEO_MODEL_HTTP','VIDEO_MODEL_TRANSPORT','VIDEO_MODEL_READ','DEVICE_REGISTER_FAILED','DEVICE_REGISTER_READ','DEVICE_REGISTER_HTTP'];
 function eligible(failure,state){return !!(state&&state.supported&&!state.enabled&&failure&&stages.indexOf(failure.stage)>=0&&codes.indexOf(failure.code)>=0);}
 // A presentation-only view. Do not merge JSON state into JS consent,
 // source/revision or checking: announcements and enable-and-retry use them.
 function view(state){
  state=state||{};
  var profile=state.native_profile,js=!!(state.enabled&&state.source==='repair');
  var current=js?state:profile||state;
  var checking=!!(state.checking||profile&&profile.checking);
  var lastChecked=Math.max(Number(state.last_checked)||0,Number(profile&&profile.last_checked)||0);
  var failed=['check_failed','update_unavailable','script_download_failed','candidate_rejected','activation_storage_failed','state_rejected'];
  var status;
  if(checking)status='checking';
  else if((state.enabled&&failed.indexOf(state.event)>=0)||(profile&&failed.indexOf(profile.event)>=0))status='failed';
  else if(current.event==='rolled_back')status='rolledBack';
  else if(state.enabled&&state.event==='remote_disabled')status='disabled';
  else if(!js&&profile&&profile.event==='remote_disabled')status='defaultDisabled';
  else if(state.enabled&&!js)status='pendingDefault';
  else if(current.event==='updated'||current.event==='activated')status='ready';
  else if(current.last_checked)status='latest';
  else status=profile?'defaultReady':js?'latest':'off';
  return {nameKey:js?'repairRule':profile?'defaultRule':'builtinRule',format:js?'JS':profile?'JSON':'',version:current.version||'',checking:checking,lastChecked:lastChecked,statusKey:status,automatic:!!(profile||state.enabled)};
 }
 function create(options){
  var state={supported:false,enabled:false,checking:false,source:'native',event:'loading'},pending=null,timer=null,destroyed=false,seenChange=null;
  var later=options.setTimeout||setTimeout,clear=options.clearTimeout||clearTimeout;
  function snapshot(){return Object.assign({},state);}
  function accept(payload){
   if(!payload||payload.ok!==true||!payload.data||typeof payload.data.supported!=='boolean'||typeof payload.data.enabled!=='boolean')throw Error('invalid repair response');
   var next=payload.data;
   if(typeof state.change==='number'&&typeof next.change==='number'&&next.change<state.change)return snapshot();
   if(state.native_profile&&next.native_profile&&typeof state.native_profile.change==='number'&&typeof next.native_profile.change==='number'&&next.native_profile.change<state.native_profile.change)next=Object.assign({},next,{native_profile:state.native_profile});
   if(seenChange!==null&&next.change!==seenChange&&next.event==='updated'&&options.updated)options.updated();
   seenChange=next.change;state=next;if(options.render)options.render(snapshot());
   schedule();return snapshot();
  }
  function schedule(){
   clear(timer);timer=null;
   if(destroyed||!state.supported)return;
   if(view(state).checking)timer=later(function(){refresh().catch(function(){});},800);
   else if((state.enabled||state.native_profile)&&(!options.visible||options.visible()))timer=later(function(){refresh().catch(function(){});},15000);
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
 return {create:create,eligible:eligible,view:view};
}));
