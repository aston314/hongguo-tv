package rocks.aston.hongguotv;

/** Pure thresholds for deciding when an automatic hardware path cannot keep up. */
final class MpvDecodeStallPolicy {
    static final long WINDOW_MS = 5000;
    static final long MIN_DROPS_PER_WINDOW = 30;
    static final int REQUIRED_STRIKES = 2;

    private MpvDecodeStallPolicy() {}

    static boolean shouldSample(boolean outputReady, boolean background, boolean paused,
                                boolean terminal, boolean automatic, boolean hardware,
                                boolean intentionalSpeedUp) {
        return outputReady && !background && !paused && !terminal && automatic && hardware
            && !intentionalSpeedUp;
    }

    static boolean heavy(long drops) {
        return drops >= MIN_DROPS_PER_WINDOW;
    }

    static boolean heavy(long drops, long elapsedMs) {
        return elapsedMs >= WINDOW_MS && drops >= 0
            && drops * WINDOW_MS >= MIN_DROPS_PER_WINDOW * elapsedMs;
    }

    static boolean shouldFallback(MpvDecodeMode mode, boolean softwareFallback,
                                  boolean hardware, int strikes) {
        return mode == MpvDecodeMode.AUTOMATIC && !softwareFallback && hardware
            && strikes >= REQUIRED_STRIKES;
    }
}
