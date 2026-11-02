package rocks.aston.hongguotv;

/** Keep unsupported codecs out while allowing the fallback to use device HEVC decoders. */
final class PlaybackCodecPolicy {
    private PlaybackCodecPolicy() {}
    static boolean allowsDecoder(String mime) {
        return mime != null && (!mime.startsWith("video/") || "video/avc".equals(mime) || "video/hevc".equals(mime));
    }
    static boolean platformSoftware(String name) {
        if (name == null) return false;
        String value = name.toLowerCase(java.util.Locale.ROOT);
        return value.startsWith("omx.google.") || value.startsWith("c2.android.")
            || value.startsWith("c2.google.");
    }
    static boolean shouldRetryHevcSoftwareFallback(boolean selectedHevcExceedsCapabilities,
            boolean firstFrameRendered, boolean alreadyTried) {
        return selectedHevcExceedsCapabilities && !firstFrameRendered && !alreadyTried;
    }
    static boolean excludesDecoderForSoftwareHevc(boolean forceSoftwareHevc, String mime, String name) {
        return forceSoftwareHevc && "video/hevc".equals(mime) && !platformSoftware(name);
    }
    static boolean preferSoftware(String mime, int sdk) {
        // Android 9 and earlier TV firmwares commonly expose an HEVC hardware
        // decoder that advances audio/clock but presents black video frames.
        // Prefer the platform software decoder there, while still allowing a
        // hardware decoder when no software implementation is advertised.
        return "video/hevc".equals(mime) && sdk >= 24 && sdk <= 28;
    }
    static boolean allowsInMode(String mime, String name, boolean compatibility) {
        if (!allowsDecoder(mime)) return false;
        boolean affected = "video/avc".equals(mime) || "audio/mp4a-latm".equals(mime);
        // Media3 assumes ALL audio decoders are software-only below API 29.
        // That flag cannot distinguish an OEM AAC implementation from Android's.
        return !compatibility || !affected || platformSoftware(name);
    }
    static boolean pcmAudio(boolean compatibility, boolean live, int sdk) {
        return compatibility || !live && sdk <= 23;
    }
    static String failureKind(int code) {
        if (code >= 2000 && code < 3000) return "network";
        if (code >= 4000 && code < 5000) return "decoder";
        return "source";
    }
}
