const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/index.html'), 'utf8');

function block(start, end) {
  return source.slice(source.indexOf('  function ' + start + '('), source.indexOf('  function ' + end + '('));
}

test('search suggestions expose the listbox and route keyboard movement through the focus zone', () => {
  assert.match(html, /id="search-suggestions"[^>]*role="listbox"/);
  assert.match(source, /searchSuggestions: '\.search-suggestion'/);
  const movement = block('moveFrom', 'handleKey');
  assert.match(movement, /if \(zone === 'searchInput'\)[\s\S]*?searchSuggestionOpen \? firstVisible\('\.search-suggestion'\)/);
  assert.match(movement, /if \(zone === 'searchSuggestions'\)[\s\S]*?moveWithinZone\(zone, current, direction\) \|\| searchInput/);
});

test('Back closes suggestions and returns to the input; the same query stays dismissed until edited', () => {
  const schedule = block('scheduleSearchSuggestions', 'activateSearchSuggestion');
  const handleBack = block('handleBack', 'handleMediaCommand');
  assert.match(handleBack, /if \(searchSuggestionOpen\) \{ closeSearchSuggestions\(true\); return true; \}/);
  assert.match(source, /searchSuggestionDismissedQuery = searchInput\.value\.trim\(\);[\s\S]*?goFocus\(searchInput\)/);
  assert.match(schedule, /if \(query === searchSuggestionDismissedQuery\) \{ closeSearchSuggestions\(false\); return; \}/);
  assert.match(source, /searchInput\.addEventListener\('input', function \(\) \{\s*searchSuggestionDismissedQuery = '';/);
});

test('suggestion refresh preserves focus by key when the old DOM node is replaced', () => {
  const render = block('renderSearchSuggestions', 'restoreSearchSuggestionFocus');
  assert.match(render, /var activeElement = typeof androidShell !== 'undefined' && androidShell \? remoteFocusTarget\(\) \|\| document\.activeElement : document\.activeElement/);
  assert.match(render, /restoreSuggestionFocus = !!\(activeElement && activeElement\.closest && activeElement\.closest\('#search-suggestions'\)\) \|\| !!searchSuggestionFocusedKey/);
  assert.match(render, /var previousKey = activeKey \|\| searchSuggestionFocusedKey/);
  assert.match(render, /var target = same \|\| firstVisible\('\.search-suggestion'\)/);
  assert.match(render, /if \(target\) goFocus\(target\)/);
  assert.match(source, /if \(target\.classList && target\.classList\.contains\('search-suggestion'\)\) searchSuggestionFocusedKey = target\.dataset\.suggestionKey \|\| '';\s*else searchSuggestionFocusedKey = ''/);
  assert.match(render, /button\.addEventListener\('focus', function \(\) \{\s*try \{ button\.scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(render, /keepSearchSuggestionFocusVisible\(button\)/);
  assert.match(fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'), 'utf8'), /\.search-suggestions\s*\{[^}]*max-height:\s*60vh/);
});

test('suggestion focus keeps a visible inset at both scroll edges', () => {
  const focus = block('keepSearchSuggestionFocusVisible', 'renderSearchSuggestions');
  assert.match(focus, /var inset = 6/);
  assert.match(focus, /rect\.top < top/);
  assert.match(focus, /rect\.bottom > bottom/);
  assert.match(focus, /scrollHeight[\s\S]*clientHeight/);
});

test('search suggestion focus remains in the native search navigation region for remote selection', () => {
  const focusinStart = source.indexOf("document.addEventListener('focusin'");
  const focusin = source.slice(focusinStart, source.indexOf("document.querySelectorAll('.side-item')", focusinStart));
  assert.match(focusin, /if \(target\.id !== 'search-input'\) window\.HongguoTVInput\.setRemoteNavigationTarget\(!editingTarget && isFocusTarget\(target\)\)/);
  assert.match(source, /if \(zone === 'searchInput'\)[\s\S]*?searchSuggestionOpen \? firstVisible\('\.search-suggestion'\)/);
  assert.match(source, /if \(zone === 'searchSuggestions'\)[\s\S]*?moveWithinZone\(zone, current, direction\)/);
  assert.match(source, /if \(key === 'Enter'\)[\s\S]*?current\.click\(\)/);
  assert.match(source, /function remoteFocusTarget\(\)[\s\S]*?var painted = paintedFocus[\s\S]*?isFocusTarget\(painted\)/);
  assert.match(source, /event\.remoteNavigation \? remoteFocusTarget\(\) \|\| document\.activeElement/);
});

test('suggestion fallback icons use fixed-size inline SVG shapes for legacy Android WebViews', () => {
  const icon = block('createSearchSuggestionIcon', 'closeSearchSuggestions');
  const css = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'), 'utf8');
  assert.match(icon, /document\.createElementNS\(namespace, 'svg'\)/);
  assert.match(icon, /short_play_actor:[\s\S]*?short_play_role:[\s\S]*?album:[\s\S]*?title:[\s\S]*?common_query:/);
  assert.match(icon, /shapes\[kind\] \|\| shapes\.common_query/);
  assert.match(css, /\.search-suggestion-icon\s*\{[^}]*display:\s*flex;[^}]*width:\s*34px;[^}]*height:\s*34px/);
  assert.match(css, /\.search-suggestion-icon svg\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/);
  assert.doesNotMatch(css, /\.search-suggestion-icon\s*\{[^}]*display:\s*grid/);
});

test('suggestion panel uses the input and scan control width without counting search', () => {
  const css = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'), 'utf8');
  assert.match(css, /\.search-suggestions\s*\{[^}]*padding:\s*10px 6px/);
  assert.match(css, /\.search-input-wrap\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.search-suggestions\s*\{[^}]*width:\s*410px;[^}]*max-width:\s*78vw/);
  assert.match(css, /\.desktop-shell\s+\.search-suggestions\s*\{\s*width:\s*354px;\s*\}/);
  assert.doesNotMatch(css, /@media\s*\(min-width:\s*1500px\)\s*\{[^}]*\.search-input-wrap\s*\{\s*position:\s*static/);
});

test('reservation status tabs retain their previous compact pill appearance', () => {
  const css = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'), 'utf8');
  assert.match(css, /\.reservation-tabs\s*\{[^}]*gap:\s*12px/);
  assert.match(css, /\.reservation-tab\s*\{[^}]*min-width:\s*94px;[^}]*min-height:\s*42px;[^}]*background:\s*#20212a;[^}]*border-radius:\s*22px/);
  assert.match(css, /\.reservation-tab\.is-active\s*\{[^}]*background:\s*#f35d7b/);
});

test('search suggestion requests are debounced and stale responses are ignored', () => {
  const load = block('loadSearchSuggestions', 'scheduleSearchSuggestions');
  const schedule = block('scheduleSearchSuggestions', 'activateSearchSuggestion');
  assert.match(schedule, /setTimeout\(function \(\) \{ loadSearchSuggestions\(query\); \}, 240\)/);
  assert.match(load, /generation !== searchSuggestionGeneration/);
  assert.match(load, /searchInput\.value\.trim\(\) !== query/);
});

test('search failures focus a reachable retry action without stealing focus after navigation', () => {
  const submit = block('submitSearch', 'renderSearchHistory');
  const movement = block('moveFrom', 'handleKey');
  const filterMovement = block('moveSearchFilter', 'moveWithinZone');
  assert.match(submit, /var returnTarget = remoteFocusTarget\(\) \|\| document\.activeElement;[\s\S]*?finishSearchEditing\(\)[\s\S]*?if \(searchPager\.error\)[\s\S]*?document\.activeElement === returnTarget \|\| remoteFocusTarget\(\) === returnTarget[\s\S]*?firstVisible\('#search-pagination \.list-retry'\)[\s\S]*?goFocus\(retry\)/);
  assert.match(movement, /if \(zone === 'searchActions'\)[\s\S]*?firstVisible\('#search-pagination \.list-retry'\)/);
  assert.match(filterMovement, /if \(targetRowIndex >= rows\.length\)[\s\S]*?firstVisible\('#search-pagination \.list-retry'\)/);
});

test('desktop search editor routes Escape and boundary navigation to the autocomplete controls', () => {
  const handler = block('handleKey', 'switchPlayerEpisode');
  assert.match(handler, /desktopShell && window\.HongguoDesktopUI\.editing\(current\)[\s\S]*?key === 'Escape' && searchSuggestionOpen[\s\S]*?handleBack\(\)/);
  assert.match(handler, /if \(key === 'ArrowDown'\) searchTarget = moveFrom\(current, 'down'\)/);
  assert.match(handler, /key === 'ArrowRight' && typeof current\.selectionStart === 'number'[\s\S]*?current\.selectionEnd === current\.selectionStart[\s\S]*?searchTarget = firstSearchAction\(\)/);
});

test('selecting drama and actor suggestions uses existing detail and actor-work flows', () => {
  const activate = block('activateSearchSuggestion', 'lastSearchFilter');
  assert.match(activate, /item\.kind === 'short_play_actor' && item\.actor_id[\s\S]*?openActorWorks/);
  assert.match(activate, /item\.drama && item\.drama\.series_id[\s\S]*?openDetail\(item\.drama, undefined, returnFocus\)/);
  assert.match(source, /function restoreSearchSuggestionFocus\(\)[\s\S]*?if \(target\) \{ goFocus\(target\); return true; \}/);
});
