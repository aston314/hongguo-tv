(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoDanmakuContent = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function appendText(document, parent, value) {
    parent.appendChild(document.createTextNode(value));
  }
  function createLine(document, item, formatCount) {
    var line = document.createElement('span'); line.className = 'danmaku-line';
    var text = typeof item.text === 'string' ? item.text.slice(0, 120) : '';
    // Do not cut a Unicode emoji's surrogate pair at the existing text limit.
    if (text.length && /[\uD800-\uDBFF]/.test(text.charAt(text.length - 1))) text = text.slice(0, -1);
    appendText(document, line, text);
    var count = item.likes;
    if (typeof count === 'number' && isFinite(count) && count > 0 && Math.floor(count) === count) {
      var badge = document.createElement('span'); badge.className = 'danmaku-likes';
      var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
      var heart = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      heart.setAttribute('d', 'M12 20S4 15.2 4 9.7A4.1 4.1 0 0 1 12 7a4.1 4.1 0 0 1 8 2.7C20 15.2 12 20 12 20Z');
      heart.setAttribute('fill', 'none'); heart.setAttribute('stroke', 'currentColor');
      heart.setAttribute('stroke-width', '1.8'); heart.setAttribute('stroke-linejoin', 'round');
      icon.appendChild(heart); badge.appendChild(icon);
      appendText(document, badge, formatCount ? formatCount(count) : String(count));
      line.appendChild(badge);
    }
    return line;
  }
  return { createLine: createLine };
}));
