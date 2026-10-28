(function (root) {
  'use strict';

  function supports(platform) {
    return platform === 'android' || platform === 'desktop';
  }

  function normalize(value) {
    return value === 'full' ? 'full' : 'range';
  }

  function create(options) {
    options = options || {};
    var platform = options.platform || 'preview';
    var mode = 'range';
    var message = '';

    function read() {
      var value = '';
      try { value = typeof options.read === 'function' ? options.read() : ''; } catch (ignored) {}
      mode = supports(platform) ? normalize(value) : 'range';
      return mode;
    }

    function render() {
      if (typeof options.render === 'function') options.render({ supported: supports(platform), mode: mode, message: message });
    }

    read();
    render();
    return {
      supported: function () { return supports(platform); },
      mode: function () { return mode; },
      choose: function (value) {
        if (!supports(platform) || value !== 'range' && value !== 'full') return false;
        var previous = mode;
        mode = value;
        try {
          if (typeof options.write !== 'function' || options.write(value) === false) throw new Error('Preference not saved');
          message = '';
          render();
          return true;
        } catch (ignoredSave) {
          mode = previous;
          message = 'save_failed';
          render();
          return false;
        }
      },
      refresh: function () { read(); render(); }
    };
  }

  var api = { create: create, normalize: normalize, supports: supports };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HongguoEpisodePrefetchSettings = api;
}(this));
