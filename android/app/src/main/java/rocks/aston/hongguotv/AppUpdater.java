package rocks.aston.hongguotv;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PackageInstaller;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Button;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Native update transport and installation. No repository credentials enter the APK. */
final class AppUpdater {
    private static final int SAVE_APK_PERMISSION = 20401;
    interface Host {
        boolean trusted();
        boolean foreground();
        void restoreFocus();
        void allowPrompt(PromptCheck check);
    }
    interface PromptCheck { void result(boolean allowed); }
    private final Activity activity;
    private final Host host;
    private final SharedPreferences preferences;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicInteger generation = new AtomicInteger();
    private final File directory, partial, apk;
    private volatile HttpURLConnection connection;
    private volatile boolean destroyed;
    private volatile String snapshot = "{}";
    private boolean started, checking, downloading, promptAllowed, manualPrompt, promptCheckPending;
    private Manifest latest;
    private String state = "idle", message = "";
    private long downloaded;
    private AlertDialog dialog;
    private ProgressBar progress;
    private TextView progressText;
    private volatile int verifiedApkCode;
    private boolean cacheCheckComplete, pendingInstallResume;
    private boolean installResultReceiverRegistered;
    private boolean savingApk;
    private volatile boolean saveCancelled;
    private Manifest pendingSavePermission;
    private final BroadcastReceiver installResultReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { handleInstallResult(intent); }
    };

    AppUpdater(Activity activity, Host host) {
        this.activity = activity; this.host = host;
        preferences = activity.getSharedPreferences("HongguoTVUpdates", Activity.MODE_PRIVATE);
        directory = new File(activity.getCacheDir(), "app-updates");
        partial = new File(directory, "update.part"); apk = new File(directory, "update.apk");
        try { latest = new Manifest(new JSONObject(preferences.getString("manifest", "{}")), activity.getPackageName()); }
        catch (Exception invalid) { latest = null; }
        if (latest != null && latest.code > BuildConfig.VERSION_CODE && latest.minSdk <= Build.VERSION.SDK_INT) state = "available";
        IntentFilter installResultFilter = new IntentFilter(UpdateInstallReceiver.ACTION_RESULT);
        ContextCompat.registerReceiver(activity, installResultReceiver, installResultFilter, ContextCompat.RECEIVER_NOT_EXPORTED);
        installResultReceiverRegistered = true;
        publish();
    }

    private static final class Manifest {
        final int code, minSdk;
        final long bytes;
        final String name, packageName, sha256, url, notes;
        final JSONObject json;
        Manifest(JSONObject json, String installedPackage) throws Exception {
            if (json.getInt("schema") != 1) throw new IOException("不支持的版本信息格式");
            this.json = json;
            code = json.getInt("version_code"); minSdk = json.getInt("min_sdk");
            name = json.getString("version_name"); packageName = json.getString("package_name");
            bytes = json.getLong("size"); sha256 = json.getString("sha256").toLowerCase(java.util.Locale.ROOT);
            url = json.getString("download_url"); notes = json.optString("release_notes", "");
            UpdatePolicy.validateVariant(BuildConfig.VARIANT_ID, json.optString("variant", ""), packageName, minSdk);
            UpdatePolicy.validate(packageName, code, name, minSdk, bytes, sha256, url, installedPackage, BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME);
            if (notes.length() > 16000) throw new IOException("版本说明过长");
        }
    }

    final class Bridge {
        @JavascriptInterface public String getStatus() { return host.trusted() ? snapshot : "{}"; }
        @JavascriptInterface public void check() { if (host.trusted()) activity.runOnUiThread(() -> checkNow(true)); }
        @JavascriptInterface public void install() {
            if (host.trusted()) activity.runOnUiThread(() -> {
                if (latest != null && "ready".equals(state)) launchInstaller(latest);
            });
        }
        @JavascriptInterface public void setPromptAllowed(boolean allowed) {
            if (host.trusted()) activity.runOnUiThread(() -> { promptAllowed = allowed; maybePrompt(); });
        }
    }

    void start() {
        if (started || destroyed) return;
        started = true;
        worker.execute(this::cleanupCache);
        if (BuildConfig.DEBUG) { state = "unsupported"; message = "调试版不覆盖更新，请使用正式版"; publish(); return; }
        long now = System.currentTimeMillis();
        if (UpdatePolicy.automaticCheckDue(now, preferences.getLong("last_auto_attempt", 0))) {
            preferences.edit().putLong("last_auto_attempt", now).apply();
            checkNow(false);
        }
    }

    private void cleanupCache() {
        directory.mkdirs();
        partial.delete();
        try {
            if (apk.isFile()) {
                PackageInfo info = activity.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
                if (info == null || info.versionCode <= BuildConfig.VERSION_CODE
                        || System.currentTimeMillis() - apk.lastModified() > UpdatePolicy.CHECK_INTERVAL) apk.delete();
                Manifest target = latest;
                if (apk.isFile() && target != null && apk.length() == target.bytes && info != null && info.versionCode == target.code) {
                    try {
                        if (!hash(apk).equals(target.sha256)) throw new IOException("安装包完整性校验失败");
                        verifyArchive(target, apk);
                        verifiedApkCode = target.code;
                        activity.runOnUiThread(() -> {
                            if (destroyed || latest != target || verifiedApkCode != target.code) return;
                            state = "ready"; downloaded = target.bytes; message = "更新包已验证，可继续安装"; publish();
                        });
                    } catch (Exception invalid) { apk.delete(); }
                }
            }
        } finally {
            activity.runOnUiThread(() -> {
                cacheCheckComplete = true;
                if (pendingInstallResume && !destroyed && host.foreground()) {
                    pendingInstallResume = false;
                    resume();
                }
            });
        }
    }

    private void checkNow(boolean manual) {
        if (destroyed || downloading || checking || savingApk || pendingSavePermission != null || "installing".equals(state) || BuildConfig.DEBUG
                || preferences.getBoolean("waiting_permission", false)
                || preferences.getBoolean("waiting_installer", false)) return;
        checking = true; manualPrompt = manual; state = "checking"; message = "正在检查更新…"; publish();
        final int epoch = generation.incrementAndGet();
        worker.execute(() -> {
            Manifest result = null;
            String error = "暂时无法连接更新服务，请稍后重试";
            String origin = UpdatePolicy.manifestUrl(BuildConfig.VARIANT_ID) + "?check=" + System.currentTimeMillis();
            for (String source : UpdatePolicy.sources(origin)) {
                if (!valid(epoch)) return;
                try {
                    result = new Manifest(new JSONObject(readManifest(source, epoch)), activity.getPackageName());
                    break;
                } catch (Exception failure) { error = friendly(failure); }
            }
            final Manifest response = result;
            final String failure = error;
            activity.runOnUiThread(() -> {
                if (!valid(epoch)) return;
                checking = false;
                if (response == null) { state = "error"; message = "检查失败：" + failure; publish(); return; }
                latest = response;
                preferences.edit().putString("manifest", response.json.toString()).apply();
                if (response.minSdk > Build.VERSION.SDK_INT) { state = "incompatible"; message = "新版本需要更高版本的 Android"; }
                else if (response.code > BuildConfig.VERSION_CODE && verifiedApkCode == response.code) { state = "ready"; message = "更新包已验证，可继续安装"; }
                else if (response.code > BuildConfig.VERSION_CODE) { state = "available"; message = "发现新版本 " + response.name; }
                else { state = "current"; message = "已是最新版本"; }
                publish(); maybePrompt();
            });
        });
    }

    private String readManifest(String source, int epoch) throws Exception {
        HttpURLConnection request = open(source, epoch);
        try (InputStream stream = request.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = stream.read(buffer)) != -1) {
                ensureValid(epoch);
                if (output.size() + count > 65536) throw new IOException("版本信息超过大小限制");
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        } finally { request.disconnect(); if (connection == request) connection = null; }
    }

    private HttpURLConnection open(String source, int epoch) throws Exception {
        URL url = new URL(source);
        for (int redirect = 0; redirect < 6; redirect++) {
            ensureValid(epoch);
            if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null) throw new IOException("更新连接必须使用 HTTPS");
            HttpURLConnection request = (HttpURLConnection) url.openConnection();
            connection = request;
            request.setConnectTimeout(8000); request.setReadTimeout(15000);
            request.setInstanceFollowRedirects(false); request.setUseCaches(false);
            request.setRequestProperty("Cache-Control", "no-cache");
            request.setRequestProperty("Accept-Encoding", "identity");
            request.setRequestProperty("User-Agent", "HongguoTV/" + BuildConfig.VERSION_NAME);
            int code;
            try { code = request.getResponseCode(); }
            catch (Exception failure) { request.disconnect(); throw failure; }
            ensureValid(epoch);
            if (code >= 300 && code <= 399) {
                String location = request.getHeaderField("Location"); request.disconnect();
                if (location == null) throw new IOException("下载重定向缺少地址");
                url = new URL(url, location); continue;
            }
            if (code != 200) { request.disconnect(); throw new IOException("更新服务返回 HTTP " + code); }
            return request;
        }
        throw new IOException("更新连接重定向次数过多");
    }

    private boolean canShow() {
        return !destroyed && host.foreground() && host.trusted() && promptAllowed
                && !activity.isFinishing() && !activity.isDestroyed() && dialog == null;
    }

    private void maybePrompt() {
        if (!"available".equals(state) || latest == null || !canShow() || promptCheckPending) return;
        if (!manualPrompt && preferences.getInt("dismissed_code", 0) >= latest.code) return;
        final Manifest target = latest;
        promptCheckPending = true;
        host.allowPrompt(allowed -> {
            promptCheckPending = false;
            if (!allowed || !canShow() || target != latest || !"available".equals(state)) return;
            manualPrompt = false;
            AlertDialog prompt = new AlertDialog.Builder(activity).setTitle("发现新版本 " + target.name)
                .setMessage((target.notes.isEmpty() ? "红果短剧有新版本可以安装。" : target.notes) + "\n\n覆盖升级保留账号和记录。")
                .setNegativeButton("稍后", (d, which) -> defer(target))
                .setPositiveButton("立即更新", (d, which) -> beginDownload(target)).create();
            prompt.setOnCancelListener(d -> defer(target));
            show(prompt, AlertDialog.BUTTON_NEGATIVE);
        });
    }

    private void defer(Manifest target) {
        preferences.edit().putInt("dismissed_code", target.code).apply();
    }

    private void show(AlertDialog next, int focusButton) {
        dialog = next;
        next.setOnShowListener(d -> next.getButton(focusButton).requestFocus());
        next.setOnDismissListener(d -> {
            if (dialog == next) dialog = null;
            if (!destroyed) host.restoreFocus();
        });
        next.show();
    }

    private void beginDownload(Manifest target) {
        // The confirmation is dismissed by Android after its click listener returns.
        activity.getWindow().getDecorView().post(() -> {
            if (destroyed || downloading || savingApk || pendingSavePermission != null) return;
            if (dialog != null) { AlertDialog old = dialog; dialog = null; old.dismiss(); }
            downloading = true; downloaded = 0; state = "downloading"; message = "正在下载 " + target.name; publish();
            final int epoch = generation.incrementAndGet();
            showDownloadProgress();
            worker.execute(() -> download(target, epoch));
        });
    }

    private void showDownloadProgress() {
        LinearLayout panel = new LinearLayout(activity); panel.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * activity.getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding, padding, padding);
        progressText = new TextView(activity); progressText.setText("正在连接下载服务…"); progressText.setTextSize(17);
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100); progress.setIndeterminate(true);
        panel.addView(progressText); panel.addView(progress, new LinearLayout.LayoutParams(-1, -2));
        AlertDialog next = new AlertDialog.Builder(activity).setTitle("下载更新").setView(panel)
                .setNegativeButton("取消", (d, which) -> cancelDownload()).create();
        next.setOnCancelListener(d -> cancelDownload());
        show(next, AlertDialog.BUTTON_NEGATIVE);
    }

    private void download(Manifest target, int epoch) {
        String error = "下载暂时不可用";
        try {
            directory.mkdirs();
            if (apk.isFile() && apk.length() == target.bytes && hash(apk).equals(target.sha256)) {
                verifyArchive(target, apk); completed(target, epoch); return;
            }
            apk.delete();
            String[] sources = UpdatePolicy.sources(target.url);
            for (int sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
                String source = sources[sourceIndex];
                ensureValid(epoch);
                partial.delete();
                final boolean fallback = sourceIndex > 0;
                activity.runOnUiThread(() -> {
                    if (!valid(epoch)) return;
                    downloaded = 0; message = fallback ? "当前线路失败，正在尝试下一条更新线路…" : "正在连接更新服务…"; publish();
                    if (progress != null) progress.setIndeterminate(true);
                    if (progressText != null) progressText.setText(message);
                });
                try {
                    HttpURLConnection request = open(source, epoch);
                    try (InputStream stream = request.getInputStream()) {
                        long length = -1;
                        String lengthHeader = request.getHeaderField("Content-Length");
                        if (lengthHeader != null) length = Long.parseLong(lengthHeader);
                        if (length > 0 && length != target.bytes) throw new IOException("安装包大小不匹配");
                        UpdateFiles.copyChecked(stream, partial, target.bytes, target.sha256, new UpdateFiles.Monitor() {
                            private long lastProgress;
                            public void check() throws IOException { ensureValid(epoch); }
                            public void progress(long bytes) {
                                long now = android.os.SystemClock.elapsedRealtime();
                                if (now - lastProgress > 250) { updateProgress(bytes, target.bytes, epoch); lastProgress = now; }
                            }
                        });
                    } finally { request.disconnect(); if (connection == request) connection = null; }
                    ensureValid(epoch);
                    verifyArchive(target, partial);
                    if (!partial.renameTo(apk)) throw new IOException("无法保存更新安装包");
                    verifiedApkCode = target.code;
                    completed(target, epoch); return;
                } catch (Exception failure) { partial.delete(); error = friendly(failure); }
            }
            throw new IOException(error);
        } catch (Exception failure) {
            partial.delete();
            apk.delete();
            final String text = friendly(failure);
            activity.runOnUiThread(() -> {
                if (!valid(epoch)) return;
                downloading = false; dismissDialog(); state = "error"; message = "下载失败：" + text; publish();
                showFailure(message);
            });
        }
    }

    private void completed(Manifest target, int epoch) {
        activity.runOnUiThread(() -> {
            if (!valid(epoch)) return;
            downloading = false; downloaded = target.bytes; verifiedApkCode = target.code; state = "ready"; message = "安装包已验证，可以安装";
            latest = target; dismissDialog(); publish();
            if (host.foreground()) launchInstaller(target);
        });
    }

    private void updateProgress(long bytes, long total, int epoch) {
        activity.runOnUiThread(() -> {
            if (!valid(epoch) || !downloading) return;
            downloaded = bytes; publish();
            if (progress != null) { progress.setIndeterminate(false); progress.setProgress((int) (bytes * 100 / total)); }
            if (progressText != null) progressText.setText(String.format(java.util.Locale.ROOT,
                    "已下载 %.1f / %.1f MB · %d%%", bytes / 1048576.0, total / 1048576.0, bytes * 100 / total));
        });
    }

    private void verifyArchive(Manifest target, File file) throws Exception {
        PackageManager manager = activity.getPackageManager();
        PackageInfo archive = manager.getPackageArchiveInfo(file.getPath(), PackageManager.GET_SIGNATURES);
        PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNATURES);
        if (archive == null || !UpdatePolicy.matchingArchive(installed.packageName, installed.versionCode,
                archive.packageName, archive.versionCode, archive.versionName, target.code, target.name,
                signerHashes(installed.signatures), signerHashes(archive.signatures)))
            throw new IOException("安装包的应用、版本或签名不匹配，已停止安装");
        if (Build.VERSION.SDK_INT >= 24 && archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)
            throw new IOException("设备 Android 版本不满足安装要求");
    }

    private String[] signerHashes(Signature[] signatures) throws Exception {
        if (signatures == null) return new String[0];
        String[] result = new String[signatures.length];
        for (int i = 0; i < signatures.length; i++) result[i] = UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(signatures[i].toByteArray()));
        return result;
    }

    private String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[32768]; int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return UpdatePolicy.hex(digest.digest());
    }

    private void launchInstaller(Manifest target) {
        if (!apk.isFile() || apk.length() != target.bytes || verifiedApkCode != target.code || destroyed
                || savingApk || pendingSavePermission != null) return;
        boolean canRequestInstalls = Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls();
        String failure = "";
        for (String route : UpdateInstallPolicy.routes(
                UpdateInstallPolicy.canUsePackageInstallerSession(Build.VERSION.SDK_INT, canRequestInstalls))) {
            if (UpdateInstallPolicy.VIEW.equals(route)) {
                try {
                    launchViewInstaller(target);
                    return;
                } catch (Exception viewFailure) {
                    failure = "普通安装入口失败：" + friendly(viewFailure);
                    clearInstallerAttempt();
                }
            } else if (UpdateInstallPolicy.INSTALL_PACKAGE.equals(route)) {
                try {
                    launchPackageInstaller(target);
                    return;
                } catch (Exception packageFailure) {
                    failure += "\n备用安装入口失败：" + friendly(packageFailure);
                    clearInstallerAttempt();
                }
            } else if (UpdateInstallPolicy.SESSION.equals(route)) {
                launchSessionInstaller(target, failure);
                return;
            } else if (UpdateInstallPolicy.SETTINGS.equals(route)) {
                showInstallPermission(target, "系统安装器无法启动。" + failure + "\n请允许红果短剧安装更新后重试。");
                return;
            }
        }
    }

    private void launchSessionInstaller(Manifest target, String reason) {
        if (!apk.isFile() || apk.length() != target.bytes || verifiedApkCode != target.code || destroyed) return;
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            showInstallPermission(target, "请先允许红果短剧安装更新，再使用备用安装流程。");
            return;
        }
        rememberInstallHandoff(target, "session");
        state = "installing"; message = "正在准备备用系统安装入口…"; publish();
        worker.execute(() -> {
            try {
                installWithPackageInstaller(target);
            } catch (Exception sessionFailure) {
                preferences.edit().putBoolean("waiting_installer", false)
                        .putInt("install_status", PackageInstaller.STATUS_FAILURE)
                        .putString("install_message", "系统安装器启动失败：" + friendly(sessionFailure)).apply();
                activity.runOnUiThread(() -> {
                    if (!destroyed && latest == target) showInstallRecovery(target,
                            reason + "\n备用安装入口失败：" + friendly(sessionFailure));
                });
            }
        });
    }

    void resume() {
        if (destroyed) return;
        int targetCode = preferences.getInt("install_target_code", 0);
        if (targetCode <= 0) { publish(); return; }
        if (BuildConfig.VERSION_CODE >= targetCode) {
            clearInstallHandoff();
            state = "current"; message = "更新已安装"; publish(); return;
        }
        Manifest target = latest != null && latest.code == targetCode ? latest : null;
        if (target == null || !apk.isFile() || apk.length() != target.bytes) {
            preferences.edit().putBoolean("waiting_permission", false).putBoolean("waiting_installer", false).apply();
            message = "已下载的更新包不可用，请重新检查更新"; publish(); return;
        }
        if (!cacheCheckComplete || verifiedApkCode != target.code) {
            pendingInstallResume = true;
            return;
        }
        if (preferences.getBoolean("waiting_permission", false)) {
            preferences.edit().putBoolean("waiting_permission", false).apply();
            if (Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls()) {
                launchInstaller(target);
            } else {
                showInstallRecovery(target, "安装权限尚未开启。已验证的安装包仍保留，可继续授权或重试。");
            }
            return;
        }
        if (preferences.getBoolean("waiting_installer", false)) {
            int status = preferences.getInt("install_status", Integer.MIN_VALUE);
            String detail = preferences.getString("install_message", "");
            preferences.edit().putBoolean("waiting_installer", false).remove("install_status").remove("install_message").apply();
            String reason = status == Integer.MIN_VALUE || status == PackageInstaller.STATUS_PENDING_USER_ACTION
                    ? "系统安装尚未完成。安装包已保留，可再次打开安装界面。"
                    : UpdateInstallStatus.message(status, detail);
            showInstallRecovery(target, reason);
            return;
        }
        consumeInstallerResult();
        publish();
    }

    private void handleInstallResult(Intent intent) {
        if (intent == null) return;
        int targetCode = intent.getIntExtra(UpdateInstallReceiver.EXTRA_TARGET_CODE, 0);
        int status = intent.getIntExtra(UpdateInstallReceiver.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String detail = intent.getStringExtra(UpdateInstallReceiver.EXTRA_STATUS_MESSAGE);
        if (targetCode <= 0 || status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                state = "installing"; message = "等待系统确认安装…"; publish();
            }
            return;
        }
        handleTerminalInstallResult(targetCode, status, detail);
    }

    private void consumeInstallerResult() {
        int status = preferences.getInt("install_status", Integer.MIN_VALUE);
        if (status == Integer.MIN_VALUE) return;
        int targetCode = preferences.getInt("install_target_code", 0);
        String detail = preferences.getString("install_message", "");
        preferences.edit().remove("install_status").remove("install_message").putBoolean("waiting_installer", false).apply();
        handleTerminalInstallResult(targetCode, status, detail);
    }

    private void handleTerminalInstallResult(int targetCode, int status, String detail) {
        if (status == PackageInstaller.STATUS_SUCCESS) {
            clearInstallHandoff(); state = "current"; message = "更新已安装"; publish(); return;
        }
        if (latest == null || latest.code != targetCode) return;
        state = "ready";
        message = "安装未完成，已保留验证过的安装包";
        publish();
        if (host.foreground() && !destroyed) showInstallRecovery(latest, UpdateInstallStatus.message(status, detail));
    }

    private void showInstallPermission(Manifest target, String explanation) {
        AlertDialog permission = new AlertDialog.Builder(activity).setTitle("允许安装更新")
                .setMessage(explanation)
                .setNegativeButton("稍后", null)
                .setPositiveButton("去设置", (d, which) -> openInstallPermissionSettings(target))
                .create();
        show(permission, AlertDialog.BUTTON_NEGATIVE);
    }

    private void openInstallPermissionSettings(Manifest target) {
        preferences.edit().putInt("install_target_code", target.code)
                .putString("manifest", target.json.toString()).putBoolean("waiting_permission", true)
                .putBoolean("waiting_installer", false).apply();
        try {
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
        } catch (Exception specificFailure) {
            try {
                activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + activity.getPackageName())));
            } catch (Exception fallbackFailure) {
                preferences.edit().putBoolean("waiting_permission", false).apply();
                showInstallRecovery(target, "设备无法打开安装权限设置。请在系统设置中允许此应用安装未知来源应用后，回到这里继续安装。");
            }
        }
    }

    private void showInstallRecovery(Manifest target, String explanation) {
        preferences.edit().putBoolean("waiting_installer", false).remove("install_status").remove("install_message").apply();
        state = "ready"; message = "安装未完成，已保留验证过的安装包"; publish();
        if (!host.foreground() || destroyed || dialog != null) return;
        String attemptedRoute = preferences.getString("install_mode", "");
        boolean retryAlternative = UpdateInstallPolicy.INSTALL_PACKAGE.equals(
                UpdateInstallPolicy.retryRoute(attemptedRoute));
        AlertDialog.Builder retry = new AlertDialog.Builder(activity).setTitle("继续安装 " + target.name)
                .setMessage(explanation + "\n\n已校验的安装包仍保留，可以重试安装。")
                .setNegativeButton("稍后", null)
                .setPositiveButton(retryAlternative ? "尝试备用安装器" : "继续安装", (d, which) -> {
                    if (retryAlternative) launchAlternativeInstaller(target, explanation);
                    else launchInstaller(target);
                });
        LinearLayout exportPanel = new LinearLayout(activity);
        exportPanel.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * activity.getResources().getDisplayMetrics().density);
        exportPanel.setPadding(padding, 0, padding, 0);
        Button save = new Button(activity);
        save.setText("保存安装包");
        save.setOnClickListener(view -> {
            dismissDialog();
            activity.getWindow().getDecorView().post(() -> saveApk(target));
        });
        exportPanel.addView(save, new LinearLayout.LayoutParams(-1, -2));
        TextView hint = new TextView(activity);
        hint.setText("保存到下载目录后，请通过电视文件管理器自行安装。");
        hint.setTextSize(15);
        exportPanel.addView(hint);
        retry.setView(exportPanel);
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            retry.setNeutralButton("去设置", (d, which) -> openInstallPermissionSettings(target));
        } else {
            retry.setNeutralButton("备用方式", (d, which) -> launchSessionInstaller(target, explanation));
        }
        show(retry.create(), AlertDialog.BUTTON_POSITIVE);
    }

    private void saveApk(Manifest target) {
        if (destroyed || savingApk || pendingSavePermission != null || !host.foreground() || !host.trusted()) return;
        if (latest != target || verifiedApkCode != target.code || !apk.isFile() || apk.length() != target.bytes) {
            showFailure("已下载的安装包不可用，请重新检查更新。");
            return;
        }
        if (Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT <= 28
                && ContextCompat.checkSelfPermission(activity, android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingSavePermission = target;
            try {
                activity.requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, SAVE_APK_PERMISSION);
            } catch (RuntimeException failure) {
                pendingSavePermission = null;
                showSaveResult("安装包未保存", "无法申请存储权限，请允许存储权限后重试。原安装包仍保留。");
            }
            return;
        }
        savingApk = true; saveCancelled = false;
        message = "正在保存安装包…"; publish();
        AlertDialog saving = new AlertDialog.Builder(activity).setTitle("保存安装包")
                .setMessage("正在保存到下载目录…")
                .setNegativeButton("取消", (d, which) -> saveCancelled = true).create();
        saving.setOnCancelListener(d -> saveCancelled = true);
        show(saving, AlertDialog.BUTTON_NEGATIVE);
        worker.execute(() -> {
            UpdateApkSaver.SavedApk saved = null;
            String failure = null;
            try {
                verifyArchive(target, apk);
                saved = UpdateApkSaver.save(activity, apk, Uri.parse(target.url).getLastPathSegment(),
                        target.bytes, target.sha256, new UpdateFiles.Monitor() {
                            public void check() throws IOException {
                                if (destroyed || saveCancelled || Thread.currentThread().isInterrupted()) throw new IOException("已取消保存");
                            }
                            public void progress(long bytes) { }
                        });
            } catch (Exception error) {
                failure = error instanceof SecurityException ? "无法写入下载目录，请检查存储权限" : friendly(error);
            }
            final UpdateApkSaver.SavedApk result = saved;
            final String detail = failure;
            activity.runOnUiThread(() -> {
                savingApk = false;
                if (destroyed) return;
                if (dialog == saving) dismissDialog();
                if (result != null) {
                    message = "安装包已保存：" + result.location + "，请自行安装"; publish();
                    showSaveResult("安装包已保存", "文件：" + result.name + "\n位置：" + result.location
                            + "\n\n请在电视文件管理器中打开该 APK，自行完成安装。");
                } else if (saveCancelled) {
                    message = "已取消保存，原安装包仍保留"; publish();
                } else {
                    message = "安装包保存失败，原安装包仍保留"; publish();
                    showSaveResult("安装包未保存", detail + "\n\n原安装包仍保留，可以重试保存或继续安装。");
                }
            });
        });
    }

    boolean onRequestPermissionsResult(int requestCode) {
        if (requestCode != SAVE_APK_PERMISSION) return false;
        Manifest target = pendingSavePermission;
        pendingSavePermission = null;
        if (destroyed || target == null) return true;
        if (ContextCompat.checkSelfPermission(activity, android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            saveApk(target);
        } else {
            message = "未获得存储权限，安装包未保存"; publish();
            showSaveResult("安装包未保存", "未获得存储权限，无法保存到下载目录。原安装包仍保留，您可以稍后重试。");
        }
        return true;
    }

    private void showSaveResult(String title, String text) {
        if (destroyed || !host.foreground() || dialog != null) return;
        show(new AlertDialog.Builder(activity).setTitle(title).setMessage(text)
                .setPositiveButton("知道了", null).create(), AlertDialog.BUTTON_POSITIVE);
    }

    private void rememberInstallHandoff(Manifest target, String mode) {
        preferences.edit().putInt("install_target_code", target.code)
                .putString("install_mode", mode).putInt("install_status", Integer.MIN_VALUE)
                .putString("install_message", "").putString("manifest", target.json.toString())
                .putBoolean("waiting_permission", false).putBoolean("waiting_installer", true).apply();
    }

    private void clearInstallerAttempt() {
        preferences.edit().remove("install_target_code").putBoolean("waiting_installer", false)
                .remove("install_status").remove("install_message").remove("install_mode").apply();
    }

    private void clearInstallHandoff() {
        preferences.edit().remove("install_target_code").remove("install_mode")
                .remove("install_status").remove("install_message")
                .putBoolean("waiting_permission", false).putBoolean("waiting_installer", false).apply();
    }

    private void launchViewInstaller(Manifest target) throws Exception {
        launchInstallerIntent(target, UpdateInstallPolicy.VIEW, Intent.ACTION_VIEW);
    }

    private void launchPackageInstaller(Manifest target) throws Exception {
        launchInstallerIntent(target, UpdateInstallPolicy.INSTALL_PACKAGE, Intent.ACTION_INSTALL_PACKAGE);
    }

    private void launchInstallerIntent(Manifest target, String mode, String action) throws Exception {
        rememberInstallHandoff(target, mode);
        Intent install = new Intent(action);
        Uri uri = Uri.parse("content://" + activity.getPackageName() + ".updates/apk");
        install.setDataAndType(uri, "application/vnd.android.package-archive");
        install.setClipData(ClipData.newUri(activity.getContentResolver(), "update", uri));
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(install);
        state = "installing"; message = "已打开系统安装器，请完成系统确认"; publish();
    }

    private void launchAlternativeInstaller(Manifest target, String reason) {
        if (!apk.isFile() || apk.length() != target.bytes || verifiedApkCode != target.code || destroyed) return;
        try {
            launchPackageInstaller(target);
        } catch (Exception packageFailure) {
            String combined = reason + "\n备用安装入口失败：" + friendly(packageFailure);
            clearInstallerAttempt();
            if (UpdateInstallPolicy.canUsePackageInstallerSession(Build.VERSION.SDK_INT,
                    Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls())) {
                launchSessionInstaller(target, combined);
            } else {
                showInstallPermission(target, "系统安装器无法启动。" + combined + "\n请允许红果短剧安装更新后重试。");
            }
        }
    }

    private void installWithPackageInstaller(Manifest target) throws Exception {
        PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(activity.getPackageName());
        params.setSize(apk.length());
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
        int sessionId = installer.createSession(params);
        boolean committed = false;
        PackageInstaller.Session session = null;
        try {
            session = installer.openSession(sessionId);
            try (InputStream input = new FileInputStream(apk);
                 OutputStream output = session.openWrite("base.apk", 0, apk.length())) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                session.fsync(output);
            }
            rememberInstallHandoff(target, "session");
            Intent callback = new Intent(activity, UpdateInstallReceiver.class);
            callback.setAction(UpdateInstallReceiver.ACTION_STATUS);
            callback.setData(Uri.parse("hongguo-update://session/" + sessionId));
            callback.putExtra(UpdateInstallReceiver.EXTRA_TARGET_CODE, target.code);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent status = PendingIntent.getBroadcast(activity, sessionId, callback, flags);
            session.commit(status.getIntentSender());
            committed = true;
        } finally {
            if (session != null) {
                try { session.close(); } catch (Exception ignored) { }
            }
            if (!committed) {
                try { installer.abandonSession(sessionId); } catch (Exception ignored) { }
            }
        }
    }

    private void showFailure(String text) {
        if (!host.foreground() || destroyed || dialog != null) return;
        show(new AlertDialog.Builder(activity).setTitle("更新未完成").setMessage(text)
                .setPositiveButton("知道了", null).create(), AlertDialog.BUTTON_POSITIVE);
    }

    private void cancelDownload() {
        generation.incrementAndGet();
        HttpURLConnection active = connection; if (active != null) active.disconnect();
        downloading = false; state = latest == null ? "idle" : "available"; message = "已取消下载";
        if (latest != null) defer(latest);
        publish();
    }

    boolean back() {
        if (dialog == null || !dialog.isShowing()) return false;
        dialog.cancel(); return true;
    }

    private void dismissDialog() {
        if (dialog != null) { AlertDialog old = dialog; dialog = null; old.dismiss(); }
        progress = null; progressText = null;
    }

    private boolean valid(int epoch) { return !destroyed && generation.get() == epoch; }
    private void ensureValid(int epoch) throws IOException { if (!valid(epoch)) throw new IOException("更新操作已取消"); }
    private String friendly(Exception error) {
        if (error instanceof java.net.SocketTimeoutException) return "连接超时，应用会自动尝试其他更新线路";
        if (error instanceof java.net.UnknownHostException) return "无法连接更新服务，应用会自动尝试其他线路";
        return error.getMessage() == null ? "网络或文件校验失败" : error.getMessage();
    }

    private void publish() {
        try {
            JSONObject value = new JSONObject();
            value.put("supported", !BuildConfig.DEBUG); value.put("current_version", BuildConfig.VERSION_NAME);
            value.put("variant", BuildConfig.VARIANT_ID); value.put("edition", UpdatePolicy.edition(BuildConfig.VARIANT_ID));
            value.put("current_code", BuildConfig.VERSION_CODE); value.put("state", state); value.put("message", message);
            value.put("downloaded", downloaded);
            value.put("latest_version", latest == null ? "" : latest.name);
            value.put("latest_code", latest == null ? 0 : latest.code);
            value.put("size", latest == null ? 0 : latest.bytes); snapshot = value.toString();
        } catch (Exception ignored) { /* Keep the last complete status. */ }
    }

    void destroy() {
        destroyed = true; generation.incrementAndGet();
        HttpURLConnection active = connection; if (active != null) active.disconnect();
        if (installResultReceiverRegistered) {
            try { activity.unregisterReceiver(installResultReceiver); } catch (Exception ignored) { }
            installResultReceiverRegistered = false;
        }
        dismissDialog(); worker.shutdownNow();
    }
}
