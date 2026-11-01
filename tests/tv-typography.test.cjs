const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const compat = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/compat.css'), 'utf8');

test('TV typography preserves compact and wide viewports while 1280px uses the shared scale', () => {
  assert.match(app, /classList\.toggle\('tv-shell', androidShell \|\| webosShell\)/);

  const media = compat.match(/@media\s*\(max-width:\s*(\d+)px\),\s*\(min-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(media, 'expected compact and wide TV typography ranges');
  const compactMax = Number(media[1]);
  const wideMin = Number(media[2]);
  assert.ok(960 <= compactMax, 'Shield CSS viewport should retain TV typography');
  assert.ok(1280 > compactMax && 1280 < wideMin, 'Zidoo CSS viewport should use the shared scale');
  assert.ok(1920 >= wideMin, 'wide CSS viewports should retain TV typography');

  const tvStyles = media[3];
  assert.match(tvStyles, /html\.tv-shell \.catalog-card-title \{ font-size: 18px; \}/);
  assert.match(tvStyles, /html\.tv-shell \.catalog-card-meta \{ font-size: 13px; \}/);
  assert.match(tvStyles, /html\.tv-shell \.radar-row \{ font-size: 16px; \}/);
  assert.match(compat, /@media\s*\(max-width\s*:\s*1023px\)\s*,\s*\(min-width\s*:\s*1600px\)/);
});

test('TV shells share the existing responsive sidebar instead of overriding its height breakpoints', () => {
  // The former higher-specificity TV rules forced 54px items even at 540px
  // height, defeating all three shared short-viewport rules.
  const selectors = compat.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) || [];
  for (const selector of selectors) {
    if (/\.tv-shell\b/.test(selector)) {
      assert.doesNotMatch(selector, /\.(?:brand|side-nav|side-item|side-icon|sidebar-bottom)\b/);
    }
  }
  assert.doesNotMatch(app, /HongguoTVLayout|refreshTvLayout|tv-layout-/);
  assert.doesNotMatch(compat, /\.tv-layout-/);
  const index = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');
  assert.doesNotMatch(index, /tv-layout\.js/);
});
