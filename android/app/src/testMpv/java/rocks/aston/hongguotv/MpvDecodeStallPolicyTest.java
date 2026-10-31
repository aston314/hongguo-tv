package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public final class MpvDecodeStallPolicyTest {
    @Test public void samplesOnlyActivePlayingOutput() {
        assertTrue(MpvDecodeStallPolicy.shouldSample(true, false, false, false, true, true, false));
        assertFalse(MpvDecodeStallPolicy.shouldSample(false, false, false, false, true, true, false));
        assertFalse(MpvDecodeStallPolicy.shouldSample(true, true, false, false, true, true, false));
        assertFalse(MpvDecodeStallPolicy.shouldSample(true, false, true, false, true, true, false));
        assertFalse(MpvDecodeStallPolicy.shouldSample(true, false, false, true, true, true, false));
        assertFalse(MpvDecodeStallPolicy.shouldSample(true, false, false, false, false, true, false));
        assertFalse(MpvDecodeStallPolicy.shouldSample(true, false, false, false, true, false, false));
        assertFalse(MpvDecodeStallPolicy.shouldSample(true, false, false, false, true, true, true));
    }

    @Test public void switchesOnlyAfterTwoHeavyWindowsOnAutomaticHardware() {
        assertFalse(MpvDecodeStallPolicy.heavy(29));
        assertTrue(MpvDecodeStallPolicy.heavy(30));
        assertTrue(MpvDecodeStallPolicy.heavy(30, 5000));
        assertFalse(MpvDecodeStallPolicy.heavy(30, 10000));
        assertFalse(MpvDecodeStallPolicy.shouldFallback(MpvDecodeMode.AUTOMATIC, false, true, 1));
        assertTrue(MpvDecodeStallPolicy.shouldFallback(MpvDecodeMode.AUTOMATIC, false, true, 2));
        assertFalse(MpvDecodeStallPolicy.shouldFallback(MpvDecodeMode.SOFTWARE, false, true, 2));
        assertFalse(MpvDecodeStallPolicy.shouldFallback(MpvDecodeMode.AUTOMATIC, true, true, 2));
        assertFalse(MpvDecodeStallPolicy.shouldFallback(MpvDecodeMode.AUTOMATIC, false, false, 2));
    }
}
