package rocks.aston.hongguotv;

/** MPV readiness is an output configuration signal, not a physical first-frame callback. */
final class MpvOutputState {
    boolean openRequested, loaded, attached, restarted, configured, coreIdle = true;
    boolean endFileSeen;
    int endFileReason = -1, endFileError;
    int width, height, surfaceWidth, surfaceHeight;
    String vo = "";
    private final int[] messages = new int[4];

    boolean ready(boolean surfaceValid) {
        return loaded && attached && surfaceValid && restarted && configured && "gpu".equals(vo)
            && width > 0 && height > 0 && surfaceWidth > 0 && surfaceHeight > 0;
    }

    void message(int component, int level) {
        if (component < 1 || component > messages.length || level < 10 || level > 30) return;
        int index = component - 1;
        if (messages[index] == 0 || level < messages[index]) messages[index] = level;
    }

    String messages() {
        String[] names = {"视频输出", "音频输出", "视频解码", "音频解码"};
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < messages.length; i++) {
            if (messages[i] == 0) continue;
            if (result.length() > 0) result.append(" · ");
            result.append(names[i]).append(messages[i] <= 20 ? "错误" : "警告");
        }
        return result.toString();
    }
}
