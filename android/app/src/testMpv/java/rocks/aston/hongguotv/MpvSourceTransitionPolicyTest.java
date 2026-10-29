package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MpvSourceTransitionPolicyTest {
    private boolean eligible(MpvDecodeMode currentMode, MpvDecodeMode nextMode,
                             boolean ready, boolean sameBinding, boolean fenced,
                             boolean background) {
        return MpvSourceTransitionPolicy.mayReplaceInPlace(
            currentMode, nextMode, ready, sameBinding, fenced, background);
    }

    @Test public void onlySoftwareToSoftwareCanReplaceInPlace() {
        assertTrue(eligible(MpvDecodeMode.SOFTWARE, MpvDecodeMode.SOFTWARE,
            true, true, false, false));
        assertFalse(eligible(MpvDecodeMode.AUTOMATIC, MpvDecodeMode.AUTOMATIC,
            true, true, false, false));
        assertFalse(eligible(MpvDecodeMode.SOFTWARE, MpvDecodeMode.AUTOMATIC,
            true, true, false, false));
        assertFalse(eligible(MpvDecodeMode.AUTOMATIC, MpvDecodeMode.SOFTWARE,
            true, true, false, false));
    }

    @Test public void unhealthyOrChangingPlayerBindingKeepsStopFencePath() {
        assertFalse(eligible(MpvDecodeMode.SOFTWARE, MpvDecodeMode.SOFTWARE,
            false, true, false, false));
        assertFalse(eligible(MpvDecodeMode.SOFTWARE, MpvDecodeMode.SOFTWARE,
            true, false, false, false));
        assertFalse(eligible(MpvDecodeMode.SOFTWARE, MpvDecodeMode.SOFTWARE,
            true, true, true, false));
        assertFalse(eligible(MpvDecodeMode.SOFTWARE, MpvDecodeMode.SOFTWARE,
            true, true, false, true));
    }
}
