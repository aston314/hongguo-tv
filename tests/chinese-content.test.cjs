const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const ui = path.resolve(__dirname, '../core/cmd/hongguotv/ui');
const source = fs.readFileSync(path.join(ui, 'chinese-content.js'), 'utf8');
const moduleAPI = require(path.join(ui, 'chinese-content.js'));
const index = JSON.parse(fs.readFileSync(path.join(ui, 'chinese-content/index.json')));
const bytes = fs.readFileSync(path.join(ui, 'chinese-content/s2twp.bin'));
function buffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
function element() {
  const attributes = {};
  let value = '', writes = 0;
  return {
    get textContent() { return value; },
    set textContent(next) { value = next; writes++; },
    get writes() { return writes; },
    setAttribute(key, val) { attributes[key] = String(val); },
    getAttribute(key) { return Object.hasOwn(attributes, key) ? attributes[key] : null; },
    removeAttribute(key) { delete attributes[key]; }
  };
}
function runtime(initialLocale = 'zh-TW') {
  let locale = initialLocale, done, requests = 0, cancellations = 0, scans = 0;
  const nodes = [];
  const document = {
    activeElement: null,
    querySelectorAll() { scans++; return nodes.filter(e => e.getAttribute('data-chinese-content') !== null); }
  };
  const app = moduleAPI.create({
    document, locale: () => locale,
    load(callback) { done = callback; requests++; return () => { cancellations++; }; }
  });
  return {
    app, document,
    node() { const e = element(); nodes.push(e); return e; },
    complete(error) { done(error || null, buffer(), index); },
    change(next) { locale = next; app.localeChanged(); },
    get requests() { return requests; },
    get cancellations() { return cancellations; },
    get scans() { return scans; }
  };
}

test('committed OpenCC data is deterministic, versioned and checksum verified', () => {
  assert.equal(index.version, '1.4.2');
  assert.equal(index.config, 's2twp');
  assert.equal(bytes.length, index.byteLength);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), index.sha256);
  childProcess.execFileSync('python3', ['scripts/build_chinese_content.py', '--check'], { cwd: path.join(__dirname, '..') });
  assert.ok(fs.readFileSync(path.join(ui, 'chinese-content/LICENSE'), 'utf8').includes('Apache License'));
});

test('packed s2twp matches official OpenCC test cases and golden text', () => {
  const convert = moduleAPI.loadDictionary(buffer(), index).converter('s2twp');
  const cases = require('./fixtures/chinese-content/s2twp-cases.json');
  assert.equal(cases.length, 85);
  for (const row of cases) assert.equal(convert(row.input), row.expected, row.input);
  const root = path.join(__dirname, 'fixtures/chinese-content');
  assert.equal(convert(fs.readFileSync(path.join(root, 'us_constitution_zhs.txt'), 'utf8')),
    fs.readFileSync(path.join(root, 'us_constitution_zhs.s2twp.txt'), 'utf8'));
});

test('the actual configured legacy runtime executes the packaged display module', () => {
  childProcess.execFileSync(process.env.WEBOS_LEGACY_NODE || process.execPath,
    [path.join(__dirname, 'fixtures/chinese-content/legacy.cjs')], { timeout: 15000 });
});

test('Simplified and Japanese rendering never request or initialize a dictionary', () => {
  const f = runtime('zh-CN'), title = f.node();
  f.app.setText(title, '谁让这个文盲修仙的');
  assert.equal(title.textContent, '谁让这个文盲修仙的');
  f.change('ja-JP');
  f.app.setText(title, '万妖图录传');
  assert.equal(title.textContent, '万妖图录传');
  assert.equal(f.requests, 0);
  assert.equal(f.app.status().cacheEntries, 0);
});

test('initial Traditional text waits for data once and restores source without DOM replacement', async () => {
  const f = runtime(), title = f.node(), intro = f.node(), actor = f.node();
  const raw = Object.freeze({ series_id: '7704857878514895896', title: '干将莫邪', intro: '电脑鼠标软件自行车', actor: '于和伟' });
  const saved = JSON.stringify(raw);
  f.document.activeElement = title;
  f.app.setText(title, raw.title);
  f.app.setText(intro, raw.intro);
  f.app.setText(actor, raw.actor, true);
  assert.equal(title.textContent, '');
  assert.equal(actor.textContent, '于和伟');
  assert.equal(f.requests, 1);
  f.complete();
  assert.equal(await f.app.prepare(), true);
  assert.equal(title.textContent, '干將莫邪');
  assert.equal(intro.textContent, '電腦滑鼠軟體腳踏車');
  const writes = title.writes, scans = f.scans, calls = f.app.status().conversions;
  for (let i = 0; i < 100; i++) f.app.setText(title, raw.title);
  assert.equal(title.writes, writes);
  assert.equal(f.scans, scans);
  assert.equal(f.app.status().conversions, calls);
  assert.equal(f.document.activeElement, title);
  assert.equal(JSON.stringify(raw), saved);
  f.change('zh-CN');
  assert.equal(title.textContent, '干将莫邪');
  assert.equal(intro.textContent, raw.intro);
  assert.equal(f.app.status().cacheEntries, 0);
});

test('cached original strings avoid repeated conversion and remain bounded while browsing', () => {
  const f = runtime(), title = f.node();
  f.app.setText(title, '短剧'); f.complete();
  for (let i = 0; i < 4000; i++) f.app.setText(title, '头发发展' + i);
  assert.ok(f.app.status().cacheEntries <= 256);
  assert.ok(f.app.status().cacheCharacters <= 65536);
  assert.equal(title.textContent, '頭髮發展3999');
});

test('late dictionary callbacks cannot replace a new drama, loading state or another locale', async () => {
  const f = runtime(), title = f.node(), stale = f.node();
  f.app.setText(title, '第一部短剧'); f.app.setText(stale, '旧短剧');
  f.app.setText(title, '第二部短剧');
  stale.textContent = '播放失败';
  f.complete();
  assert.equal(title.textContent, '第二部短劇');
  assert.equal(stale.textContent, '播放失败');
  const g = runtime(), node = g.node();
  g.app.setText(node, '干将莫邪');
  const pending = g.app.prepare();
  g.change('ja-JP');
  assert.equal(await pending, false);
  assert.equal(g.cancellations, 1);
  g.complete();
  assert.equal(node.textContent, '干将莫邪');
  assert.equal(g.app.status().state, 'idle');
});

test('an asset failure shows original text and never retries on every render', () => {
  const f = runtime(), title = f.node();
  f.app.setText(title, '短剧'); f.complete(new Error('offline'));
  assert.equal(title.textContent, '短剧');
  for (let i = 0; i < 20; i++) f.app.setText(title, '短剧');
  assert.equal(f.requests, 1);
  assert.equal(f.app.status().state, 'failed');
  assert.throws(() => moduleAPI.loadDictionary(new ArrayBuffer(8), index));
  const bad = buffer(); new Uint8Array(bad)[0] = 0;
  assert.throws(() => moduleAPI.loadDictionary(bad, index));
});

test('late accessibility labels follow the original title and no markup is parsed', () => {
  const f = runtime(), title = f.node();
  f.app.setText(title, '<b>短剧</b>');
  f.app.setAttribute(title, 'aria-label', '播放：短剧');
  f.complete();
  assert.equal(title.textContent, '<b>短劇</b>');
  assert.equal(title.getAttribute('aria-label'), '播放：短劇');
  f.change('zh-CN');
  assert.equal(title.getAttribute('aria-label'), '播放：短剧');
});

test('bundled loader handles webOS file assets, failures and local relative URLs', async () => {
  for (const protocol of ['file:', 'http:']) {
    const requests = [], doc = { querySelectorAll() { return []; } };
    class XHR {
      constructor() { requests.push(this); }
      open(method, url, async) { this.url = url; assert.equal(method, 'GET'); assert.equal(async, true); }
      send() {}
      abort() { this.aborted = true; }
    }
    const context = vm.createContext({ document: doc, XMLHttpRequest: XHR, location: { protocol }, HongguoI18n: { locale: () => 'zh-TW', onChange() {} } });
    vm.runInContext(source, context);
    assert.equal(requests.length, 2);
    for (const xhr of requests) {
      assert.match(xhr.url, /^\.\/chinese-content\//);
      xhr.status = protocol === 'file:' ? 0 : 200;
      if (xhr.responseType === 'arraybuffer') xhr.response = buffer();
      else xhr.responseText = JSON.stringify(index);
      xhr.onload();
    }
    assert.equal(await context.HongguoContentText.prepare(), true);
    assert.equal(context.HongguoContentText.text('头发发展'), '頭髮發展');
  }
});
