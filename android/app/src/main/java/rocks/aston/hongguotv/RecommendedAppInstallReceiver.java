package rocks.aston.hongguotv;

import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Parcelable;
import androidx.core.content.FileProvider;
import java.io.File;

/** Session results for recommended apps must never write Hongguo's updater preferences. */
public final class RecommendedAppInstallReceiver extends BroadcastReceiver {
    static final String ACTION_STATUS = "rocks.aston.hongguotv.RECOMMENDED_INSTALL_STATUS";
    static final String ACTION_RESULT = "rocks.aston.hongguotv.RECOMMENDED_INSTALL_RESULT";
    static final String PREFERENCES = "HongguoRecommendedApps";
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_STATUS.equals(intent.getAction())) return;
        String id = intent.getStringExtra("app_id");
        try { RecommendedAppPolicy.find(id); } catch (IllegalArgumentException unknown) { return; }
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        int sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        int code = intent.getIntExtra("target_code", 0);
        if (code <= 0 || code != preferences.getInt(id + ".code", 0)
                || sessionId < 0 || sessionId != preferences.getInt(id + ".session", -1)) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            if (!preferences.getBoolean("visible", false) || !confirmation(context, intent, id)) {
                try { context.getPackageManager().getPackageInstaller().abandonSession(sessionId); } catch (RuntimeException ignored) { }
                status = PackageInstaller.STATUS_FAILURE_ABORTED;
            }
        }
        preferences.edit().putInt(id + ".status", status).apply();
        context.sendBroadcast(new Intent(ACTION_RESULT).setPackage(context.getPackageName())
                .putExtra("app_id", id).putExtra("target_code", code).putExtra("status", status));
    }
    private boolean confirmation(Context context, Intent callback, String id) {
        Intent confirmation = null;
        try {
            if (Build.VERSION.SDK_INT >= 33) confirmation = callback.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
            else {
                Parcelable value = callback.getParcelableExtra(Intent.EXTRA_INTENT);
                if (value instanceof Intent) confirmation = (Intent) value;
            }
        } catch (RuntimeException ignored) { }
        if (confirmation != null) {
            try { confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(confirmation); return true; }
            catch (RuntimeException ignored) { }
        }
        int sessionId = callback.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        if (sessionId >= 0) {
            try { context.getPackageManager().getPackageInstaller().abandonSession(sessionId); } catch (RuntimeException ignored) { }
        }
        // Same fallback as the updater patch: some ROMs omit or cannot open EXTRA_INTENT.
        try {
            File apk = new File(context.getCacheDir(), "recommended-apps/" + id + ".apk");
            if (!apk.isFile()) return false;
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".recommendedapps", apk);
            Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive");
            view.setClipData(ClipData.newUri(context.getContentResolver(), "apk", uri));
            view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            context.startActivity(view); return true;
        } catch (RuntimeException ignored) { return false; }
    }
}
