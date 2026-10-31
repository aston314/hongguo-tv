package rocks.aston.hongguotv;

import java.util.LinkedHashSet;
import java.util.Set;

/** Remembers narrowly identified profiles whose automatic hardware path produced a bad frame. */
final class MpvDecodeMemory {
    static final String STORAGE_KEY = "mpv_hwdec_broken_profiles";
    private static final int MAX_PROFILES = 8;
    private static final String PROFILE_PATTERN = "[a-z0-9_.-]{1,40}:[a-z0-9_.-]{1,40}:[0-9]{1,5}x[0-9]{1,5}";
    private final Set<String> broken = new LinkedHashSet<>();

    MpvDecodeMemory(String stored) {
        if (stored == null) return;
        for (String profile : stored.split(";")) {
            String normalized = normalizeProfile(profile);
            if (!normalized.isEmpty() && broken.size() < MAX_PROFILES) broken.add(normalized);
        }
    }

    static String profile(String codec, String pixelFormat, int width, int height) {
        String normalizedCodec = normalizeAtom(codec);
        String normalizedFormat = normalizeAtom(pixelFormat);
        if (normalizedCodec.isEmpty() || normalizedFormat.isEmpty()
                || width < 1 || width > 8192 || height < 1 || height > 8192) return "";
        String value = normalizedCodec + ":" + normalizedFormat + ":" + width + "x" + height;
        return value.matches(PROFILE_PATTERN) ? value : "";
    }

    private static String normalizeAtom(String value) {
        if (value == null) return "";
        String normalized = value.trim().toLowerCase(java.util.Locale.ROOT);
        return normalized.matches("[a-z0-9_.-]{1,40}") ? normalized : "";
    }

    private static String normalizeProfile(String value) {
        if (value == null) return "";
        String normalized = value.trim().toLowerCase(java.util.Locale.ROOT);
        return normalized.matches(PROFILE_PATTERN) ? normalized : "";
    }

    boolean isBroken(String profile) {
        String normalized = normalizeProfile(profile);
        return !normalized.isEmpty() && broken.contains(normalized);
    }

    boolean learn(String profile) {
        String normalized = normalizeProfile(profile);
        if (normalized.isEmpty()) return false;
        if (broken.contains(normalized)) return false;
        if (broken.size() >= MAX_PROFILES) return false;
        return broken.add(normalized);
    }

    void clear() { broken.clear(); }

    String store() {
        StringBuilder result = new StringBuilder();
        for (String profile : broken) {
            if (result.length() > 0) result.append(';');
            result.append(profile);
        }
        return result.toString();
    }
}
