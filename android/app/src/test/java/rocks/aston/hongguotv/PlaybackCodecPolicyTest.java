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

    @Test public void decoderFallbackCoversMedia3DecoderErrorsAndBothVideoFamilies() {
        assertTrue(PlaybackCodecPolicy.decoderFailure(3001));
        assertTrue(PlaybackCodecPolicy.decoderFailure(4999));
        assertFalse(PlaybackCodecPolicy.decoderFailure(2001));
        assertTrue(PlaybackCodecPolicy.excludesDecoderForSoftwareFallback(
                true, "video/avc", "OMX.vendor.h264.decoder"));
        assertTrue(PlaybackCodecPolicy.excludesDecoderForSoftwareFallback(
                true, "video/hevc", "OMX.vendor.hevc.decoder"));
        assertFalse(PlaybackCodecPolicy.excludesDecoderForSoftwareFallback(
                true, "audio/mp4a-latm", "OMX.vendor.audio.decoder"));
        assertFalse(PlaybackCodecPolicy.excludesDecoderForSoftwareFallback(
                false, "video/hevc", "OMX.vendor.hevc.decoder"));
        assertTrue(PlaybackCodecPolicy.shouldRetrySoftwareDecoder(true, false, false));
        assertFalse(PlaybackCodecPolicy.shouldRetrySoftwareDecoder(true, true, false));
        assertFalse(PlaybackCodecPolicy.shouldRetrySoftwareDecoder(true, false, true));
    }
}
