package rocks.aston.hongguotv;

final class TvViewportPolicy {
    private TvViewportPolicy() {}

    static int targetWidth(boolean television, int surfaceWidthPx, int surfaceHeightPx,
                           int densityDpi, int logicalWidthDp, int logicalHeightDp) {
        if (!television || surfaceWidthPx < 1800 || surfaceWidthPx >= 3000
                || surfaceHeightPx < 1000 || densityDpi < 300
                || logicalWidthDp <= 0 || logicalWidthDp > 1000
                || logicalHeightDp <= 0 || logicalHeightDp > 600) return 0;
        return 1280;
    }
}
