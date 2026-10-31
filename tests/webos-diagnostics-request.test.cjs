const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
const refresh = source.match(/  function refreshPlaybackDiagnostics\(\) \{[\s\S]*?\n  \}/)[0];
const currentDiagnostics = source.match(/  function readCurrentPlaybackDiagnostics\(video\) \{[\s\S]*?\n  \}/)[0];
const media = '/minireel-proxy/media/0123456789abcdef01234567.mp4';

function fixture({webos=true,preparing=false,mode='range',src='http://127.0.0.1:7655'+media}={}) {
  const calls=[],reports=[];
  const video={getAttribute:()=>src};
  const context={
    playerOptionsOpen:true,diagnosticEpoch:1,diagnosticRequest:null,desktopShell:false,
    activePlayback:{episode:2,mode,generation:1,owner:1,presentation:{source:src}},feedGeneration:1,accountEpoch:1,
    samePlaybackPresentationSource:(actual,expected)=>actual===expected,
    playbackRequest:null,playbackQuality:'',playbackTiming:[],playbackInfoRequest:preparing?{}:null,playbackAudioHold:null,
    applicationInBackground:false,applicationHidden:()=>false,rangePlaybackEnabled:()=>true,
    cancelDiagnosticRead(){this.diagnosticEpoch++;},readDiagnosticEnvironment:()=>({rows:[],userAgent:''}),readDiagnosticVideo:()=>({}),renderPlaybackDiagnostics(snapshot){reports.push(snapshot);},
    window:webos?{HongguoWebOS:{mediaPath:()=>media}}:{},
    document:{querySelector:()=>video,getElementById:id=>id==='hero-video'?video:{classList:{contains:name=>name==='is-diagnostics'||name==='is-hidden'||name==='is-preparing-video'&&preparing}}},
    XMLHttpRequest:class {open(method,url){calls.push({method,url});}send(){}}
  };
  vm.runInNewContext(currentDiagnostics+'\n'+refresh+'\nrefreshPlaybackDiagnostics();',context);
  return {context,calls,reports};
}

function request(options) {
  const {calls}=fixture(options);
  assert.equal(calls.length,1,'diagnostics sends one local read and never resolves or fetches media');
  assert.equal(calls[0].method,'GET');
  return new URL(calls[0].url,'http://local.test').searchParams.get('media');
}

test('webOS preparation reads the current job even when the previous episode src is held',()=>{
  assert.equal(request({preparing:true,mode:''}),'');
});

test('delayed diagnostics cannot restore an old native warning after episode, account, source or player changes',()=>{
  for(const change of ['episode','account','source','player']) {
    const f=fixture({webos:false,src:media});
    let native={diagnostic_id:'old',error_kind:'decoder',error_code:4003};
    let route={active_path:'Media3'};
    f.context.window.HongguoNativePlaybackAdapter={nativeDiagnostics:()=>native,diagnostics:()=>route};
    f.context.refreshPlaybackDiagnostics();
    const oldRequest=f.context.diagnosticRequest;
    const before=f.reports.length;
    if(change==='episode') { f.context.feedGeneration++;f.context.activePlayback=null; }
    if(change==='account') f.context.accountEpoch++;
    if(change==='source') f.context.activePlayback.presentation={source:media};
    if(change==='player') { native={};route={active_path:'HTML5'}; }
    oldRequest.status=200;oldRequest.responseText=JSON.stringify({ok:true,data:{media_http_status:416}});
    oldRequest.onload();
    assert.equal(f.reports.length,before+1,'one fresh synchronous report replaces the delayed result');
    assert.equal(f.reports.at(-1).core,undefined,'old HTTP result never enters the new report');
    assert.notEqual(f.context.diagnosticRequest,oldRequest,'refresh requests the current core snapshot');
    if(change!=='source') assert.equal(f.reports.at(-1).native.error_kind,undefined);
    oldRequest.onload();
    assert.equal(f.reports.length,before+1,'repeated old callback cannot overwrite the new request');
  }
});
test('webOS attached playback reads the exact normalized media path',()=>{
  assert.equal(request(),media);
});
test('other platforms retain their existing source-specific diagnostic request',()=>{
  assert.equal(request({webos:false,preparing:true,mode:'',src:media}),media);
});

test('diagnostics read only the attached current source, including native errors and background state',()=>{
  let nativeReads=0,routeReads=0;
  const video={getAttribute:()=>media};
  const c={window:{HongguoNativePlaybackAdapter:{
    nativeDiagnostics(){nativeReads++;return {error_kind:'decoder',error_code:4003};},
    diagnostics(){routeReads++;return {active_path:'Media3'};}
  }},activePlayback:null,feedGeneration:2,accountEpoch:3,
    samePlaybackPresentationSource:(a,b)=>a===b};
  vm.runInNewContext(currentDiagnostics,c);
  for(const playback of [null,
    {generation:2,owner:3},
    {generation:1,owner:3,presentation:{source:media}},
    {generation:2,owner:2,presentation:{source:media}},
    {generation:2,owner:3,presentation:{source:media+'-old'}}]) {
    c.activePlayback=playback;
    assert.equal(Object.keys(c.readCurrentPlaybackDiagnostics(video).native).length,0);
    assert.equal(c.readCurrentPlaybackDiagnostics(video).route,null);
  }
  assert.equal(nativeReads,0);assert.equal(routeReads,0);
  c.activePlayback={generation:2,owner:3,presentation:{source:media,failed:true}};
  assert.equal(c.readCurrentPlaybackDiagnostics(video).native.error_code,4003);
  assert.equal(c.readCurrentPlaybackDiagnostics(video).route.active_path,'Media3');
});

test('webOS live audio diagnostics remain available without importing native decoder warnings',()=>{
  const c={window:{HongguoWebOS:{},HongguoNativePlayer:{diagnostics:()=>JSON.stringify({
    webos_audio:{phase:'playing',requested_rate:1.25},track_support:'FORMAT_EXCEEDS_CAPABILITIES'
  })}},activePlayback:null,feedGeneration:2,accountEpoch:3};
  vm.runInNewContext(currentDiagnostics,c);
  const report=c.readCurrentPlaybackDiagnostics({getAttribute:()=>media});
  assert.equal(report.native.webos_audio.phase,'playing');
  assert.equal(report.native.track_support,undefined);
});
