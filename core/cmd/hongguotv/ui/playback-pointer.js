(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoPlaybackPointer = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // Zones follow the media surface, not the window, sidebar or video aspect ratio.
  function zoneAt(rect, x, y) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return '';
    x -= rect.left; y -= rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return '';
    if (x < rect.width * .28) return 'back';
    if (x > rect.width * .70) return 'forward';
    var half = Math.min(rect.width * .22, rect.height * .36) / 2;
    if (Math.abs(x - rect.width / 2) <= half && Math.abs(y - rect.height / 2) <= half) return 'play';
    return 'controls';
  }

  function attach(surface, options) {
    if (!surface || !surface.addEventListener) return function () {};
    options = options || {};
    var previousZone = '', doubleZone = '';
    function allowed(event) {
      return !event.defaultPrevented && !(event.button > 0) && !event.ctrlKey && !event.metaKey &&
        !event.altKey && !event.shiftKey && (!options.isEnabled || options.isEnabled()) &&
        !(event.target.closest && event.target.closest('button, input, textarea, select, a, [role="slider"], [role="dialog"], [contenteditable="true"], .bottom-controls, .catalog-ribbon'));
    }
    function click(event) {
      if (!allowed(event) || !event.detail) { previousZone = doubleZone = ''; return; }
      var zone = zoneAt(surface.getBoundingClientRect(), event.clientX, event.clientY);
      doubleZone = event.detail === 2 && previousZone === zone ? zone : '';
      previousZone = zone;
      if (!zone) return;
      event.preventDefault();
      // Side single-clicks do nothing, so a double-click never flashes controls
      // or briefly pauses playback. The centre acts immediately, once per pair.
      if (event.detail !== 1) return;
      if (zone === 'play' && options.onTogglePlayback) options.onTogglePlayback();
      else if (zone === 'controls' && options.onToggleControls) options.onToggleControls();
    }
    function doubleClick(event) {
      if (!allowed(event)) { previousZone = doubleZone = ''; return; }
      var zone = zoneAt(surface.getBoundingClientRect(), event.clientX, event.clientY);
      if (zone && zone === doubleZone && (zone === 'back' || zone === 'forward')) {
        event.preventDefault();
        if (options.onSeek) options.onSeek(zone === 'back' ? -10 : 10);
      }
      previousZone = doubleZone = '';
    }
    function reset() { previousZone = doubleZone = ''; }
    surface.addEventListener('click', click, false);
    surface.addEventListener('dblclick', doubleClick, false);
    surface.addEventListener('mouseleave', reset, false);
    return function () {
      surface.removeEventListener('click', click, false);
      surface.removeEventListener('dblclick', doubleClick, false);
      surface.removeEventListener('mouseleave', reset, false);
    };
  }
  function createFeedback(surface, timers) {
    if (!surface || !surface.ownerDocument) return { show: function () {}, clear: function () {} };
    // WebKit requires Window as the receiver of its native timer methods.
    timers = timers || {
      setTimeout: function (callback, delay) { return setTimeout(callback, delay); },
      clearTimeout: function (id) { clearTimeout(id); }
    };
    var nodes = {}, pending = {};
    var icons = {
      play: '<path d="M8 5v14l11-7z"/>',
      pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
      back: '<path d="m11 5-9 7 9 7zM22 5l-9 7 9 7z"/>',
      forward: '<path d="m2 5 9 7-9 7zM13 5l9 7-9 7z"/>'
    };
    function show(action) {
      if (!Object.prototype.hasOwnProperty.call(icons, action)) return;
      var position = action === 'play' || action === 'pause' ? 'center' : action;
      var node = nodes[position];
      if (!node) {
        node = surface.ownerDocument.createElement('div');
        node.className = 'playback-feedback playback-feedback-' + position;
        node.setAttribute('aria-hidden', 'true');
        surface.appendChild(node);
        nodes[position] = node;
      }
      timers.clearTimeout(pending[position]);
      node.classList.remove('is-visible');
      node.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + icons[action] + '</svg>' +
        (position === 'center' ? '' : '<span>10 秒</span>');
      // Restart the short pulse on repeated actions without accumulating nodes.
      void node.offsetWidth;
      node.classList.add('is-visible');
      pending[position] = timers.setTimeout(function () {
        node.classList.remove('is-visible'); delete pending[position];
      }, position === 'center' ? 700 : 850);
    }
    function clear() {
      Object.keys(nodes).forEach(function (position) {
        timers.clearTimeout(pending[position]); nodes[position].classList.remove('is-visible');
      });
      pending = {};
    }
    return { show: show, clear: clear };
  }
  return { zoneAt: zoneAt, attach: attach, createFeedback: createFeedback };
}));
