package rocks.aston.hongguotv;

/** Pure geometry shared by optional Surface capture; never changes player bounds. */
final class PortraitBackdropGeometry {
    static int[] crop(int width, int height, double aspect) {
        if (width < 2 || height < 2 || Double.isNaN(aspect) || Double.isInfinite(aspect) || aspect <= 0 || aspect >= 1) return null;
        int w = Math.max(1, Math.min(width, (int) Math.round(height * aspect)));
        int h = Math.max(1, Math.min(height, (int) Math.round(width / aspect)));
        int left = (width - w) / 2, top = (height - h) / 2;
        return new int[]{left, top, left + w, top + h};
    }
    static boolean validRequest(String id, String ticket) {
        return id != null && id.matches("[A-Za-z0-9_-]{1,80}") && ticket != null && ticket.matches("[0-9]{1,16}");
    }
}
