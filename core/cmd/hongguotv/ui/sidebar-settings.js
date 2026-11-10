(function (root) {
  'use strict';

  var KEY = 'hongguo-tv-sidebar-display';
  var EXPANDED = 'expanded';
  var ICONS = 'icons';

  function valid(value) { return value === EXPANDED || value === ICONS; }

  function read(storage) {
    try {
      var value = storage && storage.getItem(KEY);
      return valid(value) ? value : EXPANDED;
    } catch (ignored) {
      return EXPANDED;
    }
  }

  function write(storage, value) {
    if (!valid(value)) return false;
    try {
      if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') return false;
      storage.setItem(KEY, value);
      return storage.getItem(KEY) === value;
    } catch (ignored) {
      return false;
    }
  }

  function create(options) {
    options = options || {};
    var storage = options.storage;
    // The Android core chooses a new port after each restart, so its WebView
    // origin cannot own a preference that must survive restarts.
    var bridge = options.bridge;
    if (bridge && typeof bridge.readSidebarDisplay === 'function' && typeof bridge.writeSidebarDisplay === 'function') {
      storage = {
        getItem: function () { return bridge.readSidebarDisplay(); },
        setItem: function (key, value) { bridge.writeSidebarDisplay(value); }
      };
    }
    var mode = read(storage);
    function render() {
      if (typeof options.render === 'function') options.render({ mode: mode });
    }
    render();
    return {
      mode: function () { return mode; },
      choose: function (value) {
        if (!valid(value) || !write(storage, value)) return false;
        mode = value;
        render();
        return true;
      }
    };
  }

  var api = { create: create, read: read, write: write, key: KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HongguoSidebarSettings = api;
}(this));
