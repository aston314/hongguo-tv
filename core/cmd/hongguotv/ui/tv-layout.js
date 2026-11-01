(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoTVLayout = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function positive(value) { return typeof value === 'number' && isFinite(value) && value > 0; }
  function rounded(value) { return positive(value) ? Math.round(value) : 0; }
  function tier(width, height) {
    if (!positive(width) || !positive(height)) return 'unknown';
    var longSide = Math.max(width, height), shortSide = Math.min(width, height);
    if (longSide >= 3000 || shortSide >= 2000) return '4k';
    if (shortSide >= 1000 || longSide >= 1800) return '1080';
    if (longSide >= 1200 || shortSide >= 650) return '720';
    return 'compact';
  }
  function read(win) {
    win = win || {};
    var width = positive(win.innerWidth) ? win.innerWidth : 0;
    var height = positive(win.innerHeight) ? win.innerHeight : 0;
    var dpr = positive(win.devicePixelRatio) ? win.devicePixelRatio : 1;
    return {
      viewportWidth: rounded(width), viewportHeight: rounded(height), dpr: dpr,
      appWidth: rounded(width * dpr), appHeight: rounded(height * dpr),
      tier: tier(width * dpr, height * dpr)
    };
  }
  function apply(document, metrics, enabled) {
    if (!document || !document.documentElement || !metrics) return;
    var root = document.documentElement;
    ['720', '1080', '4k', 'compact'].forEach(function (name) {
      root.classList.toggle('tv-layout-' + name, !!enabled && metrics.tier === name);
    });
    root.setAttribute('data-tv-layout-tier', enabled ? metrics.tier : 'not-tv');
    if (enabled) {
      root.setAttribute('data-tv-layout-width', String(metrics.appWidth || 0));
      root.setAttribute('data-tv-layout-height', String(metrics.appHeight || 0));
    } else {
      root.removeAttribute('data-tv-layout-width');
      root.removeAttribute('data-tv-layout-height');
    }
  }
  return { read: read, apply: apply, tier: tier };
}));
