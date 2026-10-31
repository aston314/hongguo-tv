const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {uiText,apiError}=require('./helpers/app-text.cjs');
const recovery=require('../core/cmd/hongguotv/ui/playback-recovery');
const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
const fn=name=>source.match(new RegExp('  function '+name+'\\([^]*?\\n  \\}'))[0];

test('production fetchData carries Go error metadata separately from the local gateway status',async()=>{
  const data={ok:false,error:'VIDEO_MODEL_EMPTY',stage:'multi_video_model',preparation:{http_status:200,response_bytes:0,attempt:6}};
  const c={apiError,fetch:async()=>({ok:false,status:502,json:async()=>data})};vm.runInNewContext(fn('fetchData'),c);
  await assert.rejects(c.fetchData('/api/v1/play/info'),error=>{
    assert.equal(error.status,502);assert.equal(error.code,data.error);assert.equal(error.stage,data.stage);
    assert.equal(error.upstreamStatus,0,'never substitute local 502 for upstream');
    assert.deepEqual(recovery.preparationFailure(error),{code:data.error,stage:data.stage,http_status:200,response_bytes:0,attempt:6});return true;
  });
});

test('runtime Range fallback exposes a failed full preparation but ignores aborted and superseded requests',async()=>{
  for(const outcome of ['failure','abort','episode','account']) {
    const error=Object.assign(new Error('private URL'),{code:'MEDIA_DECRYPT_FAILED',stage:'media_decrypt',preparation:{elapsed_ms:30}});
    if(outcome==='abort')error.name='AbortError';
    let reject;
    const states=[];
    const playback={mode:'range',episode:2,generation:1,owner:1,item:{series_id:'123'},vid:'456',position:0};
    const video={currentTime:0,pause(){}};
    const c={uiText,URLSearchParams,AbortController,Promise,window:{HongguoPlaybackRecovery:recovery},
      webosShell:false,activePlayback:playback,feedGeneration:1,accountEpoch:1,playbackInfoRequest:null,playbackPreferences:{quality:''},
      document:{getElementById:id=>id==='hero-video'?video:{classList:{add(){},remove(){}}}},
      clearRangeStallTimer(){},saveProgress(){},holdPlaybackAudio(){},episodeLoadingText:()=> 'loading',
      setPlayerStatus:(message,failed)=>states.push({message,failed}),waitForPlaybackPaint:()=>Promise.resolve(true),
      fetchData:()=>new Promise((_,r)=>{reject=r;})};
    vm.runInNewContext(fn('preparationFailureMessage')+'\n'+fn('fallbackRangePlayback'),c);
    assert.equal(c.fallbackRangePlayback(playback),true);
    if(outcome==='episode') { c.activePlayback={};c.feedGeneration++; }
    if(outcome==='account') { c.accountEpoch++;c.activePlayback=null;c.feedGeneration++; }
    reject(error);await new Promise(r=>setImmediate(r));
    if(outcome==='failure') {
      assert.equal(playback.preparationError.code,'MEDIA_DECRYPT_FAILED');
      assert.match(states.at(-1).message,/视频准备失败.*MEDIA_DECRYPT_FAILED/);
      assert.equal(states.at(-1).failed,true);
    } else {
      assert.equal(playback.preparationError,undefined);assert.equal(states.some(s=>s.failed),false);
    }
  }
});
