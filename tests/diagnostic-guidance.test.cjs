'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const diagnostics = require('../core/cmd/hongguotv/ui/playback-diagnostics');
const recovery = require('../core/cmd/hongguotv/ui/playback-recovery');
const classify = require('../webos/service/network-diagnostic');
function failed(preparationError, extra={}) {
  return diagnostics.report({flags:{failed:true}, preparationError, ...extra}).guidance;
}

test('connection guidance distinguishes typed causes without exposing private error text',()=>{
  for(const [reason,category,advice] of [['dns','dns',/DNS/],['tls','tls',/日期/],['timeout','timeout',/热点/],['refused','connection',/热点/],['reset','connection',/热点/],['unreachable','connection',/热点/]]) {
    const g=failed({code:'DEVICE_REGISTER_FAILED',stage:'device_register',network_reason:reason,message:'https://private.test?token=secret'});
    assert.equal(g.category,category); assert.equal(g.state,'attention');
    assert.match(g.suggestions.join(' '),advice); assert.match(g.evidence.join(' '),/注册.*HTTP 状态未取得/);
    assert.doesNotMatch(JSON.stringify(g),/private|secret|502|解码/);
  }
  const unknown=failed({code:'DEVICE_REGISTER_FAILED',stage:'device_register',elapsed_ms:4});
  assert.equal(unknown.category,'registration');
  assert.doesNotMatch(unknown.title,/DNS|断网|超时/,'missing HTTP metadata cannot establish a transport cause');
});

test('empty model, rate limiting, HTTP rejection and source selection have different advice',()=>{
  for(const [code,http_status,category] of [['VIDEO_MODEL_EMPTY',200,'empty'],['VIDEO_TAB_EMPTY',200,'empty'],['VIDEO_MODEL_HTTP',429,'rateLimited'],['VIDEO_MODEL_HTTP',403,'rejected'],['VIDEO_MODEL_HTTP',503,'server'],['VIDEO_MODEL_NO_QUALITY',200,'noQuality']]) {
    const g=failed({code,stage:'multi_video_model',http_status,response_bytes:0});
    assert.equal(g.category,category); assert.match(g.evidence.join(' '),new RegExp('HTTP '+http_status));
    assert.doesNotMatch(g.suggestions.join(' '),/软件解码|重新登录|清空数据/);
  }
  assert.equal(failed({code:'MEDIA_CACHE_WRITE_FAILED',stage:'cache_write'}).category,'storage');
  assert.equal(failed({code:'MEDIA_DECRYPT_FAILED',stage:'media_decrypt'}).category,'decrypt');
});

test('recovered playback and held previous-source errors do not retain failure advice',()=>{
  const preparationError={code:'VIDEO_MODEL_EMPTY',stage:'multi_video_model'};
  const video={ready:4,width:720,height:1280,buffered:8,volume:1};
  let g=diagnostics.report({flags:{source:true},video,preparationError,
    playbackRoute:{active_path:'HTML5'},native:{error_kind:'decoder',track_support:'FORMAT_EXCEEDS_CAPABILITIES'}}).guidance;
  assert.equal(g.category,'ready'); assert.equal(g.state,'ok');
  assert.doesNotMatch(g.title,/空|解码/);
  g=diagnostics.report({flags:{preparing:true,source:true},video:{error:3},native:{error_kind:'decoder'},preparationError}).guidance;
  assert.equal(g.category,'preparing');
  g=diagnostics.report({flags:{preparing:true,failed:true,source:true},video:{error:3}}).guidance;
  assert.equal(g.category,'decode','a confirmed current failure must override a loading guard that remains visible');
  g=diagnostics.report({flags:{source:true},video,core:{unavailable:true,media_http_status:416}}).guidance;
  assert.equal(g.category,'ready','an incomplete diagnostic read or previous range status does not prove playback failure');
});

test('native decoder advice is offered only on the current path with an available mode',()=>{
  function guide(native) { return diagnostics.report({flags:{failed:true,source:true},native}).guidance; }
  assert.match(guide({engine:'mpv',error_kind:'decoder',mode:'mpv_auto',hwdec_current:'mediacodec-copy'}).suggestions.join(' '),/MPV 软件解码/);
  for(const native of [{error_kind:'decoder'}, {engine:'mpv',error_kind:'decoder',mode:'mpv_software'}, {engine:'mpv',error_kind:'decoder',hwdec_current:'no'}])
    assert.doesNotMatch(guide(native).suggestions.join(' '),/MPV 软件解码/);
  assert.equal(diagnostics.report({flags:{source:true},native:{engine:'mpv',output_ready:true,state:'playing',track_support:'FORMAT_EXCEEDS_CAPABILITIES'}}).guidance.category,'ready');
});

test('diagnostic read failures and buffering do not fabricate an internet outage',()=>{
  const partial=diagnostics.report({core:{unavailable:true}}).guidance;
  assert.equal(partial.category,'incomplete'); assert.equal(partial.state,'unknown');
  const buffering=diagnostics.report({flags:{source:true,waiting:true},video:{buffered:0}}).guidance;
  assert.equal(buffering.category,'buffering'); assert.equal(buffering.state,'pending');
  assert.match(buffering.evidence.join(' '),/不能确定网络速度/);
  const local=diagnostics.report({flags:{failed:true,source:true},core:{media_http_status:502},video:{error:2}}).guidance;
  assert.equal(local.category,'localMedia'); assert.match(local.evidence.join(' '),/不代表上游/);
});

test('webOS transport metadata passes the same privacy allowlist, including official video_tab',()=>{
  for(const [code,reason] of [['ENOTFOUND','dns'],['CERT_HAS_EXPIRED','tls'],['UPSTREAM_TIMEOUT','timeout'],['ECONNRESET','reset'],['ECONNREFUSED','refused']]) {
    assert.equal(classify({code,message:'secret'}),reason);
    const safe=recovery.preparationFailure({code,stage:'video_tab',videoModel:{network_reason:reason,url:'https://private',message:'secret'}});
    assert.deepEqual(safe,{code,stage:'video_tab',network_reason:reason});
    assert.notEqual(failed(safe).category,'unknownFailure');
  }
  assert.equal(classify({code:'UNKNOWN',message:'DNS error https://secret'}),'');
  assert.equal(recovery.preparationFailure({code:'DEVICE_REGISTER_FAILED',stage:'device_register',preparation:{network_reason:'https://private'}}).network_reason,undefined);
});

test('rendering refresh replaces all three guidance sections and preserves scroll and focus',()=>{
  const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
  const render=source.match(/  function renderPlaybackDiagnostics\(snapshot\) \{[\s\S]*?\n  \}/)[0];
  function element() {return {children:[],className:'',textContent:'',scrollTop:210,appendChild(child){this.children.push(child);},set innerHTML(value){this.children=[];}};}
  const nodes={}; const document={activeElement:{id:'player-diagnostics-refresh'},getElementById(id){return nodes[id]||(nodes[id]=element());},createElement:element};
  const c={document,window:{HongguoPlaybackDiagnostics:diagnostics},uiText:key=>key,diagnosticFallbackReport:()=>({summary:'fallback',rows:[{}]})};
  vm.runInNewContext(render,c);
  c.renderPlaybackDiagnostics({flags:{failed:true},preparationError:{code:'VIDEO_MODEL_EMPTY',stage:'multi_video_model'}});
  assert.equal(nodes['player-diagnostics-suggestions'].children.length,2);
  assert.match(nodes['player-diagnostics-summary'].textContent,/未返回播放信息/);
  c.renderPlaybackDiagnostics({flags:{source:true},video:{ready:4,width:720,height:1280}});
  assert.equal(nodes['player-diagnostics-guidance'].className,'diagnostic-guidance is-ok');
  assert.equal(nodes['player-diagnostics-suggestions'].children.length,1);
  assert.doesNotMatch(nodes['player-diagnostics-evidence'].children.map(x=>x.textContent).join(' '),/HTTP|失败/);
  assert.equal(nodes['player-diagnostics-scroll'].scrollTop,210);assert.equal(document.activeElement.id,'player-diagnostics-refresh');
});
