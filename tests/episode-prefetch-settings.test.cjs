const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const settings = require('../core/cmd/hongguotv/ui/episode-prefetch-settings.js');

test('full episode prefetch is available only on Android and desktop shells', () => {
  assert.equal(settings.supports('android'), true);
  assert.equal(settings.supports('desktop'), true);
  assert.equal(settings.supports('webos'), false);
  assert.equal(settings.supports('preview'), false);
});

test('supported shells default missing preferences to full while webOS stays on range', () => {
  assert.equal(settings.normalize(''), 'full');
  assert.equal(settings.normalize('unknown'), 'full');
  assert.equal(settings.normalize('range'), 'range');
  assert.equal(settings.normalize('full'), 'full');
  for(const platform of ['android','desktop']) {
    assert.equal(settings.create({platform}).mode(),'full');
    assert.equal(settings.create({platform,read:()=> 'range'}).mode(),'range');
  }
  let value = 'unknown';
  const states = [];
  const controller = settings.create({platform: 'webos', read: () => value, write: next => { value = next; }, render: state => states.push(state)});
  assert.equal(controller.mode(), 'range');
  assert.equal(controller.choose('full'), false);
  assert.equal(states.at(-1).mode, 'range');
});

test('a supported shell persists the selected strategy and reports save failures', () => {
  let value = 'range';
  const states = [];
  const controller = settings.create({platform: 'desktop', read: () => value, write: next => { value = next; }, render: state => states.push(state)});
  assert.equal(controller.choose('full'), true);
  assert.equal(value, 'full');
  assert.equal(controller.mode(), 'full');
  assert.equal(states.at(-1).supported, true);
  let failed = settings.create({platform: 'android', read: () => 'range', write: () => false, render: state => states.push(state)});
  assert.equal(failed.choose('full'), false);
  assert.equal(failed.mode(), 'range');
  assert.equal(states.at(-1).message, 'save_failed');
});

test('app preference restoration uses the new default without replacing saved choices or enabling webOS full downloads',()=>{
  const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
  const declaration=source.match(/  var playbackPreferences = [^\n]+/)[0];
  const start=source.indexOf('  function restorePlaybackPreferences(');
  const restore=source.slice(start,source.indexOf('  function cancelDiagnosticRead(',start));
  for(const platform of ['android','desktop','webos','preview']) {
    for(const [saved,expected] of [[null,'full'],['{}','full'],['{"prefetch_mode":"range"}','range'],['{"prefetch_mode":"full"}','full'],['{"prefetch_mode":"unknown"}','full'],['broken-json','full']]) {
      const context={HongguoEpisodePrefetchSettings:settings,androidShell:platform==='android',
        episodePrefetchPlatform:()=>platform,playbackSpeeds:[1],playbackSpeedAvailable:()=>true,
        localStorage:{getItem:()=>saved},window:{HongguoTVPreferences:{read:()=>saved}},
        document:{getElementById:()=>({}),querySelector:()=>({classList:{toggle(){}}})},
        savePlaybackPreferences(){},setPlaybackMuted(){},updateDanmakuButton(){},updatePlaybackControls(){}};
      vm.createContext(context);vm.runInContext(declaration+'\n'+restore,context);
      context.restorePlaybackPreferences();
      const expectedMode=settings.supports(platform)?expected:'range';
      assert.equal(context.playbackPreferences.prefetch_mode,expectedMode,platform+' '+saved);
      const controller=settings.create({platform,read:()=>context.playbackPreferences.prefetch_mode});
      assert.equal(controller.mode(),expectedMode,'settings and playback must agree');
    }
  }
});
