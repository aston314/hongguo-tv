(function (root) {
  'use strict';

  var modes = ['all', 'landscape', 'portrait'];
  var supportedPlatforms = ['android', 'desktop', 'webos', 'preview'];

  function supports(platform) {
    return supportedPlatforms.indexOf(platform) >= 0;
  }

  function normalize(value) {
    return modes.indexOf(value) >= 0 ? value : 'all';
  }

  function matches(mode, width, height) {
    mode = normalize(mode);
    if (mode === 'all') return true;
    width = Number(width) || 0;
    height = Number(height) || 0;
    if (width <= 0 || height <= 0 || width === height) return null;
    return mode === 'landscape' ? width > height : height > width;
  }

  function nextCandidateIndex(index, total, checked, limit) {
    index = Number(index);
    total = Number(total);
    checked = Number(checked);
    limit = Number(limit);
    if (!isFinite(index) || !isFinite(total) || !isFinite(checked) || !isFinite(limit) ||
        Math.floor(index) !== index || Math.floor(total) !== total || Math.floor(checked) !== checked || Math.floor(limit) !== limit ||
        index < 0 || total < 0 || checked >= limit || index + 1 >= total) return -1;
    return index + 1;
  }

  function create(options) {
    options = options || {};
    var platform = options.platform || 'preview';
    var storage = options.storage;
    var bridge = options.bridge;
    var key = options.key || 'hongguo-tv-recommendation-direction';
    var mode = 'all';
    var message = '';
    var nativePreference = !!(bridge && typeof bridge.readRecommendationDirection === 'function' &&
      typeof bridge.writeRecommendationDirection === 'function');

    function read() {
      if (!supports(platform)) { mode = 'all'; return mode; }
      try { mode = normalize(nativePreference ? bridge.readRecommendationDirection() : storage && storage.getItem(key)); } catch (ignored) { mode = 'all'; }
      return mode;
    }

    function render() {
      if (typeof options.render === 'function') options.render({ supported: supports(platform), mode: mode, message: message });
    }

    read();
    render();
    return {
      mode: function () { return mode; },
      choose: function (value) {
        if (!supports(platform) || modes.indexOf(value) < 0 ||
            !nativePreference && (!storage || typeof storage.setItem !== 'function')) return false;
        var previous = mode;
        try {
          if (nativePreference) {
            bridge.writeRecommendationDirection(value);
            if (normalize(bridge.readRecommendationDirection()) !== value) throw new Error('Preference not saved');
          } else {
            storage.setItem(key, value);
            if (typeof storage.getItem === 'function' && normalize(storage.getItem(key)) !== value) throw new Error('Preference not saved');
          }
          mode = value;
          message = '';
          render();
          return true;
        } catch (ignoredSave) {
          mode = previous;
          message = 'save_failed';
          render();
          return false;
        }
      }
    };
  }

  var api = { create: create, matches: matches, nextCandidateIndex: nextCandidateIndex, normalize: normalize, supports: supports };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HongguoRecommendationDirection = api;
}(this));
