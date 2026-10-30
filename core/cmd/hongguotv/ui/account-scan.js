(function (root) {
  'use strict';
  function create(options) {
    var active = false, generation = 0, timer = null, value = { state: 'idle' };
    var startQueue = Promise.resolve();
    var delay = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
    function request(action, id) { return Promise.resolve().then(function () { return options.request(action, id); }); }
    function notify() { if (options.onChange) options.onChange(snapshot()); }
    function snapshot() { return { active: active, id: value.id || '', state: value.state, image: value.image || '', expires_at: value.expires_at || 0, error: value.error || '' }; }
    function cancelID(id) { return id ? request('cancel', id).catch(function () {}) : Promise.resolve(); }
    function cancel() {
      ++generation; active = false; if (timer !== null) clear(timer); timer = null;
      var id = value.id; value = { state: 'cancelled' }; cancelID(id); notify();
    }
    function accept(data, token) {
      if (token !== generation || !active) return false;
      if (!data || !data.qr_login || !data.qr_login.id) throw new Error('Invalid QR response');
      if (value.id && data.qr_login.id !== value.id) throw new Error('Stale QR response');
      value = data.qr_login;
      if (data.logged_in) { active = false; value = { state: 'signed_in' }; }
      if (options.onStatus) options.onStatus(data);
      notify();
      if (data.logged_in) { if (options.onComplete) options.onComplete(); return false; }
      return ['preparing', 'pending', 'scanned', 'processing'].indexOf(value.state) >= 0;
    }
    function fail(token) { if (token === generation && active) { value = { id: value.id, state: 'failed', error: 'request' }; notify(); } }
    function poll(token) {
      if (token !== generation || !active) return;
      request('status', value.id).then(function (data) {
        if (accept(data, token)) schedule(token);
      }).catch(function () {
        if (token !== generation || !active) return;
        if (value.state !== 'processing' && value.expires_at && Date.now() >= value.expires_at) { var id = value.id; value = { id: id, state: 'expired' }; cancelID(id); notify(); }
        else { value.error = 'network'; notify(); schedule(token); }
      });
    }
    function schedule(token) { timer = delay(function () { timer = null; poll(token); }, 1500); }
    function start() {
      cancel(); active = true; value = { state: 'preparing' }; var token = ++generation; notify();
      // Serialize creation so a delayed old POST cannot replace a newer QR session.
      startQueue = startQueue.then(function () {
        if (token !== generation || !active) return;
        return request('start').then(function (data) {
          if (token !== generation || !active) return cancelID(data && data.qr_login && data.qr_login.id);
          if (accept(data, token)) schedule(token);
        });
      }).catch(function () { fail(token); });
    }
    return { start: start, cancel: cancel, snapshot: snapshot };
  }
  var api = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoAccountScan = api;
}(typeof window !== 'undefined' ? window : this));
