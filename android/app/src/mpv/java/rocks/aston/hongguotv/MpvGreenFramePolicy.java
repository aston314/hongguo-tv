package rocks.aston.hongguotv;

/** Conservative detector for vendor decoders that output a solid green frame without an error. */
final class MpvGreenFramePolicy {
    static final int REQUIRED_GREEN_STREAK = 2;
    static final int MAX_PROBES = 6;
    static final long FIRST_PROBE_DELAY_MS = 1500;
    static final long PROBE_INTERVAL_MS = 1300;

    private MpvGreenFramePolicy() {}

    static boolean isBrokenFrame(int[] pixels) {
        if (pixels == null || pixels.length == 0) return false;
        int green = 0;
        for (int pixel : pixels) {
            int red = (pixel >> 16) & 0xff;
            int greenChannel = (pixel >> 8) & 0xff;
            int blue = pixel & 0xff;
            if (greenChannel >= 220 && red <= 36 && blue <= 36) green++;
        }
        return green * 100 >= pixels.length * 99;
    }

    static int nextStreak(int current, boolean broken) {
        return broken ? current + 1 : 0;
    }

    static boolean shouldFallback(int streak) {
        return streak >= REQUIRED_GREEN_STREAK;
    }
}
