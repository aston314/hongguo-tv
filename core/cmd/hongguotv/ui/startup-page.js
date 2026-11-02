(function (root) {
  'use strict';

  var KEY = 'hongguo-tv-startup-page';
  var PAGES = ['recommend', 'rank', 'new', 'history', 'favorites'];
  function valid(value) { return PAGES.indexOf(value) >= 0; }
  function normalize(value) { return valid(value) ? value : 'recommend'; }

  function create(options) {
    options = options || {};
    var storage = options.storage;
    var bridge = options.bridge;
    // Android assigns a new core port on restart. Keep this preference in the
    // native store instead of tying it to the WebView's changing origin.
    if (bridge && typeof bridge.readStartupPage === 'function' && typeof bridge.writeStartupPage === 'function') {
      storage = {
        getItem: function () { return bridge.readStartupPage(); },
        setItem: function (key, value) { bridge.writeStartupPage(value); }
      };
    }
    var page = 'recommend';
    try { page = normalize(storage && storage.getItem(KEY)); } catch (ignoredRead) {}
    function render() { if (typeof options.render === 'function') options.render({ page: page }); }
    render();
    return {
      page: function () { return page; },
      choose: function (value) {
        if (!valid(value)) return false;
        try {
          if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') return false;
          storage.setItem(KEY, value);
          if (storage.getItem(KEY) !== value) return false;
        } catch (ignoredSave) { return false; }
        page = value;
        render();
        return true;
      }
    };
  }

  var api = { create: create, normalize: normalize, key: KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HongguoStartupPage = api;
}(this));
