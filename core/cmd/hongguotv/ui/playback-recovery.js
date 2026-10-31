(function (root) {
  'use strict';

  function safePreparation(code, stage, details) {
    if (['multi_video_model', 'multi_video_model_transport', 'device_register', 'fallback_api',
        'source_select', 'range_init', 'media_download', 'media_decrypt', 'cache_write', 'playback_prepare'].indexOf(stage) < 0 ||
        typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return null;
    var result = { code: code, stage: stage };
    details = details || {};
    ['http_status', 'response_bytes', 'attempt', 'elapsed_ms'].forEach(function (key) {
      if (typeof details[key] === 'number' && isFinite(details[key]) && details[key] >= 0 &&
          (key !== 'http_status' || details[key] >= 100 && details[key] <= 599)) result[key] = Math.floor(details[key]);
    });
    if (typeof details.business_code === 'string' && /^[0-9]{1,16}$/.test(details.business_code)) result.business_code = details.business_code;
    return result;
  }

  function preparationFailure(error) {
    if (!error || error.name === 'AbortError') return null;
    var details = error.preparation || error.videoModel || {};
    var result = safePreparation(error.code, error.stage, details);
    if (result && details.range_failure) {
      // Only one preceding Range attempt, never an unbounded error chain.
      var range = details.range_failure;
      var previous = safePreparation(range.code, range.stage, range);
      if (previous) result.range_failure = previous;
    }
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
