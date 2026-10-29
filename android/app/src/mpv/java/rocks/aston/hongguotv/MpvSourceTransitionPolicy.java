package rocks.aston.hongguotv;

/** Limits in-place source replacement to a healthy software-decoded session. */
final class MpvSourceTransitionPolicy {
    private MpvSourceTransitionPolicy() {}

    static boolean mayReplaceInPlace(MpvDecodeMode currentMode, MpvDecodeMode nextMode,
                                     boolean currentSessionReady, boolean samePlayerAndSurface,
                                     boolean stopFenceActive, boolean background) {
        return currentMode == MpvDecodeMode.SOFTWARE
            && nextMode == MpvDecodeMode.SOFTWARE
            && currentSessionReady
            && samePlayerAndSurface
            && !stopFenceActive
            && !background;
    }
}
