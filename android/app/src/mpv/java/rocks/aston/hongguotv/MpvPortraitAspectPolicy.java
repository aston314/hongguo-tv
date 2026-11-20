package rocks.aston.hongguotv;

/** Repairs the reported HEVC height clamp, without guessing a missing source ratio. */
final class MpvPortraitAspectPolicy {
    static final int MAX_CHECKS = 10;

    private MpvPortraitAspectPolicy() {}

    static String hwdec(String model, MpvDecodeMode mode, boolean softwareFallback) {
        if (softwareFallback) return "no";
        // Only this preference is device-specific; the geometry repair is not.
        if (mode == MpvDecodeMode.AUTOMATIC && "MiTV4-ANSM0".equals(model))
            return "mediacodec-copy";
        return mode.hwdec;
    }

    static boolean eligible(MpvDecodeMode mode, boolean softwareFallback) {
        return mode == MpvDecodeMode.AUTOMATIC && !softwareFallback;
    }

    static boolean clamped(int width, int height) {
        return (width == 720 || width == 1080) && height == 1088;
    }

    static String override(String hardware, String codec, int decodedWidth, int decodedHeight,
                           int sourceWidth, int sourceHeight, int rotation, Double pixelAspect) {
        if (!("mediacodec".equals(hardware) || "mediacodec-copy".equals(hardware))
                || !"hevc".equalsIgnoreCase(codec) || !clamped(decodedWidth, decodedHeight)) return "";
        // Container metadata must independently establish the portrait source.
        // A real 720x1088/1080x1088 source, missing metadata, rotated video or
        // anamorphic pixels is not evidence of this decoder fault.
        if (sourceWidth != decodedWidth || sourceHeight <= Math.max(sourceWidth, decodedHeight)
                || sourceHeight > 4096 || rotation % 360 != 0) return "";
        if (pixelAspect != null && (Double.isNaN(pixelAspect) || Double.isInfinite(pixelAspect)
                || Math.abs(pixelAspect - 1.0) > 0.001)) return "";
        return sourceWidth + ":" + sourceHeight;
    }

    static boolean useCachedDecodeFailure(boolean knownBroken, boolean aspectCorrected) {
        // Give the corrected output a fresh green-frame/stall probe. Actual
        // decode errors still use the ordinary software-recovery policy.
        return knownBroken && !aspectCorrected;
    }
}
