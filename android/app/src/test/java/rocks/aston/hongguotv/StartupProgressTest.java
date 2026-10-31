package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class StartupProgressTest {
    @Test public void fastBurstEndsAfterRealClockAdvance() {
        StartupProgress pulse = new StartupProgress();
        pulse.begin(1000, 10, true);
        assertEquals(50, pulse.delayMs(1000, true));
        assertFalse(pulse.observe(10, 1050, true));
        assertEquals(50, pulse.delayMs(1050, true));
        assertTrue(pulse.observe(60, 1100, true));
        assertEquals(1100, pulse.advancedAt());
        assertEquals(500, pulse.delayMs(1100, true));
        assertFalse(pulse.observe(100, 1150, true));
    }
    @Test public void noFramePauseOrStalledClockCannotKeepAHighFrequencyLoop() {
        StartupProgress pulse = new StartupProgress();
        assertEquals(500, pulse.delayMs(1000, true));
        assertFalse(pulse.observe(100, 1000, true));
        pulse.begin(1000, 0, true);
        assertFalse(pulse.observe(100, 1050, false));
        assertEquals(500, pulse.delayMs(1050, false));
        assertEquals(50, pulse.delayMs(1999, true));
        assertEquals(500, pulse.delayMs(2000, true));
        pulse.reset();
        assertFalse(pulse.observe(100, 2100, true));
        assertEquals(500, pulse.delayMs(2100, true));
    }
    @Test public void originalCadenceStillMeasuresProgressAndEachSourceGetsItsOwnBaseline() {
        StartupProgress pulse = new StartupProgress();
        pulse.begin(1000, 5000, false);
        assertEquals(500, pulse.delayMs(1050, true));
        assertFalse(pulse.observe(0, 1100, true));
        assertTrue(pulse.observe(5050, 1500, true));
        pulse.begin(2000, 0, true);
        assertEquals(-1, pulse.advancedAt());
        assertFalse(pulse.observe(1, 2050, true));
        assertTrue(pulse.observe(50, 2100, true));
    }
}
