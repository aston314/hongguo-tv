package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public final class RecommendedAppPolicyTest {
    private final RecommendedAppPolicy.App app = RecommendedAppPolicy.find("doudou");
    private final String url = "https://github.com/aston314/doudou-tv-releases/releases/download/v0.1.45/doudou-tv-0.1.45.apk";
    private final String sha = "10206a0ba37e25e9e8b2554e5d393a07344f279ff24890441be3013e73ff395c";
    @Test public void acceptsOfficialMetadataAndPinnedCertificate() {
        RecommendedAppPolicy.validate(app, app.packageName, 46, "0.1.45", 23, 25053739, sha, url);
        assertTrue(RecommendedAppPolicy.matchingArchive(app, app.packageName, 46, "0.1.45", 46, "0.1.45", new String[]{app.signer}));
    }
    @Test public void rejectsForeignPackagesVersionsAndSignatures() {
        assertFalse(RecommendedAppPolicy.matchingArchive(app, "cc.kafeizhibo.tv", 46, "0.1.45", 46, "0.1.45", new String[]{app.signer}));
        assertFalse(RecommendedAppPolicy.matchingArchive(app, app.packageName, 45, "0.1.45", 46, "0.1.45", new String[]{app.signer}));
        assertFalse(RecommendedAppPolicy.matchingArchive(app, app.packageName, 46, "0.1.44", 46, "0.1.45", new String[]{app.signer}));
        assertFalse(RecommendedAppPolicy.matchingArchive(app, app.packageName, 46, "0.1.45", 46, "0.1.45", new String[]{sha}));
        assertFalse(RecommendedAppPolicy.matchingArchive(app, app.packageName, 46, "0.1.45", 46, "0.1.45", null));
        assertFalse(RecommendedAppPolicy.matchingArchive(app, app.packageName, 46, "0.1.45", 46, "0.1.45", new String[]{app.signer, sha}));
    }
    @Test public void rejectsMutableUrlsWrongRepositoriesAndEncodedPaths() {
        String[] invalid = {url.replace("https:", "http:"), url + "?token=1", url + "#x", url.replace("github.com", "github.com.example.com"),
                url.replace("v0.1.45", "latest"), url.replace("doudou-tv-releases/", "hongguo-tv-releases/"), url.replace("doudou-tv-0.1.45.apk", "%64oudou-tv-0.1.45.apk")};
        for (String value : invalid) {
            try { RecommendedAppPolicy.validate(app, app.packageName, 46, "0.1.45", 23, 25053739, sha, value); fail(value); }
            catch (IllegalArgumentException expected) { /* rejected */ }
        }
    }
    @Test public void checksSizeHashAndMinimumAndroid() {
        for (long size : new long[]{0, -1, UpdatePolicy.MAX_APK_BYTES + 1}) {
            try { RecommendedAppPolicy.validate(app, app.packageName, 46, "0.1.45", 23, size, sha, url); fail(); }
            catch (IllegalArgumentException expected) { /* rejected */ }
        }
        try { RecommendedAppPolicy.validate(app, app.packageName, 46, "0.1.45", 21, 100, sha, url); fail(); }
        catch (IllegalArgumentException expected) { /* rejected */ }
        try { RecommendedAppPolicy.validate(app, app.packageName, 46, "0.1.45", 23, 100, "not-a-hash", url); fail(); }
        catch (IllegalArgumentException expected) { /* rejected */ }
    }
    @Test public void usesOnlyExistingProxiesAndAClosedCatalog() {
        String[] sources = RecommendedAppPolicy.sources(url);
        assertEquals(UpdatePolicy.BUILTIN_PROXIES.length, sources.length);
        for (int i = 0; i < sources.length; i++) assertEquals(UpdatePolicy.BUILTIN_PROXIES[i] + url, sources[i]);
        assertEquals("cc.kafeizhibo.tv", RecommendedAppPolicy.find("sports").packageName);
        try { RecommendedAppPolicy.find("../update"); fail(); } catch (IllegalArgumentException expected) { /* rejected */ }
    }
    @Test public void anIncompleteInstallCanReachEveryExistingCompatibilityRoute() {
        assertArrayEquals(new String[]{"view", "install_package", "session"}, UpdateInstallPolicy.routes(true));
        assertArrayEquals(new String[]{"view", "install_package", "settings"}, UpdateInstallPolicy.routes(false));
        assertEquals("install_package", RecommendedAppPolicy.nextInstallRoute("view"));
        assertEquals("session", RecommendedAppPolicy.nextInstallRoute("install_package"));
        assertEquals("view", RecommendedAppPolicy.nextInstallRoute("session"));
        assertTrue(UpdateInstallPolicy.canUsePackageInstallerSession(23, false));
        assertFalse(UpdateInstallPolicy.canUsePackageInstallerSession(26, false));
    }
    @Test public void yunyingUsesItsOwnCertificateAndArchiveVersionCode() {
        RecommendedAppPolicy.App yunying = RecommendedAppPolicy.find("yunying");
        String url = "https://github.com/aston314/yunying-tv-releases/releases/download/v0.1.44/yunying-tv-0.1.44.apk";
        RecommendedAppPolicy.validate(yunying, "cc.yunying.tv", 0, "0.1.44", 23, 26980671, sha, url);
        assertTrue(RecommendedAppPolicy.matchingArchive(yunying, yunying.packageName, 26, "0.1.44", 0, "0.1.44", new String[]{yunying.signer}));
        assertFalse(RecommendedAppPolicy.matchingArchive(yunying, yunying.packageName, 26, "0.1.44", 0, "0.1.44", new String[]{app.signer}));
        assertFalse(RecommendedAppPolicy.matchingArchive(app, app.packageName, 46, "0.1.45", 0, "0.1.45", new String[]{app.signer}));
    }
}
