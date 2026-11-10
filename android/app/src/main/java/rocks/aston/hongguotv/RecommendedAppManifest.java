package rocks.aston.hongguotv;

import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONObject;

/** Validates the two published metadata formats before downloading any APK. */
final class RecommendedAppManifest {
    final int code, minSdk;
    final long size;
    final String version, sha, url;
    RecommendedAppManifest(RecommendedAppPolicy.App app, String body) throws Exception {
        JSONObject json = new JSONObject(body);
        String pkg;
        if (app.releaseApi) {
            if (json.getBoolean("draft") || json.getBoolean("prerelease")) throw new IOException("not_stable");
            String tag = json.getString("tag_name");
            if (!tag.matches("v[0-9]+\\.[0-9]+\\.[0-9]+")) throw new IOException("release_tag");
            version = tag.substring(1); code = 0; minSdk = app.minSdk; pkg = app.packageName;
            JSONArray assets = json.getJSONArray("assets");
            JSONObject selected = null;
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.getJSONObject(i);
                if ((app.filePrefix + version + ".apk").equals(asset.getString("name"))) {
                    if (selected != null) throw new IOException("duplicate_asset");
                    selected = asset;
                }
            }
            if (selected == null || !"uploaded".equals(selected.getString("state"))) throw new IOException("missing_asset");
            String digest = selected.getString("digest");
            if (!digest.startsWith("sha256:")) throw new IOException("missing_digest");
            sha = digest.substring(7).toLowerCase(java.util.Locale.ROOT);
            size = selected.getLong("size"); url = selected.getString("browser_download_url");
        } else {
            if (json.getInt("schema") != 1) throw new IOException("manifest");
            code = json.getInt("version_code"); minSdk = json.getInt("min_sdk");
            size = json.getLong("size"); version = json.getString("version_name");
            sha = json.getString("sha256").toLowerCase(java.util.Locale.ROOT);
            url = json.getString("download_url"); pkg = json.getString("package_name");
        }
        RecommendedAppPolicy.validate(app, pkg, code, version, minSdk, size, sha, url);
    }
}
