/* Application wrapper; FFmpeg is built separately under LGPL-2.1-or-later. */
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/channel_layout.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

EM_JS(int, read_bytes, (uint8_t *ptr, int size), {
  try { return Module.hgIO.read(ptr, size, HEAPU8); } catch (_) { return -5; }
});
EM_JS(double, seek_bytes, (double offset, int whence), {
  try { return Module.hgIO.seek(offset, whence); } catch (_) { return -5; }
});
static int read_packet(void *opaque, uint8_t *buf, int size) {
  int count = read_bytes(buf, size);
  return count == 0 ? AVERROR_EOF : count;
}
static int64_t seek_packet(void *opaque, int64_t offset, int whence) {
  return (int64_t)seek_bytes((double)offset, whence);
}
static AVFormatContext *format;
static AVIOContext *io;
static AVCodecContext *dec[2];
static AVStream *stream[2];
static AVPacket *packet;
static AVFrame *frame;
static struct SwsContext *scale;
static SwrContext *resample;
static uint8_t *output;
static unsigned output_capacity;
static int pending = -1, eof, drain, width, height, samples, color_space, color_range;
static double pts, duration;

EMSCRIPTEN_KEEPALIVE void hg_close(void) {
  for (int i = 0; i < 2; i++) { avcodec_free_context(&dec[i]); stream[i] = NULL; }
  avformat_close_input(&format);
  if (io) { av_freep(&io->buffer); avio_context_free(&io); }
  av_packet_free(&packet); av_frame_free(&frame);
  sws_freeContext(scale); scale = NULL; swr_free(&resample);
  av_freep(&output); output_capacity = 0; pending = -1; eof = drain = 0;
}
EMSCRIPTEN_KEEPALIVE int hg_open(double at) {
  hg_close(); av_log_set_level(AV_LOG_QUIET);
  uint8_t *buffer = av_malloc(65536);
  if (!buffer) return -1;
  io = avio_alloc_context(buffer, 65536, 0, NULL, read_packet, NULL, seek_packet);
  if (!io) { av_free(buffer); return -1; }
  format = avformat_alloc_context();
  if (!format) return -1;
  format->pb = io; format->flags |= AVFMT_FLAG_CUSTOM_IO;
  format->probesize = 1024 * 1024; format->max_analyze_duration = 5 * AV_TIME_BASE;
  if (avformat_open_input(&format, NULL, NULL, NULL) < 0 || avformat_find_stream_info(format, NULL) < 0) return -2;
  for (int kind = 0; kind < 2; kind++) {
    int index = av_find_best_stream(format, kind == 0 ? AVMEDIA_TYPE_VIDEO : AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    if (index < 0) { if (kind == 0) return -3; else continue; }
    stream[kind] = format->streams[index];
    enum AVCodecID id = stream[kind]->codecpar->codec_id;
    if ((kind == 0 && id != AV_CODEC_ID_HEVC && id != AV_CODEC_ID_H264) || (kind == 1 && id != AV_CODEC_ID_AAC)) return -4;
    const AVCodec *codec = avcodec_find_decoder(id);
    dec[kind] = avcodec_alloc_context3(codec);
    if (!dec[kind] || avcodec_parameters_to_context(dec[kind], stream[kind]->codecpar) < 0) return -4;
    dec[kind]->thread_count = 1;
    dec[kind]->pkt_timebase = stream[kind]->time_base;
    if (avcodec_open2(dec[kind], codec, NULL) < 0) return -4;
  }
  if (dec[0]->width < 1 || dec[0]->height < 1 || dec[0]->width > 4096 || dec[0]->height > 4096) return -5;
  width = dec[0]->width; height = dec[0]->height;
  duration = format->duration > 0 ? format->duration / (double)AV_TIME_BASE : 0;
  if (dec[1]) {
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    if (swr_alloc_set_opts2(&resample, &stereo, AV_SAMPLE_FMT_FLT, 48000, &dec[1]->ch_layout, dec[1]->sample_fmt, dec[1]->sample_rate, 0, NULL) < 0 || swr_init(resample) < 0) return -6;
  }
  packet = av_packet_alloc(); frame = av_frame_alloc();
  if (!packet || !frame) return -1;
  if (at > 0 && av_seek_frame(format, -1, (int64_t)(at * AV_TIME_BASE), AVSEEK_FLAG_BACKWARD) < 0) return -7;
  return 0;
}
static int receive(int kind) {
  int status = avcodec_receive_frame(dec[kind], frame);
  if (status == AVERROR(EAGAIN) || status == AVERROR_EOF) return 0;
  if (status < 0) return -8;
  pts = frame->best_effort_timestamp == AV_NOPTS_VALUE ? 0 : frame->best_effort_timestamp * av_q2d(stream[kind]->time_base);
  if (format->start_time != AV_NOPTS_VALUE) pts -= format->start_time / (double)AV_TIME_BASE;
  if (kind == 0) {
    width = frame->width; height = frame->height;
    if (width < 1 || height < 1 || width > 4096 || height > 4096) return -5;
    int size = av_image_get_buffer_size(AV_PIX_FMT_YUV420P, width, height, 1);
    av_fast_malloc(&output, &output_capacity, size);
    if (!output) return -1;
    uint8_t *planes[4]; int lines[4];
    av_image_fill_arrays(planes, lines, output, AV_PIX_FMT_YUV420P, width, height, 1);
    scale = sws_getCachedContext(scale, width, height, frame->format, width, height, AV_PIX_FMT_YUV420P, SWS_FAST_BILINEAR, NULL, NULL, NULL);
    if (!scale) return -8;
    sws_scale(scale, (const uint8_t *const *)frame->data, frame->linesize, 0, height, planes, lines);
    color_space = frame->colorspace; color_range = frame->color_range;
  } else {
    int capacity = swr_get_out_samples(resample, frame->nb_samples);
    av_fast_malloc(&output, &output_capacity, capacity * 2 * sizeof(float));
    if (!output) return -1;
    uint8_t *dest[] = {output};
    samples = swr_convert(resample, dest, capacity, (const uint8_t **)frame->extended_data, frame->nb_samples);
    if (samples < 0) return -8;
  }
  av_frame_unref(frame);
  return kind + 1;
}
EMSCRIPTEN_KEEPALIVE int hg_step(void) {
  for (int attempts = 0; attempts < 10000; attempts++) {
    if (pending >= 0) { int result = receive(pending); if (result) return result; pending = -1; }
    if (eof) {
      while (drain < 2) {
        int kind = drain++;
        if (dec[kind]) { avcodec_send_packet(dec[kind], NULL); pending = kind; break; }
      }
      if (pending >= 0) continue;
      return 0;
    }
    if (av_read_frame(format, packet) < 0) { eof = 1; continue; }
    for (int kind = 0; kind < 2; kind++) if (stream[kind] && packet->stream_index == stream[kind]->index) {
      int result = avcodec_send_packet(dec[kind], packet);
      av_packet_unref(packet);
      if (result < 0) return -8;
      pending = kind; break;
    }
    av_packet_unref(packet);
  }
  return -8;
}
EMSCRIPTEN_KEEPALIVE uintptr_t hg_ptr(void) { return (uintptr_t)output; }
EMSCRIPTEN_KEEPALIVE int hg_width(void) { return width; }
EMSCRIPTEN_KEEPALIVE int hg_height(void) { return height; }
EMSCRIPTEN_KEEPALIVE int hg_samples(void) { return samples; }
EMSCRIPTEN_KEEPALIVE int hg_audio(void) { return dec[1] != NULL; }
EMSCRIPTEN_KEEPALIVE int hg_colorspace(void) { return color_space; }
EMSCRIPTEN_KEEPALIVE int hg_fullrange(void) { return color_range == AVCOL_RANGE_JPEG; }
EMSCRIPTEN_KEEPALIVE double hg_pts(void) { return pts; }
EMSCRIPTEN_KEEPALIVE double hg_duration(void) { return duration; }
