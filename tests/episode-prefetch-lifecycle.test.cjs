const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const helperStart = source.indexOf('  function cancelFullEpisodePrefetchForPlayback(');
const helperEnd = source.indexOf('\n  function holdPlaybackAudio(', helperStart);
const helper = source.slice(helperStart, helperEnd).trim();
const stalledStart = source.indexOf("  media.addEventListener('stalled'");
const seekingStart = source.indexOf("  media.addEventListener('seeking'", stalledStart);
const stalledListener = source.slice(stalledStart, seekingStart).trim();

function fixture() {
  const callbacks = {};
  const video = {ended: false};
  const calls = [];
  const context = vm.createContext({
    activePlayback: {started: true, ended: false, completed: false, mode: 'full'},
    document: {getElementById: () => video},
    effectiveEpisodePrefetchMode: () => 'full',
    episodePrefetch: {cancelPending: mode => calls.push(mode)},
    media: {addEventListener: (name, callback) => { callbacks[name] = callback; }},
    scheduleRangeStallFallback() {}
  });
  vm.runInContext(helper + '\n' + stalledListener, context);
  return {callbacks, calls, context, video};
}

test('a stalled current episode cancels only the unfinished full-file predownload', () => {
  const f = fixture();
  f.callbacks.stalled();
  assert.deepEqual(f.calls, ['full']);
});

test('a terminal media pause does not cancel the next episode at the natural end', () => {
  const f = fixture();
  f.video.ended = true;
  f.context.cancelFullEpisodePrefetchForPlayback(f.context.activePlayback);
  assert.deepEqual(f.calls, []);
});

test('Range mode and completed predownloads are not cancelled by a stall or pause', () => {
  const f = fixture();
  f.context.effectiveEpisodePrefetchMode = () => 'range';
  f.callbacks.stalled();
  f.context.effectiveEpisodePrefetchMode = () => 'full';
  f.context.activePlayback.completed = true;
  f.context.cancelFullEpisodePrefetchForPlayback(f.context.activePlayback);
  assert.deepEqual(f.calls, []);
});
