package rocks.aston.hongguotv;

/** Bounds automatic hardware recovery to evidence that points at decoding. */
final class MpvFallbackPolicy {
    private MpvFallbackPolicy() {}

    static boolean canRetryInSoftware(MpvDecodeMode mode, boolean alreadyFallback,
                                      boolean hardware, String reason) {
        return canRetryInSoftware(mode, alreadyFallback, hardware, reason, false);
    }

    static boolean canRetryInSoftware(MpvDecodeMode mode, boolean alreadyFallback,
                                      boolean hardware, String reason, boolean videoDecodeError) {
        if (mode != MpvDecodeMode.AUTOMATIC || alreadyFallback || !hardware || reason == null) return false;
        return "known_broken_profile".equals(reason)
            || "green_frame".equals(reason)
            || "decode_stall".equals(reason)
            || videoDecodeError && ("media".equals(reason) || "native_event".equals(reason));
    }
}
