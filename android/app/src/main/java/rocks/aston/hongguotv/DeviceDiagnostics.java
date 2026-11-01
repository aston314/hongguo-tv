package rocks.aston.hongguotv;

import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Process;
import android.webkit.WebView;
import org.json.JSONObject;

/** Read-only, non-identifying device facts. Capture on the WebView's UI thread. */
final class DeviceDiagnostics {
    // PackageManager does not expose this feature key in every Android SDK
    // platform used by the project, although the framework feature is stable.
    private static final String FEATURE_HDMI_CEC = "android.hardware.hdmi.cec";

    static boolean isTelevision(Context context) {
        try {
            Configuration configuration = context.getResources().getConfiguration();
            if ((configuration.uiMode & Configuration.UI_MODE_TYPE_MASK)
                    == Configuration.UI_MODE_TYPE_TELEVISION) return true;
            PackageManager packageManager = context.getPackageManager();
            if (packageManager == null) return false;
            if (packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)) return true;
            // Older set-top boxes may omit both TV UI mode and Leanback while
            // still exposing HDMI-CEC. This is only a capability signal;
            // WebView layout always uses the shared CSS media queries.
            return Build.VERSION.SDK_INT >= 17
                    && packageManager.hasSystemFeature(FEATURE_HDMI_CEC);
        } catch (Exception ignored) {
            return false;
        }
    }

    static String snapshot(Context context) {
        JSONObject facts = new JSONObject();
        try {
            facts.put("app_version", BuildConfig.VERSION_NAME);
            facts.put("version_code", BuildConfig.VERSION_CODE);
            facts.put("core_version", BuildConfig.CORE_VERSION);
            facts.put("manufacturer", Build.MANUFACTURER);
            facts.put("model", Build.MODEL);
            facts.put("android_version", Build.VERSION.RELEASE);
            facts.put("sdk", Build.VERSION.SDK_INT);
            facts.put("process_bits", Process.is64Bit() ? 64 : 32);
            // OS-supported ABIs are not the running process architecture.
            facts.put("supported_abis", android.text.TextUtils.join(", ", Build.SUPPORTED_ABIS));
            if (Build.VERSION.SDK_INT >= 26) {
                PackageInfo provider = WebView.getCurrentWebViewPackage();
                if (provider != null) {
                    facts.put("webview_package", provider.packageName);
                    facts.put("webview_version", provider.versionName);
                }
            }
        } catch (Exception ignored) {
            // Android 6 still reports its actual Chromium version through UA.
        }
        return facts.toString();
    }
}
