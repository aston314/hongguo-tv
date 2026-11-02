package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class PlaybackCodecPolicyTest {
    @Test public void nativePlaybackAllowsAVCAndHEVCButRejectsAV1() {
        assertTrue(PlaybackCodecPolicy.allowsDecoder("video/avc"));
        assertTrue(PlaybackCodecPolicy.allowsDecoder("video/hevc"));
        assertTrue(PlaybackCodecPolicy.allowsDecoder("audio/mp4a-latm"));
        assertFalse(PlaybackCodecPolicy.allowsDecoder("video/av01"));
        assertFalse(PlaybackCodecPolicy.allowsDecoder(null));
    }

    @Test public void compatibilityModeStillKeepsSoftwareAVCAndAACRules() {
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/hevc", "OMX.realtek.video.dec.hevc", true));
        assertFalse(PlaybackCodecPolicy.allowsInMode("video/avc", "OMX.realtek.video.dec.avc", true));
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/avc", "OMX.google.h264.decoder", true));
        assertFalse(PlaybackCodecPolicy.allowsInMode("audio/mp4a-latm", null, true));
    }

    @Test public void androidNinePrefersSoftwareHevcButNewerSystemsKeepHardwareOrder() {
        assertTrue(PlaybackCodecPolicy.preferSoftware("video/hevc", 28));
        assertFalse(PlaybackCodecPolicy.preferSoftware("video/hevc", 29));
        assertFalse(PlaybackCodecPolicy.preferSoftware("video/avc", 28));
    }

    @Test public void androidSixKeepsHardwareHevcOrderAndPcmAudioLikeV136() {
        assertFalse(PlaybackCodecPolicy.preferSoftware("video/hevc", 23));
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/hevc", "OMX.vendor.hevc.decoder", false));
        assertTrue(PlaybackCodecPolicy.pcmAudio(false, false, 23));
        assertFalse(PlaybackCodecPolicy.pcmAudio(false, true, 23));
        assertFalse(PlaybackCodecPolicy.pcmAudio(false, false, 24));
        assertTrue(PlaybackCodecPolicy.pcmAudio(true, true, 30));
    }

    @Test public void decoderErrorsKeepV136ClassificationWithoutAnFfmpegRetry() {
        assertEquals("source", PlaybackCodecPolicy.failureKind(3001));
        assertEquals("decoder", PlaybackCodecPolicy.failureKind(4001));
        assertEquals("network", PlaybackCodecPolicy.failureKind(2001));
    }
}
