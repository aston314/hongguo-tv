package rocks.aston.hongguotv;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

/** Local UI and playback settings survive restarts even when the core port changes. */
final class PlaybackPreferences {
    private final SharedPreferences preferences;

    PlaybackPreferences(Context context) {
        preferences = context.getSharedPreferences("playback", Context.MODE_PRIVATE);
    }

    @JavascriptInterface
    public String read() { return preferences.getString("settings", "{}"); }

    @JavascriptInterface
    public void write(String value) {
        if (value == null || value.length() > 4096) throw new IllegalArgumentException("invalid preferences");
        if (!preferences.edit().putString("settings", value).commit()) {
            throw new IllegalStateException("preferences were not saved");
        }
    }

    @JavascriptInterface
    public String readSidebarDisplay() {
        return preferences.getString("sidebarDisplay", "expanded");
    }

    @JavascriptInterface
    public void writeSidebarDisplay(String value) {
        if (!"expanded".equals(value) && !"icons".equals(value)) {
            throw new IllegalArgumentException("invalid sidebar display");
        }
        if (!preferences.edit().putString("sidebarDisplay", value).commit()) {
            throw new IllegalStateException("sidebar display was not saved");
        }
    }

    @JavascriptInterface
    public String readLocale() {
        return preferences.getString("locale", "zh-CN");
    }

    @JavascriptInterface
    public void writeLocale(String value) {
        if (!"zh-CN".equals(value) && !"zh-TW".equals(value) && !"ja-JP".equals(value)) {
            throw new IllegalArgumentException("invalid locale");
        }
        if (!preferences.edit().putString("locale", value).commit()) {
            throw new IllegalStateException("locale was not saved");
        }
    }

    @JavascriptInterface
    public String readAutoCinema() {
        return preferences.getString("autoCinema", "enabled");
    }

    @JavascriptInterface
    public void writeAutoCinema(String value) {
        if (!"enabled".equals(value) && !"disabled".equals(value)) {
            throw new IllegalArgumentException("invalid auto cinema preference");
        }
        if (!preferences.edit().putString("autoCinema", value).commit()) {
            throw new IllegalStateException("auto cinema preference was not saved");
        }
    }

    @JavascriptInterface
    public String readRecommendationDirection() {
        return preferences.getString("recommendationDirection", "all");
    }

    @JavascriptInterface
    public void writeRecommendationDirection(String value) {
        if (!"all".equals(value) && !"landscape".equals(value) && !"portrait".equals(value)) {
            throw new IllegalArgumentException("invalid recommendation direction");
        }
        if (!preferences.edit().putString("recommendationDirection", value).commit()) {
            throw new IllegalStateException("recommendation direction was not saved");
        }
    }

    @JavascriptInterface
    public String readPlaybackMenuHint() {
        return preferences.getString("playbackMenuHint", "unseen");
    }

    @JavascriptInterface
    public void writePlaybackMenuHint(String value) {
        if (!"seen".equals(value) && !"unseen".equals(value)) {
            throw new IllegalArgumentException("invalid playback menu hint state");
        }
        if (!preferences.edit().putString("playbackMenuHint", value).commit()) {
            throw new IllegalStateException("playback menu hint state was not saved");
        }
    }

    @JavascriptInterface
    public String readMedia3Preference(String webviewVersion) {
        if (!Media3RoutePreferencePolicy.validWebViewVersion(webviewVersion)) return "";
        String engine = preferences.getString("media3Engine", "");
        String storedVersion = preferences.getString("media3WebView", "");
        long expiresAt = preferences.getLong("media3ExpiresAt", 0L);
        if (engine.isEmpty() && storedVersion.isEmpty() && expiresAt == 0L) return "";
        if (!Media3RoutePreferencePolicy.matches(engine, storedVersion, webviewVersion, expiresAt, System.currentTimeMillis())) {
            clearMedia3Preference();
            return "";
        }
        return "media3";
    }

    @JavascriptInterface
    public boolean writeMedia3Preference(String webviewVersion, long expiresAt) {
        long now = System.currentTimeMillis();
        if (!Media3RoutePreferencePolicy.validWrite(webviewVersion, expiresAt, now)) return false;
        return preferences.edit().putString("media3Engine", "media3")
                .putString("media3WebView", webviewVersion).putLong("media3ExpiresAt", expiresAt).commit();
    }

    @JavascriptInterface
    public void clearMedia3Preference() {
        if (!preferences.edit().remove("media3Engine").remove("media3WebView").remove("media3ExpiresAt").commit()) {
            throw new IllegalStateException("Media3 preference was not cleared");
        }
    }
}
