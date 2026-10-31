package rocks.aston.hongguotv;

/** A bounded burst to confirm a new frame's media clock, then return to normal polling. */
final class StartupProgress {
    private long frameAt = -1, position = -1, advancedAt = -1;
    private boolean fast;
    void reset() { frameAt = position = advancedAt = -1; fast = false; }
    void begin(long now, long mediaPosition, boolean enabled) {
        frameAt = now; position = mediaPosition; advancedAt = -1; fast = enabled;
    }
    boolean observe(long mediaPosition, long now, boolean running) {
        if (frameAt < 0 || advancedAt >= 0 || !running || now < frameAt || mediaPosition <= position + 1) return false;
        advancedAt = now;
        return true;
    }
    long delayMs(long now, boolean running) {
        return fast && frameAt >= 0 && advancedAt < 0 && running && now >= frameAt && now - frameAt < 1000 ? 50 : 500;
    }
    long advancedAt() { return advancedAt; }
}
