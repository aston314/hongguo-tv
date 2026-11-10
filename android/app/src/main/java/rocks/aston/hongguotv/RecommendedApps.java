package rocks.aston.hongguotv;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PackageInstaller;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import androidx.core.content.FileProvider;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/** User-initiated installation of a small fixed catalog. Never checks installed apps for updates. */
final class RecommendedApps {
    interface Host { boolean trusted(); boolean foreground(); void restoreFocus(); }
    private final Activity activity;
    private final Host host;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicInteger generation = new AtomicInteger();
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final File directory;
    private final SharedPreferences preferences;
    private volatile HttpURLConnection connection;
    private volatile boolean destroyed;
    private volatile String snapshot = "{}";
    private volatile boolean visible;
    private boolean busy;
    private Entry downloading, waitingInstaller, waitingPermission;
    private final BroadcastReceiver resultReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (destroyed || intent == null) return;
            Entry e = entries.get(intent.getStringExtra("app_id"));
            if (e == null || e.manifest == null || intent.getIntExtra("target_code", 0) != e.manifest.code) return;
            int status = intent.getIntExtra("status", PackageInstaller.STATUS_FAILURE);
            busy = false;
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) { waitingInstaller = e; e.state = "installing"; }
            else {
                waitingInstaller = null;
                if (!markInstalled(e)) { e.state = "ready"; e.error = "incomplete"; }
            }
            publish();
        }
    };

    private static final class Manifest {
        final int code, minSdk;
        final long size;
        final String version, sha, url;
        Manifest(RecommendedAppPolicy.App app, String body) throws Exception {
            JSONObject json = new JSONObject(body);
            if (json.getInt("schema") != 1) throw new IOException("manifest");
            code = json.getInt("version_code"); minSdk = json.getInt("min_sdk");
            size = json.getLong("size"); version = json.getString("version_name");
            sha = json.getString("sha256").toLowerCase(java.util.Locale.ROOT);
            url = json.getString("download_url");
            RecommendedAppPolicy.validate(app, json.getString("package_name"), code, version, minSdk, size, sha, url);
        }
    }
    private static final class Entry {
        final RecommendedAppPolicy.App app;
        final File apk, partial;
        Manifest manifest;
        String state = "idle", error = "";
        String nextRoute = UpdateInstallPolicy.VIEW;
        long downloaded;
        boolean verified;
        Entry(RecommendedAppPolicy.App app, File directory) {
            this.app = app; apk = new File(directory, app.id + ".apk"); partial = new File(directory, app.id + ".part");
        }
    }
    RecommendedApps(Activity activity, Host host) {
        this.activity = activity; this.host = host;
        preferences = activity.getSharedPreferences(RecommendedAppInstallReceiver.PREFERENCES, Context.MODE_PRIVATE);
        preferences.edit().putBoolean("visible", false).apply();
        directory = new File(activity.getCacheDir(), "recommended-apps");
        directory.mkdirs();
        for (RecommendedAppPolicy.App app : RecommendedAppPolicy.APPS) {
            Entry e = new Entry(app, directory); entries.put(app.id, e);
            e.partial.delete();
            if (System.currentTimeMillis() - e.apk.lastModified() > UpdatePolicy.CHECK_INTERVAL) e.apk.delete();
        }
        ContextCompat.registerReceiver(activity, resultReceiver, new IntentFilter(RecommendedAppInstallReceiver.ACTION_RESULT), ContextCompat.RECEIVER_NOT_EXPORTED);
        publish();
    }
    final class Bridge {
        @JavascriptInterface public String getStatus() { return host.trusted() ? snapshot : "{}"; }
        @JavascriptInterface public void setVisible(boolean value) {
            if (host.trusted()) activity.runOnUiThread(() -> {
                visible = value;
                preferences.edit().putBoolean("visible", value && host.foreground()).apply();
            });
        }
        @JavascriptInterface public void refresh() {
            if (host.trusted()) activity.runOnUiThread(() -> load());
        }
        @JavascriptInterface public void activate(String id) {
            if (host.trusted()) activity.runOnUiThread(() -> {
                Entry e = entries.get(id);
                if (!destroyed && visible && host.foreground() && e != null) activateEntry(e);
            });
        }
    }
    private boolean installed(Entry e) {
        try { activity.getPackageManager().getPackageInfo(e.app.packageName, 0); return true; }
        catch (PackageManager.NameNotFoundException missing) { return false; }
    }
    private boolean markInstalled(Entry e) {
        if (!installed(e)) return false;
        e.state = "installed"; e.error = ""; e.verified = false; e.apk.delete(); return true;
    }
    private void load() {
        if (destroyed || !visible || !host.foreground() || busy) return;
        final List<Entry> pending = new ArrayList<>();
        for (Entry e : entries.values()) {
            if (markInstalled(e)) continue;
            if ("installed".equals(e.state)) { e.state = "idle"; e.manifest = null; }
            if (e.manifest == null || "error".equals(e.state) || "available".equals(e.state)) {
                e.state = "loading"; pending.add(e);
            }
        }
        if (pending.isEmpty()) { publish(); return; }
        busy = true;
        publish();
        final int epoch = generation.get();
        worker.execute(() -> {
            for (Entry e : pending) {
                if (!valid(epoch)) return;
                Manifest result = null;
                for (String source : RecommendedAppPolicy.sources(e.app.manifestUrl + "?check=" + System.currentTimeMillis())) {
                    try { result = new Manifest(e.app, read(source, epoch)); break; }
                    catch (Exception failed) { if (!valid(epoch)) return; }
                }
                final Manifest found = result;
                activity.runOnUiThread(() -> {
                    if (!valid(epoch)) return;
                    if (!markInstalled(e)) {
                        e.manifest = found; e.error = found == null ? "metadata" : "";
                        e.state = found == null ? "error" : found.minSdk > Build.VERSION.SDK_INT ? "incompatible" : "available";
                    }
                    publish();
                });
            }
            activity.runOnUiThread(() -> { if (valid(epoch)) { busy = false; publish(); } });
        });
    }
    private void activateEntry(Entry e) {
        if (markInstalled(e)) { publish(); return; }
        if (e == downloading) { cancel(); return; }
        if (busy) return;
        if ("permission".equals(e.state)) { permission(e); return; }
        if ("ready".equals(e.state) && e.verified) { install(e); return; }
        if (e.manifest == null || "metadata".equals(e.error)) { load(); return; }
        if (e.manifest.minSdk > Build.VERSION.SDK_INT) return;
        final Manifest target = e.manifest;
        final int epoch = generation.incrementAndGet();
        e.state = "downloading"; e.error = ""; e.downloaded = 0; e.verified = false;
        downloading = e; busy = true; publish();
        worker.execute(() -> download(e, target, epoch));
    }
    private void download(Entry e, Manifest target, int epoch) {
        try {
            IOException last = new IOException("download");
            for (String source : RecommendedAppPolicy.sources(target.url)) {
                ensureValid(epoch); e.partial.delete();
                try {
                    HttpURLConnection request = open(source, epoch);
                    try (InputStream input = request.getInputStream()) {
                        String length = request.getHeaderField("Content-Length");
                        if (length != null && Long.parseLong(length) != target.size) throw new IOException("size");
                        UpdateFiles.copyChecked(input, e.partial, target.size, target.sha, new UpdateFiles.Monitor() {
                            private long lastProgress;
                            public void check() throws IOException { ensureValid(epoch); }
                            public void progress(long bytes) {
                                long now = android.os.SystemClock.elapsedRealtime();
                                if (now - lastProgress < 350) return;
                                lastProgress = now;
                                activity.runOnUiThread(() -> { if (valid(epoch)) { e.downloaded = bytes; publish(); } });
                            }
                        });
                    } finally { request.disconnect(); if (connection == request) connection = null; }
                    ensureValid(epoch); verifyArchive(e, target, e.partial);
                    ensureValid(epoch);
                    e.apk.delete();
                    if (!e.partial.renameTo(e.apk)) throw new IOException("storage");
                    activity.runOnUiThread(() -> {
                        if (!valid(epoch)) return;
                        downloading = null; busy = false;
                        if (markInstalled(e)) { publish(); return; }
                        e.verified = true; e.state = "ready"; e.downloaded = target.size; publish();
                        // A completed background download must not interrupt another page or playback.
                        if (visible && host.foreground() && host.trusted()) install(e);
                    });
                    return;
                } catch (Exception failed) {
                    e.partial.delete(); last = new IOException("download", failed);
                }
            }
            throw last;
        } catch (Exception failed) {
            e.partial.delete();
            activity.runOnUiThread(() -> {
                if (!valid(epoch)) return;
                downloading = null; busy = false; e.state = "error"; e.error = "download"; publish();
            });
        }
    }
    @SuppressWarnings("deprecation")
    private void verifyArchive(Entry e, Manifest target, File file) throws Exception {
        PackageInfo archive = activity.getPackageManager().getPackageArchiveInfo(file.getPath(), PackageManager.GET_SIGNATURES);
        if (archive == null || archive.signatures == null) throw new IOException("archive");
        String[] signers = new String[archive.signatures.length];
        for (int i = 0; i < signers.length; i++) {
            Signature signer = archive.signatures[i];
            signers[i] = UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(signer.toByteArray()));
        }
        if (!RecommendedAppPolicy.matchingArchive(e.app, archive.packageName, archive.versionCode, archive.versionName,
                target.code, target.version, signers)) throw new IOException("signature");
        if (Build.VERSION.SDK_INT >= 24 && archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)
            throw new IOException("incompatible");
    }
    private void install(Entry e) {
        if (destroyed || !visible || !host.foreground() || !host.trusted() || !e.verified || !e.apk.isFile()) return;
        if (markInstalled(e)) { publish(); return; }
        e.error = "";
        boolean canRequest = Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls();
        String[] routes = UpdateInstallPolicy.routes(UpdateInstallPolicy.canUsePackageInstallerSession(Build.VERSION.SDK_INT, canRequest));
        int start = UpdateInstallPolicy.INSTALL_PACKAGE.equals(e.nextRoute) ? 1 : UpdateInstallPolicy.SESSION.equals(e.nextRoute) ? 2 : 0;
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".recommendedapps", e.apk);
        for (int i = start; i < routes.length; i++) {
            String route = routes[i];
            if (UpdateInstallPolicy.SETTINGS.equals(route)) { e.state = "permission"; publish(); return; }
            if (UpdateInstallPolicy.SESSION.equals(route)) { installSession(e); return; }
            try {
                String action = UpdateInstallPolicy.VIEW.equals(route) ? Intent.ACTION_VIEW : Intent.ACTION_INSTALL_PACKAGE;
                Intent intent = new Intent(action);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.setClipData(ClipData.newUri(activity.getContentResolver(), "apk", uri));
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(intent); waitingInstaller = e;
                e.nextRoute = RecommendedAppPolicy.nextInstallRoute(route); e.state = "installing"; publish(); return;
            } catch (RuntimeException failed) { /* Try the other system installation entry point. */ }
        }
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) e.state = "permission";
        else { e.state = "ready"; e.error = "installer"; }
        publish();
    }
    private void permission(Entry e) {
        if (Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls()) { install(e); return; }
        try {
            waitingPermission = e;
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
        } catch (RuntimeException unavailable) {
            try { activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.getPackageName()))); }
            catch (RuntimeException missing) { waitingPermission = null; e.error = "installer"; publish(); }
        }
    }
    private void installSession(Entry e) {
        if (busy) return;
        final int epoch = generation.get();
        final Manifest target = e.manifest;
        busy = true; e.state = "installing"; e.nextRoute = UpdateInstallPolicy.VIEW;
        publish();
        worker.execute(() -> {
            PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
            int sessionId = -1;
            boolean committed = false;
            try {
                ensureValid(epoch);
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(e.app.packageName); params.setSize(e.apk.length());
                if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
                sessionId = installer.createSession(params);
                try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                    try (InputStream input = new FileInputStream(e.apk); OutputStream output = session.openWrite("base.apk", 0, e.apk.length())) {
                        byte[] buffer = new byte[32768]; int count;
                        while ((count = input.read(buffer)) != -1) { ensureValid(epoch); output.write(buffer, 0, count); }
                        session.fsync(output);
                    }
                    ensureValid(epoch);
                    if (!visible || !host.foreground()) throw new IOException("not_visible");
                    preferences.edit().putInt(e.app.id + ".session", sessionId).putInt(e.app.id + ".code", target.code)
                            .remove(e.app.id + ".status").apply();
                    Intent callback = new Intent(activity, RecommendedAppInstallReceiver.class)
                            .setAction(RecommendedAppInstallReceiver.ACTION_STATUS)
                            .setData(Uri.parse("hongguo-recommended://session/" + sessionId))
                            .putExtra("app_id", e.app.id).putExtra("target_code", target.code);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                    if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
                    PendingIntent status = PendingIntent.getBroadcast(activity, sessionId, callback, flags);
                    session.commit(status.getIntentSender()); committed = true;
                }
            } catch (Exception failed) {
                activity.runOnUiThread(() -> {
                    if (!valid(epoch)) return;
                    busy = false; e.state = "ready"; e.error = "installer"; publish();
                });
            } finally {
                if (!committed && sessionId >= 0) { try { installer.abandonSession(sessionId); } catch (RuntimeException ignored) { } }
            }
        });
    }
    void resume() {
        if (destroyed) return;
        preferences.edit().putBoolean("visible", visible && host.foreground()).apply();
        if (waitingInstaller != null) {
            Entry e = waitingInstaller; waitingInstaller = null;
            if (!markInstalled(e)) e.state = Build.VERSION.SDK_INT >= 26
                    && !activity.getPackageManager().canRequestPackageInstalls() ? "permission" : "ready";
            if (!"installed".equals(e.state)) e.error = "incomplete";
            publish(); host.restoreFocus();
        }
        if (waitingPermission != null) {
            Entry e = waitingPermission; waitingPermission = null;
            if (Build.VERSION.SDK_INT >= 26 && activity.getPackageManager().canRequestPackageInstalls()) {
                e.state = "ready"; publish(); install(e);
            }
            else { e.state = "permission"; publish(); }
        }
        if (visible) { for (Entry e : entries.values()) markInstalled(e); publish(); }
    }
    void pause() { preferences.edit().putBoolean("visible", false).apply(); }
    private String read(String source, int epoch) throws Exception {
        HttpURLConnection request = open(source, epoch);
        try (InputStream input = request.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) {
                ensureValid(epoch);
                if (output.size() + count > 65536) throw new IOException("metadata_size");
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        } finally { request.disconnect(); if (connection == request) connection = null; }
    }
    private HttpURLConnection open(String source, int epoch) throws Exception {
        URL url = new URL(source);
        for (int redirect = 0; redirect < 6; redirect++) {
            ensureValid(epoch);
            if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null) throw new IOException("https_required");
            HttpURLConnection request = (HttpURLConnection) url.openConnection(); connection = request;
            request.setConnectTimeout(6000); request.setReadTimeout(12000);
            request.setInstanceFollowRedirects(false); request.setUseCaches(false);
            request.setRequestProperty("Cache-Control", "no-cache");
            request.setRequestProperty("Accept-Encoding", "identity");
            request.setRequestProperty("User-Agent", "HongguoTV/" + BuildConfig.VERSION_NAME);
            try {
                int code = request.getResponseCode(); ensureValid(epoch);
                if (code >= 300 && code < 400) {
                    String next = request.getHeaderField("Location"); request.disconnect();
                    if (next == null) throw new IOException("redirect");
                    url = new URL(url, next); continue;
                }
                if (code != 200) throw new IOException("http");
                return request;
            } catch (Exception failure) { request.disconnect(); throw failure; }
        }
        throw new IOException("redirect_limit");
    }
    private boolean valid(int epoch) { return !destroyed && generation.get() == epoch; }
    private void ensureValid(int epoch) throws IOException { if (!valid(epoch)) throw new IOException("cancelled"); }
    private void cancel() {
        generation.incrementAndGet();
        HttpURLConnection request = connection; if (request != null) request.disconnect();
        if (downloading != null) { downloading.state = "available"; downloading.downloaded = 0; }
        downloading = null; busy = false; publish();
    }
    private void publish() {
        try {
            JSONArray apps = new JSONArray();
            for (Entry e : entries.values()) {
                JSONObject value = new JSONObject();
                value.put("id", e.app.id); value.put("state", e.state); value.put("error", e.error);
                value.put("min_sdk", e.manifest == null ? e.app.minSdk : e.manifest.minSdk);
                value.put("version", e.manifest == null ? "" : e.manifest.version);
                value.put("size", e.manifest == null ? 0 : e.manifest.size);
                value.put("downloaded", e.downloaded); value.put("busy", busy && downloading != e);
                value.put("alternative", !UpdateInstallPolicy.VIEW.equals(e.nextRoute));
                apps.put(value);
            }
            snapshot = new JSONObject().put("apps", apps).toString();
        } catch (Exception ignored) { snapshot = "{}"; }
    }
    void destroy() {
        destroyed = true; generation.incrementAndGet();
        preferences.edit().putBoolean("visible", false).apply();
        activity.unregisterReceiver(resultReceiver);
        HttpURLConnection request = connection; if (request != null) request.disconnect();
        worker.shutdownNow();
    }
}
