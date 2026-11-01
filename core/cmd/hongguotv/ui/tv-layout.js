(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoTVLayout = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var status = { state: 'pending', width: 0, height: 0 };
  function positive(value) { return typeof value === 'number' && isFinite(value) && value > 0; }
  function read(win) {
    win = win || {};
    var width = positive(win.innerWidth) ? Math.round(win.innerWidth) : 0;
    var height = positive(win.innerHeight) ? Math.round(win.innerHeight) : 0;
    var ratio = width / Math.max(1, height);
    return { width: width, height: height, narrow: width >= 900 && width <= 1024 && height >= 450 && height <= 650 && ratio > 1.6 && ratio <= 1.9 };
  }
  function apply(document, metrics, enabled) {
    if (!document || !document.documentElement || !metrics) return;
    var active = !!enabled && metrics.narrow;
    var root = document.documentElement;
    root.classList.toggle('tv-layout-base', active);
    root.setAttribute('data-tv-layout-path', active ? 'base-short-viewport' : enabled ? 'base-media-query' : 'not-tv');
    status = { state: active ? 'applied' : enabled ? 'not-narrow' : 'not-television', width: metrics.width, height: metrics.height };
  }
  function describe() { return { state: status.state, width: status.width, height: status.height }; }
  return { read: read, apply: apply, describe: describe };
}));
