package rocks.aston.hongguotv;

import android.content.Context;

import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;

/** Keeps the production standard flavor on its existing platform renderers. */
@android.annotation.SuppressLint("UnsafeOptInUsageError")
final class PlayerRendererPolicy {
    private PlayerRendererPolicy() {}

    static boolean primaryPlayback() { return false; }
    static boolean ffmpegAvailable() { return false; }

    static DefaultRenderersFactory create(Context context, boolean preferFfmpeg,
                                           boolean pcmAudio, MediaCodecSelector selector) {
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
