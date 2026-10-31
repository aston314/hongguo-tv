'use strict';
var cancel = require('./audio-cancel');

// Anonymous playback only. Account cookies and the signed-in device are never
// read here. A caller cancels its wait, not the registration shared by others.
module.exports = function (register, options) {
  options = options || {};
  var now = options.now || Date.now, later = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
  var device = null, pending = null, refreshAfter = 0, closed = false;
  function cancelled() { var e = new Error('播放准备已取消'); e.name = 'AbortError'; e.code = 'PLAYBACK_PREPARATION_CANCELLED'; e.status = 499; return e; }
  function check(signal) { if (closed || signal && signal.aborted) throw cancelled(); }
  function wait(promise, signal) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function finish(error, value) {
        if (done) return; done = true;
        if (signal) signal.removeEventListener('abort', aborted);
        if (closed || signal && signal.aborted) error = cancelled();
        if (error) reject(error); else resolve(value);
      }
      function aborted() { finish(cancelled()); }
      if (signal) { signal.addEventListener('abort', aborted); if (signal.aborted) { aborted(); return; } }
      promise.then(function (value) { finish(null, value); }, function (error) { finish(error); });
    });
  }
  function start() {
    var task = { cancel: cancel.create(), timer: null };
    // A total registration deadline, in addition to the socket timeout. Its
    // rejection also releases pending when a transport never settles.
    task.promise = new Promise(function (resolve, reject) {
      var settled = false;
      function finish(error, value) {
        if (settled) return; settled = true; clear(task.timer);
        task.cancel.signal.removeEventListener('abort', aborted);
        if (pending === task) pending = null;
        if (closed || task.cancel.signal.aborted) error = error || cancelled();
        if (error) reject(error); else { device = value; resolve(value); }
      }
      function aborted() {
        var error = cancelled();
        if (!closed) { error.name = 'Error'; error.code = 'ACCOUNT_DEVICE'; error.status = 504; error.message = '匿名播放身份注册超时'; }
        finish(error);
      }
      task.cancel.signal.addEventListener('abort', aborted);
      task.timer = later(function () { task.cancel.abort(); }, 8000);
      Promise.resolve().then(function () { check(task.cancel.signal); return register(task.cancel.signal); })
        .then(function (value) { finish(null, value); }, function (error) { finish(error); });
    });
    pending = task;
    // All playback waiters may leave before this independent task completes.
    task.promise.catch(function () {});
    return task.promise;
  }
  return {
    get: function (signal) {
      try { check(signal); } catch (error) { return Promise.reject(error); }
      return wait(pending ? pending.promise : device ? Promise.resolve(device) : start(), signal);
    },
    refreshAfterEmpty: function (failed, signal) {
      try { check(signal); } catch (error) { return Promise.reject(error); }
      if (pending) return wait(pending.promise, signal);
      // A late response from the old identity reuses the new one. It cannot
      // invalidate a successful replacement or consume another registration.
      if (device && device !== failed) return wait(Promise.resolve(device), signal);
      if (now() < refreshAfter) {
        var error = new Error('匿名播放身份恢复仍在冷却'); error.code = 'PLAYBACK_IDENTITY_COOLDOWN';
        return Promise.reject(error);
      }
      refreshAfter = now() + 30000; // Failed registrations count too.
      return wait(start(), signal);
    },
    close: function () { closed = true; if (pending) pending.cancel.abort(); }
  };
};
