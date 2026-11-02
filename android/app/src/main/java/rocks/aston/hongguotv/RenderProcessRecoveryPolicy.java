package rocks.aston.hongguotv;

/** Process-wide budget survives Activity recreation without persisting user data. */
final class RenderProcessRecoveryPolicy {
    private static final long RECOVERY_INTERVAL_MS = 60_000L;
    private long lastAutomaticRecovery = -1L;

    synchronized boolean claimAutomaticRecovery(long uptimeMillis) {
        if (lastAutomaticRecovery >= 0 && uptimeMillis >= lastAutomaticRecovery &&
                uptimeMillis - lastAutomaticRecovery < RECOVERY_INTERVAL_MS) return false;
        lastAutomaticRecovery = uptimeMillis;
        return true;
    }
}
