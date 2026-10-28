const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const start = source.indexOf('  function rangePlaybackEnabled()');
const end = source.indexOf('\n  var keyNames', start);
const policy = source.slice(start, end).trim();

test('MPV opts into Range playback and retains the normal full-file fallback contract', () => {
  const context = vm.createContext({window:{HongguoNativePlayer:{engine:()=> 'mpv'}}});
  vm.runInContext(policy + '\nthis.rangePlaybackEnabled = rangePlaybackEnabled;', context);
  assert.equal(context.rangePlaybackEnabled(), true);
  assert.match(source, /var params = \{ series_id: item\.series_id, vid: vid, quality: playbackPreferences\.quality, fallback: '1', mode: playbackMode \}/);
  assert.match(source, /var params = HongguoEpisodePrefetch\.prepareParams\(target\)/);
  assert.match(source, /new URLSearchParams\(\{ series_id: playback\.item\.series_id, vid: playback\.vid, quality: playbackPreferences\.quality, fallback: '1' \}\)/);
  assert.match(source, /var stallDelay = webosShell && !playback\.started \? webOSRangeStallFallbackMs : playbackEngineName\(\) === 'mpv' \? 40000 : 45000/);
});
