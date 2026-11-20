const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const activity = fs.readFileSync(require.resolve('../android/app/src/main/java/rocks/aston/hongguotv/MainActivity.java'), 'utf8');

test('Android search focus asks native code for one conditional renderer-focus repair', () => {
  const focusin = app.slice(app.indexOf("document.addEventListener('focusin'"), app.indexOf("document.addEventListener('focusout'"));
  assert.match(focusin, /androidShell[\s\S]*?beginSearchEditing\(typeof document\.hasFocus === 'function' && document\.hasFocus\(\)\)/);
  assert.match(activity, /public void beginSearchEditing\(boolean documentHasFocus\)[\s\S]*?requestSearchEditing\(documentHasFocus\)/);
  assert.match(activity, /private void requestSearchEditing\(boolean documentHasFocus\)[\s\S]*?inputEditingState\.beginSearch\(\);[\s\S]*?runOnUiThread\(\(\) -> beginSearchEditingOnUiThread\(documentHasFocus\)\)/);
  assert.match(activity, /private void beginSearchEditingOnUiThread\(boolean documentHasFocus\)[\s\S]*?if \(searchInputFocusPolicy\.shouldRepairRendererFocus\(documentHasFocus\)\)/);
  assert.match(activity, /webView\.clearFocus\(\);\s*webView\.requestFocus\(View\.FOCUS_DOWN\);/);
});

test('search submission explicitly dismisses the native IME while browser behavior stays unchanged', () => {
  const submit = app.slice(app.indexOf('  function submitSearch()'), app.indexOf('  function renderSearchHistory('));
  assert.match(submit, /if \(androidShell && window\.HongguoTVInput[\s\S]*?finishSearchEditing\(\)/);
  assert.match(activity, /public void finishSearchEditing\(\)[\s\S]*?completeSearchEditing\(false\)/);
  const finish = activity.slice(activity.indexOf('    private void completeSearchEditing('), activity.indexOf('    private String mediaCommand('));
  assert.match(finish, /keyboard\.hideSoftInputFromWindow/);
  assert.match(finish, /if \(returnFocusToSearchActions && wasEditing/);
});

test('Back dismisses the IME and restores focus within the active search area', () => {
  const preIme = activity.slice(activity.indexOf('public boolean onKeyPreIme('), activity.indexOf('        };', activity.indexOf('public boolean onKeyPreIme(')));
  const dispatch = activity.slice(activity.indexOf('public boolean dispatchKeyEvent('), activity.indexOf('private static int searchConfirmKeyBit('));
  assert.match(preIme, /InputKeyPolicy\.isBackKey\(keyCode\) && InputKeyPolicy\.shouldDismissInputBack\(inputEditingState\.snapshot\(\)\)/);
  assert.match(preIme, /KeyEvent\.ACTION_UP[\s\S]*?completeSearchEditing\(true\)/);
  assert.match(preIme, /KeyEvent\.ACTION_UP[\s\S]*?inputEditingState\.cancelBack\(\)/);
  assert.doesNotMatch(activity, /KeyEvent\.ACTION_CANCEL/);
  assert.match(dispatch, /InputKeyPolicy\.shouldDismissInputBack\(editing\)[\s\S]*?completeSearchEditing\(true\)/);
  assert.match(dispatch, /requestPageBack\(\)/);
  assert.match(app, /finishSearchEditing: function \(\) \{ var current = typeof androidShell !== 'undefined' && androidShell \? remoteFocusTarget\(\) \|\| document\.activeElement : document\.activeElement; if \(current === searchInput\) goFocus\(searchSuggestionOpen \? firstVisible\('\.search-suggestion'\) \|\| firstSearchAction\(\) \|\| firstSearchFilter\(\) : firstSearchAction\(\) \|\| firstSearchFilter\(\)\); \}/);
});

test('general focus restoration avoids an active editor while search repair requires a ready foreground page', () => {
  assert.match(activity, /if \(!repairingSearchInput && \(inputEditingState\.snapshot\(\)\.isEditing\(\) \|\| isKeyboardVisible\(\)\)\) return/);
  assert.match(activity, /private void beginSearchEditingOnUiThread\(boolean documentHasFocus\)[\s\S]*?!inputEditingState\.snapshot\(\)\.isSearchEditing\(\)/);
});

test('Android keeps D-pad and confirm routed through the search focus graph after leaving the editor', () => {
  const focusinStart = app.indexOf("document.addEventListener('focusin'");
  const focusin = app.slice(focusinStart, app.indexOf("document.querySelectorAll('.side-item')", focusinStart));
  assert.match(focusin, /setRemoteNavigationTarget\(!editingTarget && isFocusTarget\(target\)\)/);
  assert.match(activity, /searchNavigationState\.routeFallbackNavigationKey\(editing\.isEditing\(\)\)/);
  const beginEditingStart = activity.indexOf('private void beginSearchEditingOnUiThread');
  const beginEditing = activity.slice(beginEditingStart, activity.indexOf('private void completeAccountEditing', beginEditingStart));
  assert.match(beginEditing, /searchNavigationState\.arm\(\)/);
  assert.doesNotMatch(beginEditing, /if \(!documentHasFocus\)[\s\S]*?searchNavigationState\.arm\(\)/);
  assert.match(activity, /searchConfirmKeyBit\(event.getKeyCode\(\)\)[\s\S]*?remoteKey\(" \+ event\.getKeyCode\(\)/);
  assert.match(activity, /public void setRemoteNavigationTarget\(boolean active\)[\s\S]*?searchNavigationState\.setRemoteNavigationTarget/);
  assert.match(app, /function remoteKey\(keyCode, repeat\) \{\s*if \(\[19, 20, 21, 22, 23, 66, 160\]/);
});
