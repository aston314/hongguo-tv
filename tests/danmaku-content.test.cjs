const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
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
  assert.deepEqual(images.map(n => n.src), ['emoji/hongguo/25.webp', 'emoji/hongguo/20.webp']);
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

test('existing synonymous codes share the same artwork while unmatched codes remain text', () => {
  const aliases = [
    ['[白眼]', '[翻白眼]'], ['[心碎]', '[伤心]'], ['[心]', '[爱心]'],
    ['[强]', '[赞]'], ['[玫瑰]', '[送花]'], ['[破涕为笑]', '[笑哭]'],
    ['[大哭]', '[哭]'], ['[调皮]', '[做鬼脸]'], ['[色]', '[爱慕]'],
    ['[发怒]', '[怒]'], ['[愤怒]', '[怒]'], ['[尴尬]', '[尬笑]'], ['[酷拽]', '[酷]']
  ];
  for (const [alias, canonical] of aliases) {
    const line = createLine(document, {text: alias + canonical});
    const images = line.children.slice();
    assert.equal(images.length, 2);
    assert.equal(images[0].src, images[1].src);
    assert.equal(images[0].alt, alias);
    images[0].events.error(); images[1].events.error();
    assert.equal(textOf(line), alias + canonical, 'a failed alias restores its own original spelling');
    assert.equal(images[0].parentNode, null);
  }
  const text = '[睡觉][流泪][握手][比心][未知表情][ok]';
  const line = createLine(document, {text});
  assert.equal(textOf(line), text);
  assert.equal(descendants(line).filter(n => n.tag === 'img').length, 0);
});

test('all 53 canonical emoji render their original offline assets before the shared app starts', () => {
  const ui = path.resolve(__dirname, '../core/cmd/hongguotv/ui');
  const pack = path.join(ui, 'emoji/hongguo');
  const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'), 'utf8'));
  assert.equal(manifest.items.length, 53);
  assert.equal(new Set(manifest.items.map(item => item.file)).size, 53);
  for (const item of manifest.items) {
    const line = createLine(document, {text: item.code});
    assert.equal(line.children.length, 1);
    const image = line.children[0];
    assert.equal(image.tag, 'img', item.code);
    assert.equal(image.alt, item.code);
    assert.equal(image.src, 'emoji/hongguo/' + item.file, item.code);
    const webp = fs.readFileSync(path.join(pack, item.file));
    assert.equal(webp.subarray(0, 4).toString(), 'RIFF');
    assert.equal(webp.subarray(8, 12).toString(), 'WEBP');
    assert.equal(createHash('sha256').update(webp).digest('hex'), item.sha256);
  }
  assert.match(fs.readFileSync(path.join(pack, 'README.txt'), 'utf8'), /v0\.1\.14/);
  assert.equal(fs.existsSync(path.join(ui, 'emoji/noto')), false);
  const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="/danmaku-content.js"') < html.indexOf('src="/app.js"'));
});
