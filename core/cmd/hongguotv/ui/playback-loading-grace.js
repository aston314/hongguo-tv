(function(root){
  'use strict';
  function create(options){
    var current=null,timer=null,now=options.now||Date.now;
    var schedule=options.schedule||setTimeout,unschedule=options.unschedule||clearTimeout;
    function cancel(){
      if(timer!==null){unschedule(timer);timer=null;}
      current=null;options.quiet(false);
    }
    function start(info){
      cancel();if(!info.eligible)return false;
      current=info;options.quiet(true);
      timer=schedule(function(){
        if(current!==info)return;timer=null;
        if(options.valid&&!options.valid(info)){cancel();return;}
        options.quiet(false);if(options.show)options.show();
      },Math.max(0,800-(now()-info.started_at)));
      return true;
    }
    return {start:start,cancel:cancel};
  }
  root.HongguoPlaybackLoadingGrace={create:create};
  if(typeof module==='object'&&module.exports)module.exports=root.HongguoPlaybackLoadingGrace;
})(typeof window!=='undefined'?window:globalThis);
