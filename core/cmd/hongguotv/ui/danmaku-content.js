(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoDanmakuContent = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  // Common bracket codes use bundled, semantically equivalent Noto Emoji art.
  // These are not the upstream client's proprietary emoji images.
  var emoji = {
    '[捂脸]': '1fae3', '[笑哭]': '1f602', '[破涕为笑]': '1f602',
    '[流泪]': '1f622', '[泪奔]': '1f62d', '[大哭]': '1f62d', '[泣不成声]': '1f62d',
    '[微笑]': '1f642', '[呲牙]': '1f601', '[大笑]': '1f606', '[憨笑]': '1f604',
    '[偷笑]': '1f92d', '[害羞]': '1f60a', '[调皮]': '1f61c', '[可爱]': '1f970',
    '[色]': '1f60d', '[爱慕]': '1f60d', '[爱心]': '2764', '[心]': '2764',
    '[比心]': '1faf0', '[心碎]': '1f494', '[赞]': '1f44d', '[强]': '1f44d',
    '[鼓掌]': '1f44f', '[握手]': '1f91d', '[抱拳]': '1f64f', '[祈祷]': '1f64f',
    '[玫瑰]': '1f339', '[惊讶]': '1f62e', '[震惊]': '1f631', '[发怒]': '1f620',
    '[愤怒]': '1f621', '[撇嘴]': '1f612', '[白眼]': '1f644', '[晕]': '1f635',
    '[尴尬]': '1f605', '[尬笑]': '1f605', '[汗]': '1f613', '[困]': '1f62a',
    '[睡]': '1f634', '[睡觉]': '1f634', '[酷拽]': '1f60e', '[得意]': '1f60f',
    '[思考]': '1f914', '[疑问]': '1f914', '[嘘]': '1f92b', '[委屈]': '1f97a',
    '[再见]': '1f44b', '[灵光一闪]': '1f4a1', '[机智]': '1f609'
  };
  function appendText(document, parent, value) {
    parent.appendChild(document.createTextNode(value));
  }
  function appendEmoji(document, parent, token, code) {
    var image = document.createElement('img');
    image.className = 'danmaku-emoji'; image.alt = token;
    image.width = 26; image.height = 26; image.draggable = false;
    image.addEventListener('error', function () {
      if (image.parentNode) image.parentNode.replaceChild(document.createTextNode(token), image);
    });
    image.src = 'emoji/noto/' + code + '.png';
    parent.appendChild(image);
  }
  function appendContent(document, parent, value) {
    var text = typeof value === 'string' ? value.slice(0, 120) : '';
    // Do not cut a Unicode emoji's surrogate pair at the existing text limit.
    if (text.length && /[\uD800-\uDBFF]/.test(text.charAt(text.length - 1))) text = text.slice(0, -1);
    var pattern = /\[[^\[\]\r\n]{1,12}\]/g, match, offset = 0;
    while ((match = pattern.exec(text))) {
      if (!Object.prototype.hasOwnProperty.call(emoji, match[0])) continue;
      if (match.index > offset) appendText(document, parent, text.slice(offset, match.index));
      appendEmoji(document, parent, match[0], emoji[match[0]]);
      offset = pattern.lastIndex;
    }
    if (offset < text.length) appendText(document, parent, text.slice(offset));
  }
  function createLine(document, item, formatCount) {
    var line = document.createElement('span'); line.className = 'danmaku-line';
    appendContent(document, line, item.text);
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
