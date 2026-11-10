(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoDanmakuContent = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  // Asset order from the reference client's 53-image pack; these are local
  // file numbers, not upstream API identifiers. See emoji/hongguo/README.txt.
  var names = [
    '微笑', '偷笑', '笑', '什么', '害羞', '爱慕', '飞吻', '奸笑', '尬笑',
    '思考', '撇嘴', '做鬼脸', '酷', '翻白眼', '惊呆', '震惊', '送心', '委屈',
    '快哭了', '笑哭', '哭', '大笑', '舔屏', '怒', '捂脸', '吐', '恐惧', '抓狂',
    '敬礼', '石化', 'OK', '赞', '爱心', '伤心', 'KISS', '懂了', '探究',
    '重拳出击', '吃瓜', '盯', '你细品', '赶稿中', '注意', '饱了', '码住',
    '学会了', '顶帖', '求爆更', '求关注', '爽', '鼓掌', '没看够', '送花'
  ];
  var emoji = {}, i, token;
  for (i = 0; i < names.length; i += 1) emoji['[' + names[i] + ']'] = i + 1;
  // Only unambiguous existing aliases share an image. Everything else stays
  // as its original text instead of mixing artwork or guessing an expression.
  var aliases = {
    '[破涕为笑]': '[笑哭]', '[大哭]': '[哭]', '[调皮]': '[做鬼脸]',
    '[色]': '[爱慕]', '[心]': '[爱心]', '[心碎]': '[伤心]', '[强]': '[赞]',
    '[玫瑰]': '[送花]', '[发怒]': '[怒]', '[愤怒]': '[怒]',
    '[白眼]': '[翻白眼]', '[尴尬]': '[尬笑]', '[酷拽]': '[酷]'
  };
  for (token in aliases) {
    if (Object.prototype.hasOwnProperty.call(aliases, token)) emoji[token] = emoji[aliases[token]];
  }
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
    image.src = 'emoji/hongguo/' + code + '.webp';
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
