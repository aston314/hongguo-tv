package rocks.aston.hongguotv;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.Map;
import java.util.UUID;

public class CoreService extends Service {
    private static final String CHANNEL_ID = "hongguo_tv_core";
    private static final int NOTIFICATION_ID = 8797;
    private volatile Process process;
    private Thread logThread;
    private static volatile CoreEndpoint endpoint;
    private static volatile String startupError;
    private static volatile boolean startRequested;

    static CoreEndpoint endpoint() { return endpoint; }
    static String startupError() { return startRequested ? null : startupError; }

    static void prepareStart() { startupError = null; startRequested = true; }

    @Override
    public void onCreate() {
        super.onCreate();
        endpoint = null;
        startupError = null;
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat();
        startProcess();
        startRequested = false;
        // The core is owned by the foreground app session. Android must not
        // recreate it after the user exits the app or the process is killed.
        // MainActivity explicitly stops this service on confirmed exit, while
        // -parent-pid remains the last-resort orphan guard for the Go child.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Removing the app task is an explicit user-level close on TV launchers.
        // Stop the service so the Go core cannot remain as a background process.
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public synchronized void onDestroy() {
        endpoint = null;
        if (process != null) {
            process.destroy();
            process = null;
        }
        if (logThread != null) {
            logThread.interrupt();
            logThread = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private synchronized void startProcess() {
        if (process != null) {
            try {
                process.exitValue();
            } catch (IllegalThreadStateException running) {
                return;
            }
        }
        endpoint = null;
        startupError = null;
        try {
            File binary = new File(getApplicationInfo().nativeLibraryDir, "libhongguotv.so");
            if (!binary.exists()) {
                Log.e("HongguoTv", "core binary missing: " + binary.getAbsolutePath());
                startupError = "应用文件不完整，请重新安装";
                return;
            }
            String instanceId = UUID.randomUUID().toString();
            ProcessBuilder builder = new ProcessBuilder(binary.getAbsolutePath(), "-port", "0",
                    "-instance-id", instanceId, "-parent-pid", String.valueOf(android.os.Process.myPid()))
                    .redirectErrorStream(true);
            // Android may expose /data/local/tmp as os.TempDir to the native
            // process.  Point the embedded MiniReel cache at the app-private
            // cache directory so CENC-cleared MP4 files are writable and can
            // be reclaimed by Android when storage pressure occurs.
            File playbackCache = new File(getCacheDir(), "minireel");
            Map<String, String> environment = builder.environment();
            environment.put("MINIREEL_CACHE_DIR", playbackCache.getAbsolutePath());
            // User records must survive Android reclaiming the media cache.
            environment.put("HONGGUO_TV_DATA_DIR", new File(getFilesDir(), "hongguo-tv").getAbsolutePath());
            process = builder.start();
            consumeLogs(process, instanceId);
        } catch (Exception error) {
            startupError = "本机服务启动失败，请重试";
            Log.e("HongguoTv", "failed to start core", error);
        }
    }

    private void consumeLogs(final Process running, final String instanceId) {
        logThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(running.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    CoreEndpoint ready = CoreEndpoint.fromReadyLine(line, instanceId);
                    if (ready != null) {
                        synchronized (CoreService.this) {
                            if (process == running) endpoint = ready;
                        }
                    } else Log.i("HongguoTv", line);
                }
            } catch (Exception ignored) {
            } finally {
                synchronized (CoreService.this) {
                    if (process == running) {
                        endpoint = null;
                        startupError = "本机服务已停止，请重试";
                    }
                }
            }
        }, "hongguo-tv-core-log");
        logThread.start();
    }

    private void startForegroundCompat() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = builder
                .setSmallIcon(R.drawable.ic_stat_core)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(getString(R.string.notification_running))
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, notification);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, getString(R.string.app_name), NotificationManager.IMPORTANCE_LOW);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }
}
