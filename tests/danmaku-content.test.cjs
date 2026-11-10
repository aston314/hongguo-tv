const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createLine} = require('../core/cmd/hongguotv/ui/danmaku-content.js');
const {countText} = require('../core/cmd/hongguotv/ui/engagement.js');

function element(tag, value) {
  return {tag, value, children: [], attrs: {}, events: {},
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    replaceChild(next, previous) { this.children[this.children.indexOf(previous)] = next; next.parentNode = this; previous.parentNode = null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, callback) { this.events[name] = callback; }
  };
}
const document = {createElement: element, createElementNS: (_, tag) => element(tag), createTextNode: text => element('#text', text)};
const textOf = node => node.tag === '#text' ? node.value : node.children.map(textOf).join('');
const descendants = node => [node, ...node.children.flatMap(descendants)];

test('bracket codes stay as text alongside Unicode emoji, while likes remain safe and unfocusable', () => {
  const line = createLine(document, {text: '笑死了😂[捂脸][笑哭][新表情]<img src=x onerror=alert(1)>', likes: 128}, countText);
  assert.equal(descendants(line).filter(n => n.tag === 'img').length, 0);
  assert.equal(textOf(line), '笑死了😂[捂脸][笑哭][新表情]<img src=x onerror=alert(1)>128');
  const badge = line.children.at(-1);
  assert.equal(badge.className, 'danmaku-likes');
  assert.equal(badge.children[0].tag, 'svg');
  assert.equal(badge.children[0].attrs.focusable, 'false');
  assert.ok(descendants(line).every(n => !('tabindex' in n.attrs) && !('data-focus' in n.attrs)));
});

test('zero, missing and malformed likes never produce an empty or invented badge', () => {
  for (const likes of [0, undefined, null, -1, NaN, Infinity, '128', 1.5]) {
    const line = createLine(document, {text: '正常弹幕', likes}, countText);
    assert.equal(textOf(line), '正常弹幕');
    assert.equal(line.children.length, 1);
  }
  assert.equal(textOf(createLine(document, {text: '高赞', likes: 12800}, countText)), '高赞1.2万');
});

test('the existing text limit does not leave a broken emoji surrogate', () => {
  assert.equal(textOf(createLine(document, {text: '字'.repeat(119) + '😂', likes: 0})), '字'.repeat(119));
  assert.equal(textOf(createLine(document, {text: '字'.repeat(118) + '😂剩余', likes: 0})), '字'.repeat(118) + '😂');
  assert.equal(textOf(createLine(document, {text: null, likes: 0})), '');
});
