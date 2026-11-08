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
  const dimensions = report.rows.find(row => row.label === 'MPV 编码 / 显示尺寸');
  assert.match(dimensions.value, /编码 1924 × 1080 · 显示 1924 × 1080/);
  assert.match(buffers.value, /设备未报告，FFmpeg 回退 1924/);
  assert.match(buffers.value, /设备未报告，FFmpeg 回退 1080/);
  assert.match(buffers.value, /1924 × 1080/);
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
