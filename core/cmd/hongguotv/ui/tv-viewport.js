(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.apply(root.document, root.HongguoTVDiagnostics, root.devicePixelRatio);
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function apply(document, bridge, dpr) {
    var target = 0;
    try { target = bridge && typeof bridge.layoutViewportWidth === 'function' ? Number(bridge.layoutViewportWidth()) : 0; } catch (ignored) {}
    if (target !== 1280 || !document || !document.querySelector) return false;
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return false;
    dpr = typeof dpr === 'number' && isFinite(dpr) && dpr > 0 ? dpr : 1;
    var scale = Math.round(1500 / dpr) / 1000;
    meta.setAttribute('content', 'width=1280, initial-scale=' + scale);
    return true;
  }
  return { apply: apply };
}));
