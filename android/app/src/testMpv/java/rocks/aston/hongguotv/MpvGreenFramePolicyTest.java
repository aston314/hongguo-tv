package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public final class MpvGreenFramePolicyTest {
    @Test public void requiresNearlyEntireFrameToBeGreen() {
        int[] green = new int[100];
        java.util.Arrays.fill(green, 0xff00ff00);
        assertTrue(MpvGreenFramePolicy.isBrokenFrame(green));
        green[0] = 0xff202020;
        assertTrue(MpvGreenFramePolicy.isBrokenFrame(green));
        green[1] = 0xff202020;
        assertFalse(MpvGreenFramePolicy.isBrokenFrame(green));
    }

    @Test public void aSingleNormalSampleResetsTheStreak() {
        assertEquals(1, MpvGreenFramePolicy.nextStreak(0, true));
        assertEquals(2, MpvGreenFramePolicy.nextStreak(1, true));
        assertEquals(0, MpvGreenFramePolicy.nextStreak(2, false));
        assertFalse(MpvGreenFramePolicy.shouldFallback(1));
        assertTrue(MpvGreenFramePolicy.shouldFallback(2));
    }
}
