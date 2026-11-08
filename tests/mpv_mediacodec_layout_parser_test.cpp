#include <cassert>
#include "../android/mpv-jni/media_codec_layout_parser.h"

using hongguo_mpv::MediaCodecLayout;

int main() {
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
