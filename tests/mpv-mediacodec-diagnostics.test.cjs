const {test} = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../core/cmd/hongguotv/ui/playback-diagnostics.js');

test('MPV diagnostics distinguish MediaFormat reports from FFmpeg fallback values', () => {
  const report = diagnostics.report({
    video: {position:0,duration:60,width:1924,height:1080,ready:4,network:1,paused:false,ended:false,seeking:false,muted:false,volume:1,buffered:0,error:0,decoded:null},
    native: {
      engine:'mpv',state:'playing',surface:'SurfaceView',output_ready:true,
      coded_width:1924,coded_height:1080,width:1924,height:1080,
      mediacodec_format_seen:true,mediacodec_decoder_known:true,mediacodec_decoder_family:3,
      mediacodec_width_reported:true,mediacodec_width:1924,
      mediacodec_height_reported:true,mediacodec_height:1080,
      mediacodec_stride_reported:false,mediacodec_stride_fallback_available:true,mediacodec_stride_ffmpeg_fallback:1924,
      mediacodec_slice_height_reported:false,mediacodec_slice_height_fallback_available:true,mediacodec_slice_height_ffmpeg_fallback:1080,
      mediacodec_color_format_reported:true,mediacodec_color_format:21,
      mediacodec_crop_available:true,mediacodec_crop_top:0,mediacodec_crop_bottom:1079,
      mediacodec_crop_left:0,mediacodec_crop_right:1923,mediacodec_display_width:1924,mediacodec_display_height:1080
    }
  });
  const layout = report.rows.find(row => row.label === 'MediaCodec 输出格式');
  const buffers = report.rows.find(row => row.label === 'MediaCodec 缓冲布局');
  assert.match(layout.value, /1924 × 1080/);
  const dimensions = report.rows.find(row => row.label === 'MPV 解码 / 显示尺寸');
  assert.match(dimensions.value, /解码 1924 × 1080 · 显示 1924 × 1080/);
  assert.match(buffers.value, /设备未报告，FFmpeg 回退 1924/);
  assert.match(buffers.value, /设备未报告，FFmpeg 回退 1080/);
  assert.match(buffers.value, /1924 × 1080/);
});

function rows(native) {
  return Object.fromEntries(diagnostics.report({native:{engine:'mpv',state:'playing',...native}}).rows.map(row=>[row.label,row.value]));
}

test('one complete hardware sample shows source, decoder, reported and copied layouts, and timing', () => {
  const values=rows({
    hwdec_current:'mediacodec-copy',video_decoder:'HEVC (hevc)',decode_pixel_format:'yuv420p',output_pixel_format:'yuv420p',source_fps:29.97,
    mediacodec_format_seen:true,mediacodec_width_reported:true,mediacodec_height_reported:true,mediacodec_color_format_reported:true,
    mediacodec_width:1080,mediacodec_height:1924,mediacodec_color_format:19,
    mediacodec_decoder_known:true,mediacodec_decoder:'c2.vendor.hevc.decoder',mediacodec_crop_available:true,
    mediacodec_stride_reported:true,mediacodec_stride:1080,mediacodec_slice_height_reported:true,mediacodec_slice_height:1924,
    mediacodec_crop_top_reported:true,mediacodec_reported_crop_top:0,
    mediacodec_crop_right_reported:true,mediacodec_reported_crop_right:1079,
    mediacodec_copy_layout_available:true,mediacodec_copy_width:1080,mediacodec_copy_height:1924,
    mediacodec_copy_stride:1088,mediacodec_copy_slice_height:1984,
    mediacodec_copy_crop_top:0,mediacodec_copy_crop_bottom:1923,mediacodec_copy_crop_left:0,mediacodec_copy_crop_right:1079,
    mediacodec_copy_line_y:1088,mediacodec_copy_line_u:544,mediacodec_copy_line_v:544,
    decoder_frame_drop_count:0,frame_drop_count:7,mistimed_frame_count:3,vo_delayed_frame_count:2,avsync:-0.04
  });
  assert.match(values['MPV 片源 / 像素格式'],/HEVC \(hevc\).*容器 29.97 fps.*yuv420p/);
  assert.match(values['MediaCodec 输出格式'],/c2\.vendor\.hevc\.decoder.*1080 × 1924.*19/);
  assert.match(values['MediaCodec 缓冲布局'],/设备报告 1080.*设备报告 1924/);
  assert.equal(values['MediaCodec 设备报告裁剪'],'上0 下未报告 左未报告 右1079');
  assert.match(values['FFmpeg 实际拷贝布局'],/1080 × 1924.*stride 1088.*slice-height 1984.*1088\/544\/544/);
  assert.match(values['硬解布局采集'],/所需样本已取得.*不代表画面正常/);
  assert.equal(values['MPV 掉帧'],'解码 0 · 渲染 7');
  assert.match(values['MPV 显示时序'],/显示时机偏差 3 · 延迟显示 2/);
  assert.equal(values['MPV 音画差值'],'-40 ms');
});

test('missing metrics and partial samples are explicit, never fabricated zeros or completeness',()=>{
  const values=rows({hwdec_current:'mediacodec-copy',mediacodec_capture_incomplete:true});
  assert.match(values['硬解布局采集'],/不完整/);
  assert.equal(values['FFmpeg 实际拷贝布局'],'未取得');
  assert.match(values['MediaCodec 输出格式'],/解码器 未取得.*MediaFormat 未取得.*色彩格式 未取得/);
  assert.equal(values['MPV 音画差值'],'未取得');
  assert.match(values['MPV 掉帧'],/解码 未取得 · 渲染 未取得/);
  assert.doesNotMatch(values['MPV 显示时序'],/\b0\b/);
  for(const field of ['mediacodec_capture_active','mediacodec_capture_pending'])
    assert.match(rows({hwdec_current:'mediacodec-copy',[field]:true})['硬解布局采集'],/短采样中.*自动更新/);
});

test('software and Surface modes do not demand a CPU copy sample or reuse stale hardware fields',()=>{
  const software=rows({hwdec_current:'no',mediacodec_format_seen:true,mediacodec_copy_layout_available:true});
  assert.match(software['硬解布局采集'],/软件解码.*不适用/);
  assert.equal(software['MediaCodec 输出格式'],undefined);
  assert.equal(software['FFmpeg 实际拷贝布局'],undefined);
  const direct=rows({hwdec_current:'mediacodec'});
  assert.match(direct['硬解布局采集'],/Surface.*不经过 CPU 拷贝/);
  assert.match(direct['FFmpeg 实际拷贝布局'],/Surface/);
});

test('MPV diagnostics disclose the Samsung AVC codec-dimension override', () => {
  const report = diagnostics.report({
    native: {engine:'mpv',state:'playing',surface:'SurfaceView',output_ready:true,
      mediacodec_format_seen:true,mediacodec_decoder_known:true,mediacodec_decoder_family:2,
      mediacodec_decoder:'OMX.SEC.avc.dec',mediacodec_stride_reported:true,mediacodec_stride:1920,
      mediacodec_stride_overridden:true,mediacodec_slice_height_reported:true,mediacodec_slice_height:1088,
      mediacodec_slice_height_overridden:true}
  });
  const layout = report.rows.find(row => row.label === 'MediaCodec 输出格式');
  const buffers = report.rows.find(row => row.label === 'MediaCodec 缓冲布局');
  assert.match(layout.value, /OMX\.SEC\.avc\.dec/);
  assert.match(buffers.value, /FFmpeg 改用编码尺寸（未采集）/);
});
