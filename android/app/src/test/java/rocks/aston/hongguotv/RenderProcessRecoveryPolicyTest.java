package rocks.aston.hongguotv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class RenderProcessRecoveryPolicyTest {
    @Test public void aRendererCrashMayAutomaticallyRecoverOnce() {
        RenderProcessRecoveryPolicy policy = new RenderProcessRecoveryPolicy();
        assertTrue(policy.claimAutomaticRecovery(1000));
        assertFalse(policy.claimAutomaticRecovery(1001));
        assertFalse(policy.claimAutomaticRecovery(60_999));
    }

    @Test public void aLaterIndependentCrashMayRecoverAfterTheBudgetWindow() {
        RenderProcessRecoveryPolicy policy = new RenderProcessRecoveryPolicy();
        assertTrue(policy.claimAutomaticRecovery(1000));
        assertTrue(policy.claimAutomaticRecovery(61_000));
        assertFalse(policy.claimAutomaticRecovery(61_001));
    }

    @Test public void startupAtZeroStillConsumesTheRecoveryBudget() {
        RenderProcessRecoveryPolicy policy = new RenderProcessRecoveryPolicy();
        assertTrue(policy.claimAutomaticRecovery(0));
        assertFalse(policy.claimAutomaticRecovery(0));
        assertFalse(policy.claimAutomaticRecovery(59_999));
        assertTrue(policy.claimAutomaticRecovery(60_000));
    }
}
