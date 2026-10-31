(function (root) {
  'use strict';

  function preparationFailure(error) {
    if (!error || error.name === 'AbortError' ||
        ['multi_video_model', 'multi_video_model_transport', 'device_register', 'fallback_api'].indexOf(error.stage) < 0 ||
        typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) return null;
    var result = { code: error.code, stage: error.stage };
    var model = error.videoModel || {};
    ['http_status', 'response_bytes', 'attempt', 'elapsed_ms'].forEach(function (key) {
      if (typeof model[key] === 'number' && isFinite(model[key]) && model[key] >= 0) result[key] = Math.floor(model[key]);
    });
    return result;
  }

  // Keep automatic recovery deliberately small. A player error must not turn
  // into an unbounded source/player restart loop on a TV.
  function create(options) {
    options = options || {};
    var maximum = Math.max(0, Number(options.maxAttempts) || 1);
    var attempts = 0;
    var refreshed = false;
    return {
      reset: function () { attempts = 0; refreshed = false; },
      next: function (context) {
        context = context || {};
        if (context.native === 'mpv') return 'stop';
        if (!refreshed && attempts < maximum) {
          attempts++;
          refreshed = true;
          return 'refresh';
        }
        return 'stop';
      },
      attempts: function () { return attempts; }
    };
  }

  root.HongguoPlaybackRecovery = { create: create, preparationFailure: preparationFailure };
  if (typeof module === 'object' && module.exports) module.exports = root.HongguoPlaybackRecovery;
})(typeof window !== 'undefined' ? window : globalThis);
