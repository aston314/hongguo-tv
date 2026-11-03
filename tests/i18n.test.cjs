const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const localeSource = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/locales/zh-CN.js'), 'utf8');
const traditionalLocaleSource = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/locales/zh-TW.js'), 'utf8');
const japaneseLocaleSource = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/locales/ja-JP.js'), 'utf8');
const i18nSource = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/i18n.js'), 'utf8');
const appHtml = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');
const paginationSource = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/pagination.js'), 'utf8');

function runtime() {
  const listeners = {};
  const document = {
    documentElement: {},
    addEventListener(name, callback) { listeners[name] = callback; },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({ document, localStorage: { getItem() { return null; }, setItem() {} } });
  vm.runInContext(localeSource + '\n' + i18nSource, context);
  return { context, document, listeners };
}

function multilingualRuntime(overrides) {
  const listeners = {};
  const document = {
    documentElement: {},
    addEventListener(name, callback) { listeners[name] = callback; },
    querySelectorAll() { return []; }
  };
  const bridge = overrides && overrides.bridge;
  const storage = {
    value: overrides && overrides.storageLocale ? overrides.storageLocale : null,
    getItem() { return this.value; },
    setItem(_, value) { this.value = value; }
  };
  const navigator = overrides && overrides.navigator ? overrides.navigator : {};
  const context = vm.createContext({ document, localStorage: storage, HongguoTVPreferences: bridge, navigator });
  vm.runInContext(localeSource + '\n' + traditionalLocaleSource + '\n' + japaneseLocaleSource + '\n' + i18nSource, context);
  return { context, document, listeners, storage };
}

test('Chinese locale is the default and missing keys fall back safely', () => {
  const { context } = runtime();
  assert.equal(context.HongguoI18n.locale(), 'zh-CN');
  assert.equal(context.HongguoI18n.t('nav.recommend'), '推荐');
  assert.equal(context.HongguoI18n.t('settings.decoderApplied', { mode: '软件解码' }), '已选择软件解码，下次播放或切集时生效。');
  assert.equal(context.HongguoI18n.t('missing.key', null, '保留中文'), '保留中文');
});

test('unsupported locale does not alter the current UI language', () => {
  const { context } = runtime();
  assert.equal(context.HongguoI18n.setLocale('en-US'), false);
  assert.equal(context.HongguoI18n.locale(), 'zh-CN');
});

test('an incomplete locale cannot be selected and a complete locale can be registered later', () => {
  const { context } = runtime();
  context.HongguoLocales['en-US'] = { 'common.close': 'Close' };
  assert.equal(context.HongguoI18n.setLocale('en'), false);
  assert.equal(context.HongguoI18n.supportedLocales().includes('en-US'), false);
  assert.ok(context.HongguoI18n.missingKeys('en-US').length > 0);

  const complete = {};
  Object.keys(context.HongguoLocales['zh-CN']).forEach((key) => { complete[key] = context.HongguoLocales['zh-CN'][key]; });
  complete['common.close'] = 'Close';
  context.HongguoLocales['en-US'] = complete;
  assert.equal(context.HongguoI18n.setLocale('en'), true);
  assert.equal(context.HongguoI18n.locale(), 'en-US');
  assert.equal(context.HongguoI18n.t('common.close'), 'Close');
});

test('data-i18n markers update text and accessibility attributes', () => {
  const { context } = runtime();
  const textNode = {
    textContent: '旧文本',
    ownerDocument: {
      createElement(name) { return { nodeName: name, textContent: '', children: [], appendChild(child) { this.children.push(child); this.textContent += child.textContent || ''; } }; },
      createTextNode(value) { return { nodeName: '#text', textContent: value }; }
    },
    children: [],
    appendChild(child) { this.children.push(child); this.textContent += child.textContent || ''; },
    getAttribute(name) { return name === 'data-i18n' ? 'common.close' : null; },
    setAttribute() {}
  };
  const ariaNode = {
    getAttribute(name) { return name === 'data-i18n-aria-label' ? 'common.refresh' : null; },
    setAttribute(name, value) { this[name] = value; }
  };
  const placeholderNode = {
    getAttribute(name) { return name === 'data-i18n-placeholder' ? 'search.placeholder' : null; },
    setAttribute(name, value) { this[name] = value; }
  };
  const document = context.document;
  document.querySelectorAll = function (selector) {
    if (selector === '[data-i18n]') return [textNode];
    if (selector === '[data-i18n-aria-label]') return [ariaNode];
    if (selector === '[data-i18n-placeholder]') return [placeholderNode];
    return [];
  };
  context.HongguoI18n.apply(document);
  assert.equal(textNode.children[0].textContent, '关闭');
  assert.equal(ariaNode['aria-label'], '刷新');
  assert.equal(placeholderNode.placeholder, '输入剧名 / 关键词');
});

test('series tab keeps its count node when the locale replaces translated text', () => {
  const match = appHtml.match(/<button class="detail-tab" id="detail-tab-series"[^>]*>(.*?)<\/button>/);
  assert.ok(match, 'series tab exists');
  assert.match(match[1], /^<span data-i18n="modal\.series">系列剧<\/span><span id="detail-series-count"><\/span>$/);
  assert.doesNotMatch(match[0], /data-i18n="modal\.series"[^>]*>系列剧<span id="detail-series-count"/);
});

test('explicit line-break tokens render as elements instead of HTML', () => {
  const { context } = runtime();
  const node = {
    textContent: '旧文本',
    ownerDocument: {
      createElement(name) { return { nodeName: name, textContent: '', children: [], appendChild(child) { this.children.push(child); this.textContent += child.textContent || ''; } }; },
      createTextNode(value) { return { nodeName: '#text', textContent: value }; }
    },
    children: [],
    appendChild(child) { this.children.push(child); this.textContent += child.textContent || ''; },
    getAttribute(name) { return name === 'data-i18n' ? 'support.description' : null; }
  };
  context.document.querySelectorAll = function (selector) { return selector === '[data-i18n]' ? [node] : []; };
  context.HongguoI18n.apply(context.document);
  assert.equal(node.children.some(child => child.nodeName === 'br'), true);
  assert.equal(node.children.some(child => child.textContent.indexOf('<') >= 0), false);
});

test('pagination keeps detailed errors in Chinese and uses a resource for translated locales', async () => {
  const { context } = runtime();
  vm.runInContext(paginationSource, context);
  const pager = context.HongguoPagination.create({ request: async () => { throw new Error('upstream detail'); }, clear() {}, render() {} });
  await pager.reset();
  assert.equal(pager.error, 'upstream detail');
});

test('traditional Chinese and Japanese resources are complete and selectable', () => {
  const { context } = multilingualRuntime();
  assert.deepEqual(Array.from(context.HongguoI18n.supportedLocales()).sort(), ['ja-JP', 'zh-CN', 'zh-TW']);
  assert.equal(context.HongguoI18n.setLocale('zh-TW'), true);
  assert.equal(context.HongguoI18n.t('nav.recommend'), '推薦');
  assert.equal(context.HongguoI18n.setLocale('ja'), true);
  assert.equal(context.HongguoI18n.locale(), 'ja-JP');
  assert.equal(context.HongguoI18n.t('common.close'), '閉じる');
  assert.equal(context.HongguoI18n.missingKeys('zh-TW').length, 0);
  assert.equal(context.HongguoI18n.missingKeys('ja-JP').length, 0);
  const sourceKeys = Object.keys(context.HongguoLocales['zh-CN']).sort();
  assert.deepEqual(Array.from(Object.keys(context.HongguoLocales['zh-TW'])).sort(), sourceKeys);
  assert.deepEqual(Array.from(Object.keys(context.HongguoLocales['ja-JP'])).sort(), sourceKeys);
});

test('first launch follows the system locale and maps regional Chinese correctly', () => {
  const traditional = multilingualRuntime({ navigator: { languages: ['zh-HK'], language: 'zh-HK' } });
  assert.equal(traditional.context.HongguoI18n.locale(), 'zh-TW');

  const japanese = multilingualRuntime({ navigator: { languages: ['ja-JP'], language: 'ja-JP' } });
  assert.equal(japanese.context.HongguoI18n.locale(), 'ja-JP');

  const fallback = multilingualRuntime({ navigator: { languages: ['en-US'], language: 'en-US' } });
  assert.equal(fallback.context.HongguoI18n.locale(), 'zh-CN');
});

test('explicit locale preference wins over the system locale', () => {
  const runtime = multilingualRuntime({
    storageLocale: 'zh-CN',
    navigator: { languages: ['ja-JP'], language: 'ja-JP' }
  });
  assert.equal(runtime.context.HongguoI18n.locale(), 'zh-CN');
});

test('Android bridge uses native system locale when no explicit override exists', () => {
  const runtime = multilingualRuntime({
    navigator: { languages: ['en-US'], language: 'en-US' },
    bridge: {
      hasLocaleOverride() { return false; },
      readLocale() { return 'zh-CN'; },
      readSystemLocale() { return 'ja-JP'; }
    }
  });
  assert.equal(runtime.context.HongguoI18n.locale(), 'ja-JP');

  const selected = multilingualRuntime({
    navigator: { languages: ['ja-JP'], language: 'ja-JP' },
    bridge: {
      hasLocaleOverride() { return true; },
      readLocale() { return 'zh-TW'; },
      readSystemLocale() { return 'ja-JP'; }
    }
  });
  assert.equal(selected.context.HongguoI18n.locale(), 'zh-TW');
});

test('localized status rendering is not overwritten by static locale application', () => {
  const { context, document } = multilingualRuntime();
  const label = { textContent: context.HongguoI18n.t('ui.serviceConnected') };
  assert.match(appHtml, /<span id="core-status-label">/);
  assert.doesNotMatch(appHtml, /<span id="core-status-label"[^>]*data-i18n=/);
  document.querySelectorAll = (selector) => selector === '[data-i18n]' ? [] : [];
  context.HongguoI18n.onChange(() => { label.textContent = context.HongguoI18n.t('ui.serviceConnected'); });

  context.HongguoI18n.apply(document);
  assert.equal(label.textContent, '已连接');
  assert.equal(context.HongguoI18n.setLocale('zh-TW'), true);
  context.HongguoI18n.apply(document);
  assert.equal(label.textContent, '已連線');
  assert.equal(context.HongguoI18n.setLocale('ja-JP'), true);
  context.HongguoI18n.apply(document);
  assert.equal(label.textContent, '接続済み');
});

test('locale preference uses the Android bridge and does not change on persistence failure', () => {
  let stored = 'zh-CN';
  const bridge = {
    readLocale() { return stored; },
    writeLocale(value) { stored = value; }
  };
  const { context } = multilingualRuntime({ bridge });
  assert.equal(context.HongguoI18n.locale(), 'zh-CN');
  assert.equal(context.HongguoI18n.setLocale('zh-TW'), true);
  assert.equal(stored, 'zh-TW');
  assert.equal(context.HongguoI18n.locale(), 'zh-TW');

  const failing = multilingualRuntime({ bridge: {
    readLocale() { return 'zh-CN'; },
    writeLocale() { throw new Error('bridge unavailable'); }
  } });
  assert.equal(failing.context.HongguoI18n.setLocale('ja-JP'), false);
  assert.equal(failing.context.HongguoI18n.locale(), 'zh-CN');
});
