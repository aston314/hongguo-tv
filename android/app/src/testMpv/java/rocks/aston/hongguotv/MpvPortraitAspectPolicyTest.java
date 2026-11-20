package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class MpvPortraitAspectPolicyTest {
    private String ratio(String hardware, String codec, int dw, int dh, int sw, int sh) {
        return MpvPortraitAspectPolicy.override(hardware, codec, dw, dh, sw, sh, 0, 1.0);
    }

    @Test public void sourceMetadataRepairsBothReportedHeightClampsWithoutAModelList() {
        assertEquals("1080:1920", ratio("mediacodec-copy", "hevc", 1080, 1088, 1080, 1920));
        assertEquals("720:1280", ratio("mediacodec-copy", "HEVC", 720, 1088, 720, 1280));
        assertEquals("1080:1920", ratio("mediacodec", "hevc", 1080, 1088, 1080, 1920));
        // Honor a verified source ratio rather than forcing every portrait to 9:16.
        assertEquals("1080:1440", ratio("mediacodec-copy", "hevc", 1080, 1088, 1080, 1440));
    }

    @Test public void missingOrConflictingMetadataNeverGuessesAPortraitRatio() {
        assertEquals("", ratio("mediacodec-copy", "hevc", 1080, 1088, 0, 0));
        assertEquals("", ratio("mediacodec-copy", "hevc", 1080, 1088, 0, 1920));
        assertEquals("", ratio("mediacodec-copy", "hevc", 1080, 1088, 720, 1280));
        assertEquals("", ratio("mediacodec-copy", "hevc", 1080, 1088, 1080, 1088));
        assertEquals("", ratio("mediacodec-copy", "hevc", 1080, 1088, 1080, 8192));
    }

    @Test public void normalPortraitLandscapeAndNonstandardWidthsKeepTheirAspect() {
        assertEquals("", ratio("mediacodec-copy", "hevc", 1080, 1920, 1080, 1920));
        assertEquals("", ratio("mediacodec-copy", "hevc", 720, 1280, 720, 1280));
        assertEquals("", ratio("mediacodec-copy", "hevc", 1920, 1088, 1920, 1080));
        assertEquals("", ratio("mediacodec-copy", "hevc", 1922, 1088, 1922, 1080));
        assertEquals("", ratio("mediacodec-copy", "hevc", 1924, 1088, 1924, 1080));
        assertEquals("", ratio("mediacodec-copy", "hevc", 720, 1088, 720, 1088));
    }

    @Test public void softwareOtherCodecsAndUnavailableDimensionsAreExcluded() {
        assertEquals("", ratio("no", "hevc", 1080, 1088, 1080, 1920));
        assertEquals("", ratio("", "hevc", 1080, 1088, 1080, 1920));
        assertEquals("", ratio("mediacodec-copy", "h264", 1080, 1088, 1080, 1920));
        assertEquals("", ratio("mediacodec-copy", "hevc", 0, 0, 1080, 1920));
        assertFalse(MpvPortraitAspectPolicy.eligible(MpvDecodeMode.SOFTWARE, false));
        assertFalse(MpvPortraitAspectPolicy.eligible(MpvDecodeMode.AUTOMATIC, true));
        assertTrue(MpvPortraitAspectPolicy.eligible(MpvDecodeMode.AUTOMATIC, false));
    }

    @Test public void rotatedAndAnamorphicVideoIsNotReinterpreted() {
        assertEquals("", MpvPortraitAspectPolicy.override("mediacodec-copy", "hevc",
            1080, 1088, 1080, 1920, 90, 1.0));
        for (Double par : new Double[]{0.0, 1.5, Double.NaN, Double.POSITIVE_INFINITY}) {
            assertEquals("", MpvPortraitAspectPolicy.override("mediacodec-copy", "hevc",
                1080, 1088, 1080, 1920, 0, par));
        }
        assertEquals("1080:1920", MpvPortraitAspectPolicy.override("mediacodec-copy", "hevc",
            1080, 1088, 1080, 1920, 0, null));
    }

    @Test public void onlyConfirmedMiTvChangesAutomaticDecoderPreference() {
        assertEquals("mediacodec-copy", MpvPortraitAspectPolicy.hwdec("MiTV4-ANSM0", MpvDecodeMode.AUTOMATIC, false));
        assertEquals("auto-safe", MpvPortraitAspectPolicy.hwdec("SHIELD Android TV", MpvDecodeMode.AUTOMATIC, false));
        assertEquals("auto-safe", MpvPortraitAspectPolicy.hwdec(null, MpvDecodeMode.AUTOMATIC, false));
        assertEquals("auto-safe", MpvPortraitAspectPolicy.hwdec("MiTV4", MpvDecodeMode.AUTOMATIC, false));
        assertEquals("no", MpvPortraitAspectPolicy.hwdec("MiTV4-ANSM0", MpvDecodeMode.SOFTWARE, false));
        assertEquals("no", MpvPortraitAspectPolicy.hwdec("MiTV4-ANSM0", MpvDecodeMode.AUTOMATIC, true));
    }

    @Test public void aspectRepairOnlyBypassesOldMemoryAndKeepsRealFailureRecovery() {
        assertTrue(MpvPortraitAspectPolicy.useCachedDecodeFailure(true, false));
        assertFalse(MpvPortraitAspectPolicy.useCachedDecodeFailure(true, true));
        assertFalse(MpvPortraitAspectPolicy.useCachedDecodeFailure(false, false));
        for (String reason : new String[]{"green_frame", "decode_stall", "known_broken_profile"})
            assertTrue(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, true, reason));
        assertTrue(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, true, "media", true));
        assertFalse(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, true, true, "green_frame"));
    }
}
