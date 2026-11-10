package rocks.aston.hongguotv;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public final class RecommendedAppManifestTest {
    private final RecommendedAppPolicy.App yunying = RecommendedAppPolicy.find("yunying");
    private JSONObject release() throws Exception {
        return new JSONObject().put("tag_name", "v0.1.44").put("draft", false).put("prerelease", false)
                .put("assets", new JSONArray().put(new JSONObject().put("name", "yunying-tv-0.1.44.apk")
                    .put("state", "uploaded").put("size", 26980671)
                    .put("digest", "sha256:361488c40299218202419e5bd532444336c79f143d90f15b2684894684339788")
                    .put("browser_download_url", "https://github.com/aston314/yunying-tv-releases/releases/download/v0.1.44/yunying-tv-0.1.44.apk")));
    }
    private void rejected(JSONObject json) {
        try { new RecommendedAppManifest(yunying, json.toString()); fail("must reject invalid release"); }
        catch (Exception expected) { /* rejected */ }
    }
    @Test public void parsesThePublicReleaseAndIgnoresUnrelatedAssets() throws Exception {
        JSONObject json = release();
        json.getJSONArray("assets").put(new JSONObject().put("name", "SHA256SUMS-public.txt"));
        RecommendedAppManifest manifest = new RecommendedAppManifest(yunying, json.toString());
        assertEquals("0.1.44", manifest.version); assertEquals(0, manifest.code); assertEquals(23, manifest.minSdk);
        assertEquals(26980671, manifest.size);
        assertEquals("361488c40299218202419e5bd532444336c79f143d90f15b2684894684339788", manifest.sha);
    }
    @Test public void rejectsNonFinalReleasesOrMissingAndDuplicateApks() throws Exception {
        rejected(release().put("draft", true)); rejected(release().put("prerelease", true));
        rejected(release().put("tag_name", "v0.1.44-test.1")); rejected(release().put("assets", new JSONArray()));
        JSONObject duplicate = release(); duplicate.getJSONArray("assets").put(duplicate.getJSONArray("assets").getJSONObject(0)); rejected(duplicate);
    }
    @Test public void rejectsUnverifiedOrForeignAssets() throws Exception {
        for (String field : new String[]{"digest", "size", "state", "browser_download_url"}) {
            JSONObject json = release(); json.getJSONArray("assets").getJSONObject(0).remove(field); rejected(json);
        }
        JSONObject json = release(); json.getJSONArray("assets").getJSONObject(0).put("digest", "md5:bad"); rejected(json);
        json = release(); json.getJSONArray("assets").getJSONObject(0).put("browser_download_url", "https://example.org/yunying.apk"); rejected(json);
    }
    @Test public void parsesExistingUpdateJsonWithoutChangingItsIdentityRules() throws Exception {
        RecommendedAppPolicy.App app = RecommendedAppPolicy.find("sports");
        JSONObject json = new JSONObject().put("schema", 1).put("package_name", app.packageName).put("version_code", 20)
                .put("version_name", "0.1.19").put("min_sdk", 23).put("size", 14000941)
                .put("sha256", "35c1fa2d0d52f7d1f968c43043819732bf71743aa239ab78dcd3625afc9a5543")
                .put("download_url", "https://github.com/aston314/kafeizhibo-tv/releases/download/v0.1.19/sports-live-tv-0.1.19.apk");
        assertEquals(20, new RecommendedAppManifest(app, json.toString()).code);
        json.put("package_name", yunying.packageName);
        try { new RecommendedAppManifest(app, json.toString()); fail(); } catch (IllegalArgumentException expected) { /* rejected */ }
    }
}
