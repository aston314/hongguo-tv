package rocks.aston.hongguotv;

/** A short read-only probe after output readiness, never a replacement for it. */
final class MpvStartupProgress {
    static final long RETRY_MS = 50;
    private static final long WINDOW_MS = 500;
    private final long deadline;
    private double baseSeconds;

    MpvStartupProgress(long startedAt, long positionMs) {
        deadline = startedAt + WINDOW_MS;
        baseSeconds = positionMs / 1000.0;
    }

    boolean maySample(long now, boolean eligible) {
        return eligible && now < deadline;
    }

    boolean advanced(Double seconds, boolean coreRunning) {
        if (seconds == null || Double.isNaN(seconds) || Double.isInfinite(seconds) || seconds < 0) return false;
        // Match the WebView's progress gate, including timestamp correction
        // around a resume seek. A nonzero resume position alone is not proof.
        boolean advanced = seconds > baseSeconds + .001;
        baseSeconds = seconds;
        return advanced && coreRunning;
    }
}
