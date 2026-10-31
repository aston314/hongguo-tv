package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Tests for automatic software HEVC decoder fallback when FORMAT_EXCEEDS_CAPABILITIES is detected.
 *
 * This addresses https://github.com/aston314/hongguo-tv-releases/issues/49
 * where TCL 32-bit devices with Realtek decoders report FORMAT_EXCEEDS_CAPABILITIES
 * for certain HEVC content and need to fallback to software decoding.
 */
public class PlayerBridgeHevcFallbackTest {

    @Test
    public void softwareFallbackRequiresSelectedUnsupportedHevcBeforeFirstFrameAndRunsOnce() {
        assertTrue(PlaybackCodecPolicy.shouldRetrySoftwareDecoder(true, false, false));
        assertFalse(PlaybackCodecPolicy.shouldRetrySoftwareDecoder(false, false, false));
        assertFalse(PlaybackCodecPolicy.shouldRetrySoftwareDecoder(true, true, false));
        assertFalse(PlaybackCodecPolicy.shouldRetrySoftwareDecoder(true, false, true));
    }

    @Test
    public void forcedSoftwareFallbackFiltersOnlyHardwareHevcDecoders() {
        assertTrue(PlaybackCodecPolicy.excludesDecoderForSoftwareHevc(
                true, "video/hevc", "OMX.realtek.video.decoder"));
        assertFalse(PlaybackCodecPolicy.excludesDecoderForSoftwareHevc(
                true, "video/hevc", "OMX.google.hevc.decoder"));
        assertFalse(PlaybackCodecPolicy.excludesDecoderForSoftwareHevc(
                true, "video/avc", "OMX.realtek.video.decoder"));
        assertFalse(PlaybackCodecPolicy.excludesDecoderForSoftwareHevc(
                false, "video/hevc", "OMX.realtek.video.decoder"));
    }

    @Test
    public void compatibilityModeRestrictsAVCAndAACNotHEVC() {
        // Compatibility mode restricts hardware AVC decoders
        assertFalse(PlaybackCodecPolicy.allowsInMode("video/avc", "OMX.realtek.video.decoder", true));

        // But allows Google's software decoders
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/avc", "OMX.google.h264.decoder", true));

        // HEVC hardware decoders are NOT restricted by compatibility mode alone
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/hevc", "OMX.realtek.video.decoder", true));
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/hevc", "OMX.google.hevc.decoder", true));
    }

    @Test
    public void standardModeAllowsAllDecoders() {
        // Standard mode allows both hardware and software decoders
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/avc", "OMX.realtek.video.decoder", false));
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/avc", "OMX.google.h264.decoder", false));
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/hevc", "OMX.realtek.video.decoder", false));
        assertTrue(PlaybackCodecPolicy.allowsInMode("video/hevc", "OMX.google.hevc.decoder", false));
    }

    @Test
    public void softwarePreferenceOnlyAppliesToAndroid7Through8() {
        // Android 7-8 prefer software HEVC
        assertTrue(PlaybackCodecPolicy.preferSoftware("video/hevc", 28));
        assertTrue(PlaybackCodecPolicy.preferSoftware("video/hevc", 24));

        // Android 10+ (including API 30 from the issue) do NOT prefer software
        assertFalse(PlaybackCodecPolicy.preferSoftware("video/hevc", 29));
        assertFalse(PlaybackCodecPolicy.preferSoftware("video/hevc", 30));

        // AVC never prefers software regardless of API level
        assertFalse(PlaybackCodecPolicy.preferSoftware("video/avc", 28));
    }

    @Test
    public void platformSoftwareDetection() {
        // Google platform decoders
        assertTrue(PlaybackCodecPolicy.platformSoftware("OMX.google.h264.decoder"));
        assertTrue(PlaybackCodecPolicy.platformSoftware("OMX.google.hevc.decoder"));
        assertTrue(PlaybackCodecPolicy.platformSoftware("c2.android.hevc.decoder"));
        assertTrue(PlaybackCodecPolicy.platformSoftware("c2.google.h264.decoder"));

        // OEM hardware decoders
        assertFalse(PlaybackCodecPolicy.platformSoftware("OMX.realtek.video.decoder"));
        assertFalse(PlaybackCodecPolicy.platformSoftware("OMX.MTK.VIDEO.DECODER.HEVC"));
        assertFalse(PlaybackCodecPolicy.platformSoftware("OMX.qcom.video.decoder.hevc"));
    }

    @Test
    public void decoderFailureKindClassification() {
        // Decoder errors (4000-5000) should trigger fail, not retry
        assertEquals("decoder", PlaybackCodecPolicy.failureKind(4001));
        assertEquals("decoder", PlaybackCodecPolicy.failureKind(4999));

        // Network errors should trigger retry
        assertEquals("network", PlaybackCodecPolicy.failureKind(2001));

        // Source errors should trigger retry
        assertEquals("source", PlaybackCodecPolicy.failureKind(1001));
    }
}
