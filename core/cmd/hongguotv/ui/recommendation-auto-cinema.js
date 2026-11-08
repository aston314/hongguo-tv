(function (root) {
  'use strict';

  function create(options) {
    options = options || {};
    var bridge = options.bridge;
    var supported = false;
    var enabled = false;
    var message = '';
    try {
      supported = !!(options.platform === 'android' && options.diagnostics &&
        typeof options.diagnostics.isTelevision === 'function' && options.diagnostics.isTelevision() === true &&
        bridge && typeof bridge.readRecommendationAutoCinema === 'function' &&
        typeof bridge.writeRecommendationAutoCinema === 'function');
      if (supported) enabled = bridge.readRecommendationAutoCinema() === 'enabled';
    } catch (ignored) { enabled = false; }

    function render() {
      if (typeof options.render === 'function') options.render({ supported: supported, enabled: enabled, message: message });
    }
    render();
    return {
      enabled: function () { return supported && enabled; },
      choose: function (value) {
        if (!supported || (value !== 'enabled' && value !== 'disabled')) return false;
        try {
          bridge.writeRecommendationAutoCinema(value);
          if (bridge.readRecommendationAutoCinema() !== value) throw new Error('Preference not saved');
          enabled = value === 'enabled';
          message = '';
          render();
          return true;
        } catch (ignoredSave) {
          message = 'save_failed';
          render();
          return false;
        }
      }
    };
  }

  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HongguoRecommendationAutoCinema = api;
}(this));
