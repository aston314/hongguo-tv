package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdatePolicyTest {
    @Test public void android5HasAnIsolatedChannelAndCanUpgradeTheOldTestPackage() {
        assertTrue(UpdatePolicy.manifestUrl("android5").endsWith("/update-android5.json"));
        assertEquals("Android 5 兼容版", UpdatePolicy.edition("android5"));
        String pkg = "rocks.aston.hongguotv.android5test";
        String sha = new String(new char[64]).replace('\0', 'a');
        String url = "https://github.com/aston314/hongguo-tv-releases/releases/download/v0.2.150/hongguo-tv-android5-0.2.150.apk";
        UpdatePolicy.validateVariant("android5", "android5", pkg, 21);
        UpdatePolicy.validate(pkg, 149, "0.2.150", 21, 100, sha, url, pkg, 1, "0.2.136-android5-test.1");
        assertTrue(UpdatePolicy.matchingArchive(pkg, 1, pkg, 149, "0.2.150", 149, "0.2.150", new String[]{"original"}, new String[]{"original"}));
        assertFalse(UpdatePolicy.matchingArchive(pkg, 1, pkg, 149, "0.2.150", 149, "0.2.150", new String[]{"original"}, new String[]{"other"}));
        for (String[] values : new String[][]{{"android5", "standard", pkg},
                {"android5", "android5", "rocks.aston.hongguotv"},
                {"standard", "android5", pkg}, {"mpv", "android5", pkg}}) {
            try { UpdatePolicy.validateVariant(values[0], values[1], values[2], 21); fail("cross-edition accepted"); }
            catch (IllegalArgumentException expected) { /* expected */ }
        }
        for (int sdk : new int[]{20, 22, 23}) {
            try { UpdatePolicy.validateVariant("android5", "android5", pkg, sdk); fail("incompatible SDK accepted"); }
            catch (IllegalArgumentException expected) { /* expected */ }
        }
        for (String bad : new String[]{url.replace("android5-", ""), url.replace("android5-", "mpv-")}) {
            try { UpdatePolicy.validate(pkg, 149, "0.2.150", 21, 100, sha, bad, pkg, 1, "0.2.136-android5-test.1"); fail("foreign URL accepted"); }
            catch (IllegalArgumentException expected) { /* expected */ }
        }
    }
    @Test public void editionsUseIndependentChannelsAndCannotCrossInstall() {
        assertTrue(UpdatePolicy.manifestUrl("standard").endsWith("/update.json"));
        assertTrue(UpdatePolicy.manifestUrl("mpv").endsWith("/update-mpv.json"));
        UpdatePolicy.validateVariant("standard", "", "rocks.aston.hongguotv", 23);
        UpdatePolicy.validateVariant("mpv", "mpv", "rocks.aston.hongguotv.mpv", 23);
        for (String[] values : new String[][]{{"mpv", "", "rocks.aston.hongguotv.mpv"},
                {"standard", "mpv", "rocks.aston.hongguotv"},
                {"mpv", "mpv", "rocks.aston.hongguotv"}}) {
            try { UpdatePolicy.validateVariant(values[0], values[1], values[2], 23); fail("cross-edition accepted"); }
            catch (IllegalArgumentException expected) { /* expected */ }
        }
        String url = "https://github.com/aston314/hongguo-tv-releases/releases/download/v0.2.47/hongguo-tv-mpv-0.2.47.apk";
        String sha = new String(new char[64]).replace('\0', 'a');
        UpdatePolicy.validate("rocks.aston.hongguotv.mpv", 2, "0.2.47", 23, 100, sha, url, "rocks.aston.hongguotv.mpv", 1, "0.2.46");
        try { UpdatePolicy.validate("rocks.aston.hongguotv", 49, "0.2.47", 23, 100, sha, url, "rocks.aston.hongguotv", 48, "0.2.46"); fail("MPV URL accepted by standard"); }
        catch (IllegalArgumentException expected) { /* expected */ }
    }
    @Test public void checkThrottleAndClockChanges() {
        assertTrue(UpdatePolicy.automaticCheckDue(100, 0));
        assertFalse(UpdatePolicy.automaticCheckDue(1000, 100));
        assertTrue(UpdatePolicy.automaticCheckDue(1000, 2000));
        assertTrue(UpdatePolicy.automaticCheckDue(100 + UpdatePolicy.CHECK_INTERVAL, 100));
    }
    @Test public void builtInMirrorsAlwaysEndWithDirectSource() {
        assertArrayEquals(new String[]{
                        "https://gh-proxy.com/https://github.com/a",
                        "https://v4.gh-proxy.org/https://github.com/a",
                        "https://gh-proxy.org/https://github.com/a",
                        "https://ghfast.top/https://github.com/a",
                        "https://github.com/a"},
                UpdatePolicy.sources("https://github.com/a"));
    }
    @Test public void versionCodeAndCompleteSignerSetDecideInstall() {
        assertTrue(match(9, "0.2.10", new String[]{"A", "B"}, new String[]{"B", "A"}));
        assertFalse(match(8, "0.2.10", new String[]{"A"}, new String[]{"A"}));
        assertFalse(match(7, "0.2.10", new String[]{"A"}, new String[]{"A"}));
        assertFalse(match(9, "0.2.10", new String[]{"A"}, new String[]{"forged"}));
        assertFalse(match(9, "0.2.10", new String[0], new String[0]));
        assertFalse(UpdatePolicy.matchingArchive("app", 8, "other", 9, "0.2.10", 9, "0.2.10", new String[]{"A"}, new String[]{"A"}));
        assertFalse(UpdatePolicy.matchingArchive("app", 8, "app", 9, "0.2.9", 9, "0.2.10", new String[]{"A"}, new String[]{"A"}));
    }
    private boolean match(int code, String name, String[] left, String[] right) {
        return UpdatePolicy.matchingArchive("app", 8, "app", code, name, code, name, left, right);
    }
    @Test public void manifestRejectsForeignOrMutableDownloadTargets() {
        String url = "https://github.com/aston314/hongguo-tv-releases/releases/download/v0.2.7/hongguo-tv-0.2.7.apk";
        UpdatePolicy.validate("app", 9, "0.2.7", 23, 100, new String(new char[64]).replace('\0', 'a'), url, "app", 8, "0.2.6");
        for (String bad : new String[]{url.replace("github.com", "github.com.evil.test"), url.replace("download/v0.2.7", "latest/download"), url + "?token=x", url.replace("hongguo-tv-releases", "private-source")}) {
            try { UpdatePolicy.validate("app", 9, "0.2.7", 23, 100, new String(new char[64]).replace('\0', 'a'), bad, "app", 8, "0.2.6"); fail(bad); }
            catch (IllegalArgumentException expected) { /* expected */ }
        }
    }
    @Test public void staleOrInconsistentMetadataNeverClaimsCurrentVersion() {
        String sha = new String(new char[64]).replace('\0', 'a');
        for (String name : new String[]{"0.2.6", "0.2.8"}) {
            String url = "https://github.com/aston314/hongguo-tv-releases/releases/download/v" + name + "/hongguo-tv-" + name + ".apk";
            try { UpdatePolicy.validate("app", name.equals("0.2.6") ? 8 : 9, name, 23, 100, sha, url, "app", 9, "0.2.7"); fail("stale metadata accepted"); }
            catch (IllegalArgumentException expected) { /* Try the next transport. */ }
        }
        String url = "https://github.com/aston314/hongguo-tv-releases/releases/download/v0.2.7/hongguo-tv-0.2.7.apk";
        UpdatePolicy.validate("app", 9, "0.2.7", 23, 100, sha, url, "app", 9, "0.2.7");
    }
}
