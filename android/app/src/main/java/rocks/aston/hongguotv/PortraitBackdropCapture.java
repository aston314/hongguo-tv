package rocks.aston.hongguotv;

import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.SurfaceView;
import android.webkit.WebView;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;

/** Optional, pull-only artwork capture. No player commands or Surface resizing. */
final class PortraitBackdropCapture {
    interface Guard { boolean valid(); }
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WebView web;
    private HandlerThread thread;
    private Handler worker;
    private boolean busy, destroyed;
    private long lastRequest = -1000;

    PortraitBackdropCapture(WebView web) { this.web = web; }
    static boolean supported() { return Build.VERSION.SDK_INT >= 26; }

    // Called on the main thread. Keep busy until both copy and encoding finish,
    // even when the caller's session has already been replaced or cancelled.
    void request(SurfaceView surface, String id, String ticket, double aspect, Guard guard) {
        if (!supported() || destroyed || busy || !PortraitBackdropGeometry.validRequest(id, ticket) || !guard.valid()) return;
        long now = SystemClock.uptimeMillis();
        if (now - lastRequest < 950 || surface == null || !surface.getHolder().getSurface().isValid()) return;
        int[] crop = PortraitBackdropGeometry.crop(surface.getHolder().getSurfaceFrame().width(), surface.getHolder().getSurfaceFrame().height(), aspect);
        if (crop == null) return;
        lastRequest = now;
        busy = true;
        Bitmap bitmap = null;
        try {
            int height = 192, width = Math.max(1, (int) Math.round(height * aspect));
            bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            copy(surface, new Rect(crop[0], crop[1], crop[2], crop[3]), bitmap, id, ticket, aspect, guard);
        } catch (RuntimeException | OutOfMemoryError failure) {
            if (bitmap != null) bitmap.recycle();
            busy = false;
        }
    }

    // This class/method is touched only after the API gate above. The Bitmap
    // remains alive until PixelCopy calls back; cancellation never recycles it.
    @android.annotation.TargetApi(26)
    private void copy(SurfaceView surface, Rect rect, Bitmap bitmap, String id, String ticket, double aspect, Guard guard) {
        android.view.PixelCopy.request(surface, rect, bitmap, result -> {
            if (result != android.view.PixelCopy.SUCCESS || destroyed || !guard.valid()) {
                bitmap.recycle(); busy = false; reply(id, ticket, "", aspect, guard); return;
            }
            try {
                if (worker == null) {
                    thread = new HandlerThread("portrait-artwork", android.os.Process.THREAD_PRIORITY_BACKGROUND); thread.start(); worker = new Handler(thread.getLooper());
                }
                if (!worker.post(() -> encode(bitmap, id, ticket, aspect, guard))) { bitmap.recycle(); busy = false; }
            } catch (RuntimeException | OutOfMemoryError failure) { bitmap.recycle(); busy = false; }
        }, main);
    }

    private void encode(Bitmap bitmap, String id, String ticket, double aspect, Guard guard) {
        String encoded = "";
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (bitmap.compress(Bitmap.CompressFormat.JPEG, 55, bytes) && bytes.size() <= 100000)
                encoded = "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
        } catch (RuntimeException | OutOfMemoryError ignored) {
            // Decoration is disposable. Never fail the media session.
        } finally { bitmap.recycle(); }
        final String data = encoded;
        main.post(() -> { busy = false; reply(id, ticket, data, aspect, guard); });
    }

    private void reply(String id, String ticket, String data, double aspect, Guard guard) {
        if (destroyed || !guard.valid()) return;
        try { web.evaluateJavascript("window.HongguoPortraitBackdropReceive&&window.HongguoPortraitBackdropReceive("
            + JSONObject.quote(id) + "," + JSONObject.quote(ticket) + "," + JSONObject.quote(data) + "," + aspect + ")", null);
        } catch (RuntimeException ignored) { /* An optional decoration never fails playback. */ }
    }

    void close() {
        destroyed = true;
        // quitSafely lets an already queued encoder recycle its own bitmap.
        if (thread != null) thread.quitSafely();
        thread = null; worker = null;
    }
}
