package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public final class MpvFallbackPolicyTest {
    @Test public void onlyAutomaticHardwareSessionsMayFallback() {
        assertTrue(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, true, "green_frame"));
        assertTrue(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, true, "decode_stall"));
        assertFalse(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.SOFTWARE, false, true, "green_frame"));
        assertFalse(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, true, true, "green_frame"));
        assertFalse(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, false, "green_frame"));
    }

    @Test public void unrelatedFailuresDoNotSilentlyChangeDecoder() {
        assertFalse(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, true, "network"));
        assertFalse(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, true, "output_timeout"));
        assertFalse(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, true, "media", false));
        assertTrue(MpvFallbackPolicy.canRetryInSoftware(MpvDecodeMode.AUTOMATIC, false, true, "media", true));
    }
}
