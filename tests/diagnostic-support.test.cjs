const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const index = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');
const functions = source.slice(source.indexOf('  function moveSupportFocus('), source.indexOf("  document.querySelectorAll('.support-card').forEach"));

function element(id, classes = []) {
  const names = new Set(classes), attributes = {};
  return { id, attributes, get src() { return attributes.src; }, set src(value) { attributes.src = value; }, classList: {
    add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name),
    toggle(name, enabled) { if (enabled) names.add(name); else names.delete(name); }
  }, setAttribute(name, value) { attributes[name] = value; },
  getAttribute(name) { return attributes[name] || null; }, removeAttribute(name) { delete attributes[name]; } };
}

function fixture() {
  const nodes = {};
  for (const id of ['support-modal', 'support-modal-methods', 'support-modal-title', 'support-large-qr',
    'support-close', 'support-method-wechat', 'support-method-alipay', 'player-diagnostics-support', 'player-options']) nodes[id] = element(id);
  nodes['support-modal'].classList.add('is-hidden');
  nodes['support-modal-methods'].classList.add('is-hidden');
  nodes['player-options'].classList.add('is-diagnostics');
  const cards = {};
  for (const method of ['wechat', 'alipay']) {
    const img = element(method + '-image');
    img.setAttribute('src', '/images/support-' + method + '.png');
    img.alt = method + '二维码';
    cards[method] = { querySelector: selector => selector === 'img' ? img : { textContent: method + '打赏' } };
  }
  const focus = [];
  const c = vm.createContext({ playerOptionsOpen: true, supportModalOpen: false, supportReturnFocus: null,
    document: { getElementById: id => nodes[id], querySelector(selector) {
      if (selector.includes('support-wechat')) return cards.wechat;
      if (selector.includes('support-alipay')) return cards.alipay;
      if (selector === '.support-method-option.is-selected') return ['wechat', 'alipay'].map(method => nodes['support-method-' + method]).find(node => node.classList.contains('is-selected'));
      throw new Error('Unexpected selector: ' + selector);
    } }, goFocus: node => focus.push(node), focusables: () => [nodes['player-diagnostics-support']],
    firstContentFocus() { throw new Error('Must restore the diagnostic entry'); }
  });
  vm.runInContext(functions, c);
  return { c, nodes, cards, focus };
}

test('support card precedes diagnostic content while diagnostics keeps its reading entry focus', () => {
  assert.ok(index.indexOf('id="player-diagnostics-support"') < index.indexOf('id="player-diagnostics-scroll"'));
  const open = source.slice(source.indexOf('  function openPlayerOptions('), source.indexOf('  function seekTo('));
  const diagnostics = open.slice(open.indexOf("if (kind === 'diagnostics')"), open.indexOf('    var video ='));
  assert.match(diagnostics, /goFocus\(document\.getElementById\('player-diagnostics-scroll'\)\)/);
  assert.doesNotMatch(diagnostics, /goFocus\(document\.getElementById\('player-diagnostics-support'\)\)/);
});

test('diagnostic support reuses both existing QR assets and returns without closing or resetting diagnostics', () => {
  const f = fixture(), n = f.nodes;
  f.c.openDiagnosticSupport();
  assert.equal(f.c.supportModalOpen, true);
  assert.equal(f.c.supportReturnFocus, n['player-diagnostics-support']);
  assert.equal(n['support-modal'].classList.contains('is-diagnostic-support'), true);
  assert.equal(n['support-modal-methods'].classList.contains('is-hidden'), false);
  assert.equal(n['support-large-qr'].getAttribute('src'), '/images/support-wechat.png');
  assert.equal(f.focus.at(-1), n['support-method-wechat']);
  f.c.selectDiagnosticSupportMethod('alipay');
  assert.equal(n['support-large-qr'].getAttribute('src'), '/images/support-alipay.png');
  assert.equal(n['support-modal-title'].textContent, 'alipay打赏');
  assert.equal(n['support-method-wechat'].getAttribute('aria-pressed'), 'false');
  assert.equal(n['support-method-alipay'].getAttribute('aria-pressed'), 'true');
  f.c.selectDiagnosticSupportMethod('unexpected');
  assert.equal(n['support-large-qr'].getAttribute('src'), '/images/support-alipay.png');
  f.c.closeSupportQR();
  assert.equal(f.c.playerOptionsOpen, true);
  assert.equal(f.c.supportModalOpen, false);
  assert.equal(n['support-modal'].classList.contains('is-hidden'), true);
  assert.equal(n['support-modal'].classList.contains('is-diagnostic-support'), false);
  assert.equal(n['support-modal-methods'].classList.contains('is-hidden'), true);
  assert.equal(n['support-large-qr'].getAttribute('src'), null);
  assert.equal(f.focus.at(-1), n['player-diagnostics-support']);
});

test('donation remote focus stays inside the dialog and returns to the selected method', () => {
  const f = fixture(), n = f.nodes;
  f.c.openDiagnosticSupport();
  const close = n['support-close'], wechat = n['support-method-wechat'], alipay = n['support-method-alipay'];
  assert.equal(f.c.moveSupportFocus(wechat, 'right'), alipay);
  assert.equal(f.c.moveSupportFocus(alipay, 'left'), wechat);
  assert.equal(f.c.moveSupportFocus(alipay, 'right'), alipay);
  assert.equal(f.c.moveSupportFocus(wechat, 'down'), wechat);
  assert.equal(f.c.moveSupportFocus(wechat, 'up'), close);
  assert.equal(f.c.moveSupportFocus(close, 'down'), wechat);
  f.c.selectDiagnosticSupportMethod('alipay');
  assert.equal(f.c.moveSupportFocus(close, 'down'), alipay);
});

test('support page and SMS QR retain the single-image dialog without method choices', () => {
  const f = fixture(), n = f.nodes;
  f.c.openDiagnosticSupport();
  f.c.closeSupportQR();
  const smsImage = element('sms-qr');
  smsImage.setAttribute('src', 'data:image/png;base64,fixture');
  smsImage.alt = '短信二维码';
  f.c.openQRCode(n['player-diagnostics-support'], smsImage, '扫码填写短信');
  assert.equal(n['support-modal-methods'].classList.contains('is-hidden'), true);
  assert.equal(n['support-modal'].classList.contains('is-diagnostic-support'), false);
  assert.equal(n['support-large-qr'].getAttribute('src'), 'data:image/png;base64,fixture');
  assert.equal(n['support-modal-title'].textContent, '扫码填写短信');
  assert.equal(f.focus.at(-1), n['support-close']);
  for (const direction of ['up', 'down', 'left', 'right']) assert.equal(f.c.moveSupportFocus(n['support-close'], direction), n['support-close']);
});

test('support entry cannot open outside active diagnostics or replace an open QR', () => {
  const f = fixture();
  f.c.playerOptionsOpen = false;
  f.c.openDiagnosticSupport();
  assert.equal(f.c.supportModalOpen, false);
  f.c.playerOptionsOpen = true;
  f.nodes['player-options'].classList.remove('is-diagnostics');
  f.c.openDiagnosticSupport();
  assert.equal(f.c.supportModalOpen, false);
  f.nodes['player-options'].classList.add('is-diagnostics');
  f.c.openDiagnosticSupport();
  f.c.selectDiagnosticSupportMethod('alipay');
  f.c.openDiagnosticSupport();
  assert.equal(f.nodes['support-large-qr'].getAttribute('src'), '/images/support-alipay.png');
});
