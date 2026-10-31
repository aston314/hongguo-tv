package rocks.aston.hongguotv;

import android.content.Context;

import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;

import io.github.anilbeesetti.nextlib.media3ext.ffdecoder.NextRenderersFactory;

/** Prefer platform decoding and expose NextLib FFmpeg for bounded software fallback. */
@android.annotation.SuppressLint("UnsafeOptInUsageError")
final class PlayerRendererPolicy {
    private PlayerRendererPolicy() {}

    static boolean primaryPlayback() { return true; }
    static boolean ffmpegAvailable() { return true; }

    static DefaultRenderersFactory create(Context context, boolean preferFfmpeg,
                                           boolean pcmAudio, MediaCodecSelector selector) {
        NextRenderersFactory renderers = new NextRenderersFactory(context) {
            @Override protected AudioSink buildAudioSink(Context value, boolean floatOutput,
                                                          boolean playbackParams) {
                if (!pcmAudio) return super.buildAudioSink(value, floatOutput, playbackParams);
                return new DefaultAudioSink.Builder().setEnableFloatOutput(false)
                        .setEnableAudioTrackPlaybackParams(false).build();
            }
        };
        renderers.setEnableDecoderFallback(true);
        renderers.setMediaCodecSelector(selector);
        renderers.setExtensionRendererMode(preferFfmpeg
                ? DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER
                : DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON);
        return renderers;
    }
}
