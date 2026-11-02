package rocks.aston.hongguotv;

import android.content.Context;

import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;

/** v0.2.136: HTML5 first, with a platform-decoder-only Media3 fallback. */
@android.annotation.SuppressLint("UnsafeOptInUsageError")
final class PlayerRendererPolicy {
    private PlayerRendererPolicy() {}

    static boolean primaryPlayback() { return false; }

    static DefaultRenderersFactory create(Context context, boolean forceSoftwareHevc,
                                           boolean pcmAudio, MediaCodecSelector selector) {
        // The selector already applies the bounded system-HEVC retry policy.
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(context) {
            @Override protected AudioSink buildAudioSink(Context value, boolean floatOutput,
                                                          boolean playbackParams) {
                if (!pcmAudio) return super.buildAudioSink(value, floatOutput, playbackParams);
                return new DefaultAudioSink.Builder().setEnableFloatOutput(false)
                        .setEnableAudioTrackPlaybackParams(false).build();
            }
        };
        renderers.setEnableDecoderFallback(true);
        renderers.setMediaCodecSelector(selector);
        return renderers;
    }
}
