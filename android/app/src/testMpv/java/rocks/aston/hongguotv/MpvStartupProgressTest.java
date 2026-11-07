package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class MpvStartupProgressTest {
    @Test public void onlyRealForwardProgressWithARunningCoreQualifies() {
        MpvStartupProgress probe = new MpvStartupProgress(1000, 0);
        assertFalse(probe.advanced(null, true));
        assertFalse(probe.advanced(Double.NaN, true));
        assertFalse(probe.advanced(Double.POSITIVE_INFINITY, true));
        assertFalse(probe.advanced(-1.0, true));
        assertFalse(probe.advanced(0.0, true));
        assertFalse(probe.advanced(.001, true));
        assertFalse(probe.advanced(.033, false));
        assertFalse(probe.advanced(.033, true));
        assertTrue(probe.advanced(.067, true));
    }

    @Test public void nonzeroResumeAndBackwardTimestampCorrectionsAreNotProgress() {
        MpvStartupProgress probe = new MpvStartupProgress(1000, 39000);
        assertFalse(probe.advanced(39.0, true));
        assertTrue(probe.advanced(39.033, true));
        assertFalse(probe.advanced(38.9, true));
        assertTrue(probe.advanced(38.933, true));
    }

    @Test public void startupSamplingExpiresAndNeverRunsForAnIneligibleSession() {
        MpvStartupProgress probe = new MpvStartupProgress(1000, 0);
        int samples = 0;
        for (long now = 1000; now < 3000; now += MpvStartupProgress.RETRY_MS) {
            if (probe.maySample(now, true)) samples++;
        }
        assertEquals(10, samples);
        assertFalse(probe.maySample(1500, true));
        assertFalse(probe.maySample(1000, false));
    }
}
