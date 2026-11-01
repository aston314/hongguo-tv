(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.HongguoTVViewport = api; api.install(root); }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  // Some Android TV WebViews expose a 960px layout viewport for a 1080p
  // surface. Keep devices whose real viewport is already wide on their normal
  // media-query path; only widen the narrow TV profile.
  var TARGET_WIDTH = 1280;
  var MIN_WIDTH = 900;
  var MAX_WIDTH = 1024;
  var status = { state: 'pending', beforeWidth: 0, beforeHeight: 0, scale: 0 };

  function classify(view, bridge) {
    var width = Math.round(Number(view && view.innerWidth) || 0);
    var height = Math.round(Number(view && view.innerHeight) || 0);
    var result = { width: width, height: height, scale: 0 };
    if (width <= 0 || height <= 0) {
      result.state = 'viewport-pending';
      return result;
    }
    if (!bridge || typeof bridge.isTelevision !== 'function') {
      result.state = 'bridge-pending';
      return result;
    }
    try {
      if (!bridge.isTelevision()) {
        result.state = 'not-television';
        return result;
      }
    } catch (ignored) {
      result.state = 'bridge-pending';
      return result;
    }
    var ratio = width / Math.max(1, height);
    if (width < MIN_WIDTH || width > MAX_WIDTH || height < 450 || height > 650 || ratio < 1.6 || ratio > 1.9) {
      result.state = 'viewport-unchanged';
      return result;
    }
    result.state = 'corrected';
    result.scale = Math.round(width / TARGET_WIDTH * 1000) / 1000;
    return result;
  }

  function apply(view) {
    var next = classify(view, view && view.HongguoTVDiagnostics);
    status = { state: next.state, beforeWidth: next.width, beforeHeight: next.height, scale: next.scale };
    if (next.state !== 'corrected') return false;
    var document = view && view.document;
    var meta = document && document.querySelector && document.querySelector('meta[name="viewport"]');
    if (!meta) {
      status.state = 'viewport-meta-missing';
      return false;
    }
    // Match the measured visual width while asking WebView to lay out at the
    // wider TV design width. This keeps the page fitted to the same screen
    // width while changing which responsive media queries are active.
    meta.setAttribute('content', 'width=' + TARGET_WIDTH + ', initial-scale=' + next.scale);
    status.state = 'applied';
    return true;
  }

  function install(view) {
    if (!view || !view.document) return;
    var userAgent = view.navigator && view.navigator.userAgent || '';
    if (userAgent.indexOf('HongguoTV-Android') < 0) {
      status.state = 'unsupported-platform';
      return;
    }
    var attempts = 0;
    var finished = false;
    function attempt() {
      if (finished) return;
      attempts++;
      if (apply(view)) {
        finished = true;
        return;
      }
      if ((status.state === 'bridge-pending' || status.state === 'viewport-pending') && attempts < 60) {
        view.setTimeout(attempt, 50);
        return;
      }
      if (status.state === 'bridge-pending') status.state = 'bridge-unavailable';
      else if (status.state === 'viewport-pending') status.state = 'viewport-unavailable';
      finished = true;
    }
    attempt();
  }

  function describe() {
    return {
      state: status.state,
      beforeWidth: status.beforeWidth,
      beforeHeight: status.beforeHeight,
      targetWidth: status.state === 'applied' ? TARGET_WIDTH : 0,
      scale: status.scale
    };
  }

  return { apply: apply, classify: classify, describe: describe, install: install };
}));
