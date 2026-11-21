const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create,createHardwareHevc} = require('../core/cmd/hongguotv/ui/playback-settings.js');

function fixture(engine='mpv', initial='mpv_auto') {
  let stored=initial; const writes=[], states=[];
  const bridge={engine:()=>engine,decoderMode:()=>stored,setDecoderMode:value=>{stored=value;writes.push(value)}};
  return {bridge,writes,states,settings:create({bridge,render:state=>states.push(state)})};
}
test('only MPV exposes decoding settings; browser and standard playback never receive preference writes',()=>{
  for (const engine of ['webview_media3','']) {
    const f=fixture(engine);assert.equal(f.states[0].supported,false);
    assert.equal(f.settings.choose('mpv_software'),false);assert.deepEqual(f.writes,[]);
  }
  const states=[];create({render:s=>states.push(s)});assert.equal(states[0].supported,false);
});
test('selection is saved through native preferences and survives recreating the settings controller',()=>{
  const f=fixture();assert.equal(f.states[0].mode,'mpv_auto');
  assert.equal(f.settings.choose('mpv_software'),true);
  assert.match(f.states.at(-1).message,/下次播放或切集/);
  const restored=[];create({bridge:f.bridge,render:s=>restored.push(s)});
  assert.equal(restored[0].mode,'mpv_software');
  assert.equal(f.settings.choose('mpv_auto'),true);
  assert.deepEqual(f.writes,['mpv_software','mpv_auto']);
  assert.equal(f.settings.choose('mediacodec'),false);
});
test('a rejected or unavailable preference does not report successful saving',()=>{
  const f=fixture();f.bridge.setDecoderMode=()=>{};
  assert.equal(f.settings.choose('mpv_software'),false);
  assert.equal(f.states.at(-1).mode,'mpv_auto');assert.match(f.states.at(-1).message,/未能保存/);
  f.bridge.setDecoderMode=()=>{throw Error('bridge disconnected')};
  assert.equal(f.settings.choose('mpv_software'),false);
});

function hevcFixture(engine='webview_media3', supported=true, initial=false) {
  let stored=initial;const writes=[],states=[];
  const bridge={engine:()=>engine,supportsHardwareHevcPreference:()=>supported,
    hardwareHevcPreferred:()=>stored,setHardwareHevcPreferred:value=>{stored=value;writes.push(value)},
    setDecoderMode:()=>{throw Error('legacy compatibility mode must be preserved')},
    play:()=>{throw Error('settings must not interrupt playback')},stop:()=>{throw Error('settings must not stop playback')}};
  return {bridge,writes,states,settings:createHardwareHevc({bridge,render:s=>states.push(s)})};
}
test('HEVC hardware choice is opt-in and restricted to a capable standard Android bridge',()=>{
  const f=hevcFixture();assert.equal(f.states[0].supported,true);assert.equal(f.states[0].mode,'standard');assert.deepEqual(f.writes,[]);
  for(const engine of ['mpv','media3','desktop','']) {
    const other=hevcFixture(engine);assert.equal(other.states[0].supported,false);
    assert.equal(other.settings.choose('hardware'),false);assert.deepEqual(other.writes,[]);
  }
  const unsupported=hevcFixture('webview_media3',false);
  assert.equal(unsupported.states[0].supported,false);assert.equal(unsupported.settings.choose('hardware'),false);
  const states=[];createHardwareHevc({bridge:{engine:()=> 'webview_media3'},render:s=>states.push(s)});
  assert.equal(states[0].supported,false,'old APK bridges do not expose the setting');
});
test('HEVC preference persists and can be restored without changing legacy modes or active playback',()=>{
  const f=hevcFixture();assert.equal(f.settings.choose('hardware'),true);
  assert.equal(f.states.at(-1).mode,'hardware');assert.match(f.states.at(-1).message,/下次播放或切集/);
  const restored=[];createHardwareHevc({bridge:f.bridge,render:s=>restored.push(s)});
  assert.equal(restored[0].mode,'hardware');
  assert.equal(f.settings.choose('standard'),true);assert.deepEqual(f.writes,[true,false]);
  assert.equal(f.states.at(-1).mode,'standard');assert.equal(f.settings.choose('mpv_software'),false);
});
test('HEVC settings do not report success when the native preference write is rejected',()=>{
  const f=hevcFixture();f.bridge.setHardwareHevcPreferred=()=>{};
  assert.equal(f.settings.choose('hardware'),false);assert.equal(f.states.at(-1).mode,'standard');
  assert.match(f.states.at(-1).message,/未能保存/);
  f.bridge.setHardwareHevcPreferred=()=>{throw Error('bridge unavailable')};assert.equal(f.settings.choose('hardware'),false);
});
