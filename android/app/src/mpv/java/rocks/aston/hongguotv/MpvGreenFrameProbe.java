package rocks.aston.hongguotv;

import android.annotation.TargetApi;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.PixelCopy;
import android.view.SurfaceView;

/** Bounded API 26+ Surface sampling; failures are disposable and never fail playback. */
final class MpvGreenFrameProbe {
    private static final long PIXEL_COPY_TIMEOUT_MS = 2000;
    interface Guard { boolean valid(); }
    interface Listener { void onSample(boolean success, boolean green, int probeNumber); }

    private final Handler main = new Handler(Looper.getMainLooper());
    private long generation;
    private long requestSequence;
    private long activeRequest;
    private boolean inFlight;
    private Runnable pending;
    private Runnable copyTimeout;
    private int probes;

    static boolean supported() { return Build.VERSION.SDK_INT >= 26; }

    void start(SurfaceView surface, Guard guard, Listener listener) {
        cancel();
        if (!supported() || surface == null || guard == null || listener == null || !guard.valid()) return;
        final long token = ++generation;
        probes = 0;
        schedule(surface, guard, listener, token, MpvGreenFramePolicy.FIRST_PROBE_DELAY_MS);
    }

    void cancel() {
        generation++;
        if (pending != null) main.removeCallbacks(pending);
        if (copyTimeout != null) main.removeCallbacks(copyTimeout);
        pending = null;
        copyTimeout = null;
        activeRequest = 0;
        inFlight = false;
        probes = 0;
    }

    @TargetApi(26)
    private void schedule(SurfaceView surface, Guard guard, Listener listener, long token, long delay) {
        Runnable next = () -> request(surface, guard, listener, token);
        pending = next;
        main.postDelayed(next, delay);
    }

    @TargetApi(26)
    private void request(SurfaceView surface, Guard guard, Listener listener, long token) {
        pending = null;
        if (token != generation || !guard.valid() || probes >= MpvGreenFramePolicy.MAX_PROBES) return;
        if (inFlight) {
            schedule(surface, guard, listener, token, MpvGreenFramePolicy.PROBE_INTERVAL_MS);
            return;
        }
        if (!surface.getHolder().getSurface().isValid()) return;
        Rect frame = surface.getHolder().getSurfaceFrame();
        if (frame.width() < 2 || frame.height() < 2) return;
        Bitmap bitmap;
        try {
            bitmap = Bitmap.createBitmap(160, 90, Bitmap.Config.ARGB_8888);
        } catch (RuntimeException | OutOfMemoryError ignored) {
            return;
        }
        inFlight = true;
        probes++;
        final long request = ++requestSequence;
        activeRequest = request;
        copyTimeout = () -> {
            if (activeRequest != request) return;
            activeRequest = 0;
            inFlight = false;
            copyTimeout = null;
            if (token == generation && guard.valid() && probes < MpvGreenFramePolicy.MAX_PROBES)
                schedule(surface, guard, listener, token, MpvGreenFramePolicy.PROBE_INTERVAL_MS);
        };
        main.postDelayed(copyTimeout, PIXEL_COPY_TIMEOUT_MS);
        try {
            PixelCopy.request(surface, new Rect(0, 0, frame.width(), frame.height()), bitmap, result -> {
                boolean active = activeRequest == request;
                if (active) {
                    activeRequest = 0;
                    inFlight = false;
                    if (copyTimeout != null) main.removeCallbacks(copyTimeout);
                    copyTimeout = null;
                }
                boolean current = active && token == generation && guard.valid();
                if (!current) {
                    bitmap.recycle();
                    return;
                }
                boolean success = result == PixelCopy.SUCCESS;
                try {
                    boolean green = success && isBroken(bitmap);
                    listener.onSample(success, green, probes);
                } catch (RuntimeException | OutOfMemoryError ignored) {
                    // A failed optional sample must not affect the player loop.
                } finally {
                    bitmap.recycle();
                }
                if (token == generation && guard.valid() && probes < MpvGreenFramePolicy.MAX_PROBES)
                    schedule(surface, guard, listener, token, MpvGreenFramePolicy.PROBE_INTERVAL_MS);
            }, main);
        } catch (RuntimeException | OutOfMemoryError ignored) {
            if (activeRequest == request) {
                activeRequest = 0;
                inFlight = false;
                if (copyTimeout != null) main.removeCallbacks(copyTimeout);
                copyTimeout = null;
            }
            bitmap.recycle();
            if (token == generation && guard.valid() && probes < MpvGreenFramePolicy.MAX_PROBES)
                schedule(surface, guard, listener, token, MpvGreenFramePolicy.PROBE_INTERVAL_MS);
        }
    }

    private static boolean isBroken(Bitmap bitmap) {
        if (bitmap == null || bitmap.isRecycled()) return false;
        try {
            int[] pixels = new int[bitmap.getWidth() * bitmap.getHeight()];
            bitmap.getPixels(pixels, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight());
            return MpvGreenFramePolicy.isBrokenFrame(pixels);
        } catch (RuntimeException | OutOfMemoryError ignored) { return false; }
    }
}
