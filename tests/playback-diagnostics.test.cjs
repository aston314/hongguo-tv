const {test} = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../core/cmd/hongguotv/ui/playback-diagnostics.js');
test('MPV reports actual decoding separately from preference, including software fallback and signed A/V difference',()=>{
  function rows(native){return Object.fromEntries(diagnostics.report(snapshot({native:{engine:'mpv',state:'playing',...native}})).rows.map(x=>[x.label,x.value]));}
  const hw=rows({mode:'mpv_auto',hwdec_current:'mediacodec-copy',decoder_frame_drop_count:2,frame_drop_count:0,demuxer_cache_duration:12.8,avsync:-0.032});
  assert.match(hw['MPV 解码'],/自动解码.*实际：mediacodec-copy/);
  assert.equal(hw['MPV 掉帧'],'解码 2 · 渲染 0');assert.equal(hw['MPV 音画差值'],'-32 ms');
  assert.equal(hw['MPV 缓存时长'],'0:12');
  assert.match(rows({mode:'mpv_auto',hwdec_current:'no'})['MPV 解码'],/自动解码.*实际：软件解码/);
  const unknown=rows({mode:'mpv_software'});
  assert.match(unknown['MPV 解码'],/实际：未取得/);
  assert.equal(unknown['MPV 掉帧'],'解码 未取得 · 渲染 未取得');assert.equal(unknown['MPV 音画差值'],undefined);
  assert.equal(unknown['MPV 缓存时长'],undefined);
});
function video(values={}) { return Object.assign({currentTime:8,duration:90,videoWidth:720,videoHeight:1280,readyState:4,networkState:1,paused:false,ended:false,seeking:false,muted:true,volume:1,buffered:{length:1,start:()=>0,end:()=>20},error:null},values); }
function snapshot(values={}) { return Object.assign({video:diagnostics.readVideo(video()),flags:{preparing:true,audioHeld:true,source:true},episode:8,quality:'720P',userAgent:'Mozilla/5.0 Chrome/44.0.2403.119 HongguoTV-Android',capturedAt:'12:34:56',device:{app_version:'0.2.31',version_code:33,manufacturer:'TV maker',model:'TV-9',android_version:'9',sdk:28,process_bits:32},core:{version:'0.2.31-aabbccddeeff00112233445566778899aabbccdd',arch:'arm'}},values); }
test('HTML5 reports its current result without old Media3 capability, decoder, or network warnings',()=>{
  for(const native of [
    {state:'error',track_support:'FORMAT_EXCEEDS_CAPABILITIES',video_track:'old HEVC'},
    {state:'error',track_support:'FORMAT_UNSUPPORTED_SUBTYPE'},
    {state:'error',error_kind:'decoder',error_code:4003},
    {state:'error',error_kind:'network',error_code:2001}
  ]) {
    for(const [flags,error,expected] of [
      [{source:true},null,/保护已解除/],
      [{failed:true},null,/播放未能完成准备/],
      [{source:true},{code:3},/解码错误/]
    ]) {
      const s=snapshot({native,flags,video:diagnostics.readVideo(video({error})),playbackRoute:{active_path:'HTML5',outcome:'html5_retry'}});
      const report=diagnostics.report(s),rows=Object.fromEntries(report.rows.map(x=>[x.label,x.value]));
      assert.match(report.summary,expected);
      assert.equal(rows.Media3,undefined); assert.equal(rows['视频轨道'],undefined);
      assert.doesNotMatch(rows['最近错误'],/Media3/);
    }
  }
  const current=diagnostics.report(snapshot({native:{track_support:'FORMAT_EXCEEDS_CAPABILITIES'},playbackRoute:{active_path:'Media3'}}));
  assert.match(current.summary,/当前视频轨道超过设备/,'current native track warning remains visible');
});
test('captures a frozen media snapshot without requiring frame APIs on old WebViews',()=>{
  const v=video(); const s=diagnostics.readVideo(v);v.currentTime=40;v.muted=false;
  assert.equal(s.position,8);assert.equal(s.muted,true);assert.equal(s.buffered,12);assert.equal(s.decoded,null);
  assert.doesNotThrow(()=>diagnostics.readVideo(video({buffered:{get length(){throw Error('unavailable')}},getVideoPlaybackQuality(){throw Error('unavailable')}})));
});
test('keeps a useful report when an old WebView has no video snapshot yet',()=>{
  const report=diagnostics.report({capturedAt:'12:34:56',episode:1,flags:{preparing:true}});
  assert.match(report.summary,/加载层仍显示|尚未设置视频源/);
  assert.ok(report.rows.length > 5);
  assert.ok(report.rows.some(row=>row.label==='视频画面'));
});
test('distinguishes missing video dimensions from a still-active loading guard and a released guard',()=>{
  const missing=snapshot({video:diagnostics.readVideo(video({videoWidth:0,videoHeight:0}))});
  assert.match(diagnostics.report(missing).summary,/尚未报告有效画面尺寸/);
  assert.match(diagnostics.report(snapshot()).summary,/尺寸已取得.*尚未解除/);
  assert.match(diagnostics.report(snapshot({flags:{source:true,videoVisible:true}})).summary,/保护已解除/);
  assert.match(diagnostics.report(snapshot({video:diagnostics.readVideo(video({error:{code:3}}))})).summary,/解码错误/);
});
test('reports running process bits independently of the OS supported ABIs and falls back to real UA engine version',()=>{
  const s=snapshot();s.device.supported_abis='arm64-v8a, armeabi-v7a';
  const r=diagnostics.report(s), rows=Object.fromEntries(r.rows.map(x=>[x.label,x.value]));
  assert.match(rows['系统 / 架构'],/32 位 \/ arm/);assert.doesNotMatch(rows['系统 / 架构'],/64 位/);
  assert.equal(rows['WebView'],'Chromium 44.0.2403.119（浏览器标识）');
  s.device.webview_version='83.0.4103.106';assert.match(diagnostics.report(s).rows.find(x=>x.label==='WebView').value,/83\.0\.4103\.106/);
});
test('never includes source URLs, account credentials, raw error messages or native identity fields',()=>{
  const s=snapshot();const secret='https://media.invalid/a.mp4?Cookie=secret&key=private';
  s.video.error={code:2,message:secret};s.video.currentSrc=secret;s.device.phone='13800000000';s.device.serial='unique-device';s.core.path=secret;s.core.error=secret;s.core.token='secret';
  const output=JSON.stringify(diagnostics.report(s));
  for(const value of [secret,'13800000000','unique-device','private','Cookie'])assert.equal(output.includes(value),false);
});
test('shows current-source HTTP failures, buffer amount and audio protection without exposing errors from another source',()=>{
  const s=snapshot();s.core.media_http_status=416;s.core.media_age_seconds=2;s.core.media_prepared=true;s.core.media_bytes=10485760;
  const rows=Object.fromEntries(diagnostics.report(s).rows.map(x=>[x.label,x.value]));
  assert.match(rows['本次请求'],/MP4 就绪 10.0 MB.*HTTP 416/);
  assert.equal(rows['最近错误'],'本机媒体 HTTP 416');assert.match(rows['声音状态'],/临时静音保护/);
  assert.match(rows['播放时钟'],/0:08 \/ 1:30.*12 秒/);
  s.core={unavailable:true};assert.match(diagnostics.report(s).rows.find(x=>x.label==='本次请求').value,/诊断读取失败/);
});
test('reports native decoder failures and codec state without exposing media URLs',()=>{
  const s=snapshot({native:{state:'error',surface:'TextureView',first_frame:false,video_mime:'video/hevc',error_kind:'decoder',error_code:4003}});
  const report=diagnostics.report(s),rows=Object.fromEntries(report.rows.map(x=>[x.label,x.value]));
  assert.match(report.summary,/Media3.*HEVC/);
  assert.match(rows.Media3,/video\/hevc.*decoder 4003.*未出首帧/);
  assert.match(rows['最近错误'],/Media3 decoder（4003）/);
  s.native.url='https://media.invalid/a.mp4?key=secret';
  assert.doesNotMatch(JSON.stringify(diagnostics.report(s)),/media\.invalid|secret/);
});
test('reports native track support separately from decoder and first-frame state',()=>{
  const s=snapshot({native:{state:'preparing',surface:'SurfaceView',first_frame:false,video_decoder:'OMX.vendor.hevc.decoder',video_mime:'video/hevc',video_track:'video/hevc [hvc1.2.4.L150.B0] · 1920x1080 · 25fps',track_support:'FORMAT_HANDLED',track_selected:'是',unselected_hevc:'1280x720=FORMAT_EXCEEDS_CAPABILITIES'}});
  const rows=Object.fromEntries(diagnostics.report(s).rows.map(x=>[x.label,x.value]));
  assert.match(rows['视频轨道'],/video\/hevc.*FORMAT_HANDLED.*已选择/);
  assert.match(rows['未选 HEVC'],/1280x720.*FORMAT_EXCEEDS_CAPABILITIES/);
  assert.match(diagnostics.report(snapshot({native:{track_support:'FORMAT_UNSUPPORTED_SUBTYPE'}})).summary,/没有接受当前视频轨道/);
});
test('MPV reports actual audio output and native surface independently of the hidden HTML video',()=>{
  const s=snapshot({flags:{source:true,videoVisible:false},native:{engine:'mpv',state:'playing',surface:'SurfaceView',output_ready:true,
    restart_seen:true,vo_configured:true,video_output:'gpu',surface_width:1280,surface_height:720,surface_attached:true,surface_visible:true,
    audio_output:'opensles',audio_codec:'aac',audio_format:'s16',audio_rate:48000,audio_channels:2,actual_mute:true,actual_volume:100,actual_pause:false,
    output_messages:'音频输出警告'}});
  s.video.muted=false;
  const rows=Object.fromEntries(diagnostics.report(s).rows.map(x=>[x.label,x.value]));
  assert.match(rows.MPV,/输出已就绪/);assert.doesNotMatch(rows.MPV,/已出首帧/);
  assert.match(rows['MPV 视频输出'],/gpu.*1280 × 720.*重启信号/);
  assert.match(rows['MPV 音频输出'],/opensles.*aac.*s16.*48000 Hz.*2 声道/);
  assert.match(rows['MPV 实际状态'],/已静音.*100%.*运行中/);
  assert.match(rows['声音状态'],/已解除静音/);
  assert.match(rows['画面保护'],/原生视频层已显示/);assert.doesNotMatch(rows['画面保护'],/视频隐藏/);
  assert.equal(rows['MPV 输出提示'],'音频输出警告');
});
test('MPV diagnostics retain signed native errors and do not invent output state from a legacy restart',()=>{
  const s=snapshot({native:{engine:'mpv',state:'error',first_frame:true,frame_signal:'playback-restart',error_kind:'media',error_code:-13}});
  const rows=Object.fromEntries(diagnostics.report(s).rows.map(x=>[x.label,x.value]));
  assert.match(rows.MPV,/输出待确认/);assert.doesNotMatch(rows.MPV,/已出首帧/);
  assert.match(rows['最近错误'],/media（-13）/);assert.match(rows['MPV 实际状态'],/状态未取得/);
  s.native.log='https://media.invalid/a.mp4?key=secret';
  assert.doesNotMatch(JSON.stringify(diagnostics.report(s)),/media\.invalid|secret/);
});
test('MPV diagnostics show signed actual audio offset and omit missing or invalid values',()=>{
  for(const delay of [-100,0,100]){
    const s=snapshot({native:{engine:'mpv',state:'playing',audio_delay_ms:delay}});
    const row=diagnostics.report(s).rows.find(row=>row.label==='MPV 音频输出');
    assert.ok(row.value.includes('音频偏移 '+(delay>0?'+':'')+delay+' ms'));
  }
  for(const delay of [undefined,NaN,Infinity,'100']){
    const s=snapshot({native:{engine:'mpv',state:'playing',audio_delay_ms:delay}});
    assert.doesNotMatch(diagnostics.report(s).rows.find(row=>row.label==='MPV 音频输出').value,/音频偏移/);
  }
});
test('MPV diagnostics expose file-open and END_FILE stages without source details',()=>{
  const s=snapshot({native:{engine:'mpv',state:'error',open_requested:true,file_loaded:false,end_file_seen:true,end_file_reason:4,end_file_error:-13,error_kind:'media',error_code:-13}});
  const rows=Object.fromEntries(diagnostics.report(s).rows.map(x=>[x.label,x.value]));
  assert.match(rows['MPV 加载阶段'],/已请求打开.*FILE_LOADED 未收到.*END_FILE reason=4 error=-13/);
  assert.match(rows['最近错误'],/MPV media（-13）/);
  s.native.source='https://media.invalid/a.mp4?key=secret';
  assert.doesNotMatch(JSON.stringify(diagnostics.report(s)),/media\.invalid|secret/);
});
test('playback diagnostics show split episode transition timings',()=>{
  const s=snapshot({timing:{prefetch_ms:2200,handoff_wait_ms:1200,source_ready_ms:5000,native_frame_ms:1300,native_stop_fence_ms:80,total_ms:6300}});
  const rows=Object.fromEntries(diagnostics.report(s).rows.map(x=>[x.label,x.value]));
  assert.match(rows['切集耗时'],/预取 2200ms/);assert.match(rows['切集耗时'],/源就绪 5000ms/);assert.match(rows['切集耗时'],/总计 6300ms/);
  const mpv=snapshot({native:{engine:'mpv',last_stop_fence_ms:80,load_to_file_loaded_ms:500,load_to_output_ready_ms:900}});
  const mpvRows=Object.fromEntries(diagnostics.report(mpv).rows.map(x=>[x.label,x.value]));
  assert.match(mpvRows['MPV 切源耗时'],/停止边界 80ms.*FILE_LOADED 500ms.*输出就绪 900ms/);
});
test('webOS exposes preparation timings before a source exists and includes Range fallback costs',()=>{
  const failed=snapshot({flags:{rangeRequested:true,preparing:true},core:{media_prepared:false,media_mode:'range',media_preparation_stage:'failed',media_resolve_ms:6000}});
  let rows=Object.fromEntries(diagnostics.report(failed).rows.map(x=>[x.label,x.value]));
  assert.match(rows['媒体准备耗时'],/接口解析 6000ms.*Range索引 未取得/);
  assert.doesNotMatch(rows['读取模式'],/当前源/,'a pending mode is not reported as an attached source');
  const fallback=snapshot({flags:{rangeRequested:true},core:{media_prepared:true,media_mode:'full',media_preparation_stage:'ready',media_range_fallback:'上游未支持 Range (HTTP 200)',media_resolve_ms:100,media_range_init_ms:200,media_download_ms:300,media_decrypt_ms:20}});
  rows=Object.fromEntries(diagnostics.report(fallback).rows.map(x=>[x.label,x.value]));
  assert.match(rows['媒体准备耗时'],/Range索引 200ms.*下载 300ms.*解密 20ms/);
  assert.match(rows['读取模式'],/full/);
  assert(Object.values(rows).some(value=>/上游未支持 Range/.test(value)));
  fallback.core.media_range_fallback='request failed https://media.invalid/episode.mp4?key=secret';
  assert.doesNotMatch(JSON.stringify(diagnostics.report(fallback)),/media\.invalid|secret/);
});

test('playback diagnostics report local route choice, switch reason, first frame and stage timings without source data',()=>{
  const s=snapshot({playbackRoute:{
    webview_version:'122.0.6261.94',preferred_path:'HTML5',active_path:'Media3',final_path:'Media3',
    switched:true,switch_reason:'decode_error',outcome:'first_frame',metadata_ms:340,zero_progress_wait_ms:null,
    zero_progress_ms:null,switch_ms:980,first_frame_ms:2310,first_frame_wait_ms:1330,
    media3_first_frame_ms:1330,media3_wait_ms:null,final_first_frame:true,cache_written:true,
    source:'https://media.invalid/video.mp4?token=private'
  }});
  const report=diagnostics.report(s),rows=Object.fromEntries(report.rows.map(x=>[x.label,x.value]));
  assert.match(rows['播放器路径'],/首选 HTML5.*当前 Media3.*最终 Media3.*自动切换 是.*decode_error.*首帧 已出首帧/);
  assert.match(rows['播放器阶段耗时'],/元数据 340ms.*切换 980ms.*首帧 2310ms.*Media3 首帧 1330ms/);
  assert.equal(report.rows.find(row=>row.label==='播放器路径').wide,true);
  assert.doesNotMatch(JSON.stringify(report),/media\.invalid|private/);

  const waiting=snapshot({playbackRoute:{preferred_path:'HTML5',active_path:'HTML5',outcome:'preparing',
    first_frame_ms:null,first_frame_wait_ms:2200,media3_first_frame_ms:null,media3_wait_ms:null}});
  const waitingRows=Object.fromEntries(diagnostics.report(waiting).rows.map(x=>[x.label,x.value]));
  assert.match(waitingRows['播放器阶段耗时'],/首帧 2200ms/);
});
