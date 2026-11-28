package rocks.aston.hongguotv;

/** A manual route choice is independent of decoder and learned fallback preferences. */
final class PlaybackRoutePreferencePolicy {
    private PlaybackRoutePreferencePolicy() {}

    static boolean valid(String mode) {
        return "auto".equals(mode) || "media3".equals(mode);
    }

    static String normalize(String mode) {
        return valid(mode) ? mode : "auto";
    }

    static boolean supported(String engine, boolean available) {
        return available && "webview_media3".equals(engine);
    }

    static boolean primary(String engine, boolean available, String mode) {
        return supported(engine, available) && "media3".equals(mode);
    }
}
