(function (root,factory) {
  'use strict'; var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.HongguoPhoneSearch = api;
}(typeof window !== 'undefined' ? window : this,function () {
  'use strict';
  function create(options) {
    var generation = 0, active = false, session = '', ack = 0, qr = '', timer = null, creation = Promise.resolve(), state = {state:'closed'};
    var schedule = options.schedule || setTimeout, cancelTimer = options.unschedule || clearTimeout;
    function render(value) { state = value; options.render(value); }
    function cancel(id) { if (id) options.request('DELETE',id,0,false).catch(function () {}); }
    function stop() {
      generation++; active = false; cancelTimer(timer); timer = null;
      cancel(session); session = qr = ''; ack = 0; render({state:'closed'});
    }
    function start() {
      if (active) { options.render(state); return; }
      active = true; var current = ++generation, failures = 0;
      render({state:'creating'});
      function fail() { if (!active || current !== generation) return; cancel(session); session = ''; active = false; render({state:'unavailable'}); }
      function poll() {
        if (!active || current !== generation) return;
        options.request('GET',session,ack,options.canReceive()).then(function (data) {
          if (!active || current !== generation) return;
          failures = 0;
          if (data.state !== 'waiting' && data.state !== 'completed') { fail(); return; }
          if (data.state === 'completed') {
            if (!(Number(data.id) > 0) || typeof data.value !== 'string' || !data.value.trim() || data.value.length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(data.value)) { fail(); return; }
            if (data.id !== ack) { ack = data.id; if (options.canReceive()) options.complete(data.value); }
          }
          timer = schedule(poll,900);
        }).catch(function () {
          if (!active || current !== generation) return;
          if (++failures >= 3) fail(); else timer = schedule(poll,900);
        });
      }
      // A create finishing after navigation is retired before the next create.
      creation = creation.catch(function () {}).then(function () {
        if (!active || current !== generation) return;
        return options.request('POST','',0,true).then(function (data) {
          if (!active || current !== generation) { cancel(data.session); return; }
          if (!data.session || !data.qr || data.state !== 'waiting') { cancel(data.session); fail(); return; }
          session = data.session; qr = data.qr; ack = 0;
          render({state:'waiting',qr:qr}); timer = schedule(poll,900);
        },fail);
      });
    }
    return {start:start,stop:stop,restart:function () {stop();start();},snapshot:function () {return state;}};
  }
  return {create:create};
}));
