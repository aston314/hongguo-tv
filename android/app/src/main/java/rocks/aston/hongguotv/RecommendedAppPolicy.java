package rocks.aston.hongguotv;

import java.net.URI;
import java.util.Arrays;

/** An installation-only allowlist, independent of Hongguo's update channel. */
final class RecommendedAppPolicy {
    static final class App {
        final String id, packageName, repository, manifestUrl, filePrefix, signer;
        final boolean releaseApi;
        final int minSdk = 23;
        App(String id, String packageName, String repository, String manifestUrl, String filePrefix) {
            this(id, packageName, repository, manifestUrl, filePrefix,
                    "117dc57341c638a6f416ef256e0d9893bcdf7961acfc4c1b270b79bea8b6785f", false);
        }
        App(String id, String packageName, String repository, String manifestUrl, String filePrefix, String signer, boolean releaseApi) {
            this.id = id; this.packageName = packageName; this.repository = repository;
            this.manifestUrl = manifestUrl; this.filePrefix = filePrefix;
            this.signer = signer; this.releaseApi = releaseApi;
        }
    }
    static final App[] APPS = {
        new App("doudou", "rocks.aston.doudoutv", "aston314/doudou-tv-releases",
                "https://raw.githubusercontent.com/aston314/doudou-tv-releases/main/update.json", "doudou-tv-"),
        new App("sports", "cc.kafeizhibo.tv", "aston314/kafeizhibo-tv",
                "https://github.com/aston314/kafeizhibo-tv/releases/latest/download/update.json", "sports-live-tv-"),
        new App("yunying", "cc.yunying.tv", "aston314/yunying-tv-releases",
                "https://api.github.com/repos/aston314/yunying-tv-releases/releases/latest", "yunying-tv-",
                "0871aeb15cbb0bc153a2b76cc73338e2476d5d1855058f1381145b68d669f845", true)
    };
    static App find(String id) {
        for (App app : APPS) if (app.id.equals(id)) return app;
        throw new IllegalArgumentException("unknown_app");
    }
    static String[] sources(String origin) {
        String[] sources = new String[UpdatePolicy.BUILTIN_PROXIES.length];
        for (int i = 0; i < sources.length; i++) sources[i] = UpdatePolicy.BUILTIN_PROXIES[i] + origin;
        return sources;
    }
    static String nextInstallRoute(String attempted) {
        if (UpdateInstallPolicy.VIEW.equals(attempted)) return UpdateInstallPolicy.INSTALL_PACKAGE;
        if (UpdateInstallPolicy.INSTALL_PACKAGE.equals(attempted)) return UpdateInstallPolicy.SESSION;
        return UpdateInstallPolicy.VIEW;
    }
    static void validate(App app, String pkg, int code, String version, int minSdk,
                         long size, String sha, String download) {
        if (!app.packageName.equals(pkg) || code < 0 || code == 0 && !app.releaseApi || version == null
                || !version.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")
                || minSdk < app.minSdk || size <= 0 || size > UpdatePolicy.MAX_APK_BYTES
                || sha == null || !sha.matches("[a-fA-F0-9]{64}"))
            throw new IllegalArgumentException("invalid_manifest");
        URI uri = URI.create(download);
        String path = "/" + app.repository + "/releases/download/v" + version + "/" + app.filePrefix + version + ".apk";
        if (!"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost())
                || uri.getPort() != -1 || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                || uri.getRawFragment() != null || !path.equals(uri.getRawPath()))
            throw new IllegalArgumentException("invalid_download");
    }
    static boolean matchingArchive(App app, String pkg, int code, String version,
                                   int expectedCode, String expectedVersion, String[] signers) {
        return app.packageName.equals(pkg) && code > 0
                && (code == expectedCode || expectedCode == 0 && app.releaseApi) && expectedVersion.equals(version)
                && signers != null && Arrays.equals(new String[]{app.signer}, signers);
    }
}
