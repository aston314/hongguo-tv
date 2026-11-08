#include <cassert>
#include "../android/mpv-jni/media_codec_layout_parser.h"

using hongguo_mpv::MediaCodecLayout;
using hongguo_mpv::MediaCodecLogCapture;

static void copySample(MediaCodecLayout &layout) {
    // Exact pinned FFmpeg AV_LOG_TRACE format, including mpv's AVClass prefix.
    layout.parse("ffmpeg/video", "hevc_mediacodec: Frame: width=1080 stride=1088 height=1924 slice-height=1984 crop-top=0 crop-bottom=1923 crop-left=0 crop-right=1079 encoder=c2.vendor.hevc.decoder destination linesizes=1088,544,544\n");
}

static void testCopyAndCapture() {
    MediaCodecLayout layout;
    MediaCodecLogCapture capture;
    assert(capture.start(100));
    assert(capture.active && (capture.flags() & MediaCodecLayout::CAPTURE_REQUESTED));
    assert(!capture.start(101)); // Repeated reads cannot extend the window.
    assert(!capture.finishIfNeeded(layout, 1599, false));
    assert(capture.finishIfNeeded(layout, 1600, false));
    assert(capture.incomplete && !capture.active);
    assert(!capture.start(5000)); // Bounded retry rate even on repeated refreshes.
    assert(capture.start(10100));
    for (unsigned i = 1; i < MediaCodecLogCapture::MAX_EVENTS; ++i)
        assert(!capture.finishIfNeeded(layout, 10101, true));
    assert(capture.finishIfNeeded(layout, 10101, true));
    assert(capture.incomplete && capture.events == 128);

    layout.parse("ffmpeg/video", "hevc_mediacodec: Output MediaFormat changed to {width=1080, height=1924, stride=1080, slice-height=1924, color-format=19, crop-top=0, crop-bottom=1923, crop-left=0, crop-right=1079}\n");
    layout.parse("ffmpeg/video", "hevc_mediacodec: Output crop parameters top=0 bottom=1923 left=0 right=1079, resulting dimensions width=1080 height=1924\n");
    assert(!layout.completeCopySample());
    copySample(layout);
    assert(layout.completeCopySample());
    assert(layout.safeDecoderName() == "c2.vendor.hevc.decoder");
    assert(layout.stride == 1080 && layout.copyStride == 1088);
    assert(layout.sliceHeight == 1924 && layout.copySliceHeight == 1984);
    assert(layout.copyWidth == 1080 && layout.copyHeight == 1924);
    assert(layout.lineY == 1088 && layout.lineU == 544 && layout.lineV == 544);
    const auto values = layout.values();
    assert(values.size() == 30 && values[17] == 1088 && values[23] == 1088);
    assert(values[26] == 0 && values[27] == 1923 && values[28] == 0 && values[29] == 1079);
    assert(values[0] & MediaCodecLayout::CROP_REPORTED_BASE);
    capture = MediaCodecLogCapture();
    assert(capture.start(0));
    assert(capture.finishIfNeeded(layout, 1, true));
    assert(!capture.incomplete && !capture.active && !capture.start(20000));

    const unsigned revision = layout.formatRevision;
    layout.parse("ffmpeg/video", "hevc_mediacodec: Output MediaFormat changed to {width=720, height=1280, crop-top=0}\n");
    assert(layout.formatRevision == revision + 1);
    assert(!layout.copyLayoutAvailable && !layout.cropAvailable && !layout.completeCopySample());
    assert(layout.cropReported[0] && !layout.cropReported[1]);
    assert(layout.decoderKnown); // Same decoder, replacement format.
    layout.reset(); // A new file must lose every old sample and decoder name.
    assert(!layout.decoderKnown && !layout.copyLayoutAvailable && !layout.cropReported[0]);
    const char *invalid[] = {
        "hevc_mediacodec: Frame: width=1080 stride=1088 height=1924 slice-height=1984 crop-top=0 crop-bottom=1923 crop-left=0 crop-right=1079 encoder=https://media.example/secret destination linesizes=1088,544,544\n",
        "hevc_mediacodec: Frame: width=1080 stride=1088 height=1924 slice-height=1984 crop-top=0 crop-bottom=1923 crop-left=0 crop-right=1079 encoder=c2.vendor.hevc.decoder destination linesizes=1088,544,544 token=secret",
        "hevc_mediacodec: Frame: width=1080 stride=9999999999999999999999 height=1924 slice-height=1984 crop-top=0 crop-bottom=1923 crop-left=0 crop-right=1079 encoder=c2.vendor.hevc.decoder destination linesizes=1088,544,544\n",
        "unrelated: hevc_mediacodec: Frame: width=1080 stride=1088 height=1924 slice-height=1984 crop-top=0 crop-bottom=1923 crop-left=0 crop-right=1079 encoder=c2.vendor.hevc.decoder destination linesizes=1088,544,544\n"
    };
    for (const char *line : invalid) {
        layout.parse("ffmpeg/video", line);
        assert(!layout.copyLayoutAvailable && !layout.decoderKnown && layout.safeDecoderName().empty());
    }
    layout.parse("stream", "Frame: width=1080 stride=1088 height=1924 slice-height=1984 crop-top=0 crop-bottom=1923 crop-left=0 crop-right=1079 encoder=c2.vendor.hevc.decoder destination linesizes=1088,544,544\n");
    assert(!layout.copyLayoutAvailable);
}

int main() {
    testCopyAndCapture();
    MediaCodecLayout layout;
    // mpv's FFmpeg log callback prepends AVClass.item_name to each line.
    layout.parse("ffmpeg/video", "hevc_mediacodec: Found decoder c2.vendor.hevc.decoder\n");
    layout.parse("ffmpeg/video", "hevc_mediacodec: Output MediaFormat changed to {width: int32(1080), height: int32(1924), stride: int32(1088), slice-height: int32(1984), color-format: int32(21)}\n");
    layout.parse("ffmpeg/video", "hevc_mediacodec: Output crop parameters top=0 bottom=1923 left=0 right=1079, resulting dimensions width=1080 height=1924\n");
    assert(layout.decoderKnown && layout.safeDecoderName() == "c2.vendor.hevc.decoder");
    assert(layout.formatSeen && layout.width == 1080 && layout.height == 1924);
    assert(layout.strideReported && layout.stride == 1088);
    assert(layout.sliceHeightReported && layout.sliceHeight == 1984);
    assert(layout.cropAvailable && layout.displayWidth == 1080 && layout.displayHeight == 1924);

    // A format change discards the preceding layout/crop, not the decoder.
    layout.parse("ffmpeg/video", "hevc_mediacodec: Output MediaFormat changed to {width=720, height=1280}\n");
    assert(layout.decoderKnown && layout.width == 720 && layout.height == 1280);
    assert(!layout.strideReported && !layout.sliceHeightReported && !layout.cropAvailable);
    assert(layout.strideFallbackAvailable && layout.strideFallback == 720);
    layout.reset();
    assert(!layout.decoderKnown && !layout.formatSeen && layout.safeDecoderName().empty());

    layout.parse("ffmpeg/video", "h264_mediacodec: Output MediaFormat changed to {width=1920, height=1080}\n");
    assert(layout.formatSeen && layout.width == 1920);
    assert(!layout.decoderKnown && !layout.strideFallbackAvailable && !layout.sliceFallbackAvailable);
    layout.reset();

    // Do not search arbitrary log bodies or strip untrusted strings as prefixes.
    layout.parse("stream", "hevc_mediacodec: Output MediaFormat changed to {width=1080}\n");
    layout.parse("ffmpeg/video", "https://media.example/token: Output MediaFormat changed to {width=1080}\n");
    layout.parse("ffmpeg/video", "unrelated: hevc_mediacodec: Output MediaFormat changed to {width=1080}\n");
    layout.parse("ffmpeg/video", "hevc_mediacodec: unrelated Output MediaFormat changed to {width=1080}\n");
    layout.parse("ffmpeg/video", "hevc_mediacodec: Found decoder https://media.example/token\n");
    assert(!layout.formatSeen && !layout.decoderKnown && !layout.cropAvailable);

    layout.parse("ffmpeg/video", "Found decoder OMX.qcom.video.decoder.hevc\n");
    layout.parse("ffmpeg/video", "Output MediaFormat changed to {mime: string(video/raw), width: int32(1924), height: int32(1080), stride: int32(1984), slice-height: int32(1088), color-format: int32(21)}\n");
    layout.parse("ffmpeg/video", "Output crop parameters top=0 bottom=1079 left=0 right=1923, resulting dimensions width=1924 height=1080\n");
    assert(layout.decoderKnown && layout.decoderFamily == MediaCodecLayout::DECODER_OTHER);
    assert(layout.formatSeen && layout.widthReported && layout.width == 1924);
    assert(layout.strideReported && layout.stride == 1984);
    assert(layout.sliceHeightReported && layout.sliceHeight == 1088);
    assert(layout.colorFormatReported && layout.colorFormat == 21);
    assert(layout.cropAvailable && layout.displayWidth == 1924 && layout.displayHeight == 1080);
    assert(layout.cropRight == 1923 && layout.cropBottom == 1079);

    layout.reset();
    layout.parse("ffmpeg/video", "Found decoder c2.vendor.hevc.decoder\n");
    layout.parse("ffmpeg/video", "Output MediaFormat changed to {max-width: int32(4096), width=720, height=1280, stride=768, slice-height=1280}\n");
    assert(layout.widthReported && layout.width == 720);
    assert(layout.heightReported && layout.height == 1280);
    assert(layout.strideReported && layout.stride == 768);
    assert(layout.sliceHeightReported && layout.sliceHeight == 1280);

    layout.reset();
    layout.parse("ffmpeg/video", "Found decoder c2.vendor.hevc.decoder\n");
    layout.parse("ffmpeg/video", "Output MediaFormat changed to {width: int32(720), height: int32(1280), slice-height: int32(-1)}\n");
    assert(layout.sliceHeightReported && layout.sliceHeight == -1 && !layout.sliceFallbackAvailable);

    layout.reset();
    layout.parse("ffmpeg/video", "Output MediaFormat changed to {width: int32(720), height: int32(1280)}\n");
    assert(!layout.strideFallbackAvailable && !layout.sliceFallbackAvailable);

    layout.reset();
    layout.parse("ffmpeg/video", "Found decoder OMX.qcom.video.decoder.hevc\n");
    layout.parse("ffmpeg/video", "Output MediaFormat changed to {width: int32(720), height: int32(1280), color-format: int32(21)}\n");
    assert(!layout.strideReported && layout.strideFallbackAvailable && layout.strideFallback == 720);
    assert(!layout.sliceHeightReported && layout.sliceFallbackAvailable && layout.sliceHeightFallback == 1280);

    layout.reset();
    layout.parse("ffmpeg/video", "Found decoder OMX.Nvidia.hevc.decoder\n");
    layout.parse("ffmpeg/video", "Output MediaFormat changed to {width: int32(1080), height: int32(1920)}\n");
    assert(layout.strideFallbackAvailable && layout.strideFallback == 1080);
    assert(layout.sliceFallbackAvailable && layout.sliceHeightFallback == 1920);

    layout.reset();
    layout.parse("ffmpeg/video", "Found decoder OMX.Nvidia.hevc.decoder\n");
    layout.parse("ffmpeg/video", "Output MediaFormat changed to {width: int32(720), height: int32(721)}\n");
    assert(layout.sliceFallbackAvailable && layout.sliceHeightFallback == 736);

    layout.reset();
    layout.parse("ffmpeg/video", "Found decoder OMX.SEC.avc.dec\n");
    layout.parse("ffmpeg/video", "Output MediaFormat changed to {width: int32(1920), height: int32(1080), stride: int32(0), slice-height: int32(0)}\n");
    assert(layout.strideReported && layout.stride == 0 && !layout.strideFallbackAvailable);
    assert(layout.sliceHeightReported && layout.sliceHeight == 0 && !layout.sliceFallbackAvailable);
    assert(layout.strideOverridden && layout.sliceHeightOverridden);
    assert(layout.safeDecoderName() == "OMX.SEC.avc.dec");

    layout.reset();
    layout.parse("stream", "Output MediaFormat changed to {width: int32(1920)} https://media.example/token\n");
    layout.parse("ffmpeg/video", "Found decoder OMX.google.hevc.decoder https://media.example/token\n");
    assert(!layout.formatSeen && layout.decoderKnown && layout.decoderFamily == MediaCodecLayout::DECODER_OTHER);
    for (int i = 0; i < 100; ++i) layout.parse("ffmpeg/video", "unrelated debug text with arbitrary data\n");
    assert(!layout.cropAvailable && !layout.formatSeen && layout.decoderKnown);
    assert(layout.safeDecoderName() == "OMX.google.hevc.decoder");
    return 0;
}
