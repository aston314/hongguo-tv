const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('mixed bracket codes, Unicode emoji, unknown codes and HTML remain safe and readable', () => {
  const line = createLine(document, {text: '笑死了😂[捂脸][笑哭][新表情]<img src=x onerror=alert(1)>', likes: 128}, countText);
  const images = descendants(line).filter(n => n.tag === 'img');
  assert.deepEqual(images.map(n => n.alt), ['[捂脸]', '[笑哭]']);
  assert.deepEqual(images.map(n => n.src), ['emoji/twemoji/1f926.png', 'emoji/twemoji/1f602.png']);
  assert.equal(textOf(line), '笑死了😂[新表情]<img src=x onerror=alert(1)>128');
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

test('a failed bundled image restores the original code without retrying or losing adjacent text', () => {
  const line = createLine(document, {text: '前[捂脸]后', likes: 37}, countText);
  const image = line.children[1];
  image.events.error(); image.events.error();
  assert.equal(textOf(line), '前[捂脸]后37');
  assert.equal(descendants(line).filter(n => n.tag === 'img').length, 0);
});

test('the existing text limit does not leave a broken emoji surrogate', () => {
  assert.equal(textOf(createLine(document, {text: '字'.repeat(119) + '😂', likes: 0})), '字'.repeat(119));
  assert.equal(textOf(createLine(document, {text: '字'.repeat(118) + '😂剩余', likes: 0})), '字'.repeat(118) + '😂');
  assert.equal(textOf(createLine(document, {text: null, likes: 0})), '');
});

test('all mapped images ship offline at a fixed 72px size with attribution, before the shared app starts', () => {
  const ui = path.resolve(__dirname, '../core/cmd/hongguotv/ui');
  const source = fs.readFileSync(path.join(ui, 'danmaku-content.js'), 'utf8');
  const codes = [...source.matchAll(/'\[[^']+\]': '([a-f0-9-]+)'/g)].map(m => m[1]);
  assert.ok(codes.length >= 40);
  for (const code of new Set(codes)) {
    const png = fs.readFileSync(path.join(ui, 'emoji/twemoji', code + '.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 72); assert.equal(png.readUInt32BE(20), 72);
  }
  assert.match(fs.readFileSync(path.join(ui, 'emoji/twemoji/README.txt'), 'utf8'), /CC BY 4\.0/);
  const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="/danmaku-content.js"') < html.indexOf('src="/app.js"'));
});
