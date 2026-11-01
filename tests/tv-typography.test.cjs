const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const compat = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/compat.css'), 'utf8');

test('TV content retains the v0.2.137 scale independently of viewport width', () => {
  assert.match(app, /classList\.toggle\('tv-shell', androidShell \|\| webosShell\)/);

  // A width gate here shrank the entire Zidoo content area at 1280x720.
  const mediaBlocks = compat.match(/@media[^{}]+\{(?:[^{}]|\{[^{}]*\})*\}/g) || [];
  for (const block of mediaBlocks) {
    assert.doesNotMatch(block, /html\.tv-shell\s+\.(?:page-context|channel-tab|hero-title|catalog-card-title|new-card-title|rank-row-title|radar-title)\b/);
  }
  const tvStyles = compat.slice(compat.indexOf('html.tv-shell .page-context'));
  assert.match(tvStyles, /html\.tv-shell \.page-context \{ font-size: 18px; \}/);
  assert.match(tvStyles, /html\.tv-shell \.hero-title \{ font-size: 26px; \}/);
  assert.match(tvStyles, /html\.tv-shell \.new-card-title,[\s\S]*?\.library-card-title \{ font-size: 17px; \}/);
  assert.match(tvStyles, /html\.tv-shell \.catalog-card-title \{ font-size: 18px; \}/);
  assert.match(tvStyles, /html\.tv-shell \.catalog-card-meta \{ font-size: 13px; \}/);
  assert.match(tvStyles, /html\.tv-shell \.radar-row \{ font-size: 16px; \}/);
});

test('only short TV viewports replace the v0.2.137 sidebar with the shared compact rules', () => {
  const css = compat.replace(/\/\*[\s\S]*?\*\//g, '');
  const mediaBlocks = css.match(/@media[^{}]+\{(?:[^{}]|\{[^{}]*\})*\}/g) || [];
  const sidebarSelector = /\.tv-shell\s+[^{}]*\.(?:brand|side-nav|side-item|side-icon|sidebar-bottom)\b/;
  const tvSidebarBlocks = mediaBlocks.filter(block => sidebarSelector.test(block));
  assert.equal(tvSidebarBlocks.length, 2, 'retain the regular-height sidebar and legacy spacing');
  for (const block of tvSidebarBlocks) {
    assert.match(block, /^@media\s*\(min-height:\s*561px\)/,
      'TV-specific sidebar sizing must leave the existing <=560px compact layout in control');
  }
  assert.match(tvSidebarBlocks[0], /html\.tv-shell \.side-item \{ min-height: 54px;[^}]*font-size: 20px;/);
  assert.match(tvSidebarBlocks[0], /html\.tv-shell \.brand \{ height: 48px; font-size: 21px;/);
  assert.match(tvSidebarBlocks[1], /margin-top: 3px;/);
  const unscoped = mediaBlocks.reduce((rest, block) => rest.replace(block, ''), css);
  assert.doesNotMatch(unscoped, sidebarSelector);
  const compact = mediaBlocks.find(block => /^@media\s*\(max-height:\s*560px\)/.test(block));
  assert.ok(compact);
  assert.match(compact, /\.side-item \{ min-height: 36px; font-size: 17px; \}/);
});

test('TV layout does not introduce a separate device or resolution scaling module', () => {
  assert.doesNotMatch(app, /HongguoTVLayout|refreshTvLayout|tv-layout-/);
  assert.doesNotMatch(compat, /\.tv-layout-/);
  const index = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');
  assert.doesNotMatch(index, /tv-layout\.js/);
});
