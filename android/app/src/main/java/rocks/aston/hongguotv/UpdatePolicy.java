package rocks.aston.hongguotv;

import java.net.URI;
import java.util.Arrays;
import java.util.Locale;

/** Rules shared by checking, downloading and the final installer hand-off. */
final class UpdatePolicy {
    static final String REPOSITORY = "aston314/hongguo-tv-releases";
    static String manifestUrl(String variant) {
        return "https://raw.githubusercontent.com/" + REPOSITORY + "/main/" +
                ("android5".equals(variant) ? "update-android5.json" : "mpv".equals(variant) ? "update-mpv.json" : "update.json");
    }
    static String edition(String variant) {
        return "android5".equals(variant) ? "Android 5 兼容版" : "mpv".equals(variant) ? "MPV 版" : "标准版";
    }
    static void validateVariant(String variant, String declared, String packageName, int minSdk) {
        boolean android5 = "android5".equals(variant);
        if (!("standard".equals(variant) || "mpv".equals(variant) || android5)
                || !(variant.equals(declared) || "standard".equals(variant) && declared.isEmpty())
                || !("rocks.aston.hongguotv" + (android5 ? ".android5test" : "mpv".equals(variant) ? ".mpv" : "")).equals(packageName)
                || (android5 ? minSdk != 21 : minSdk < 23))
            throw new IllegalArgumentException("更新包与当前应用版本类型不匹配");
    }
    /** Ordered public mirrors. The GitHub URL remains the final fallback. */
    static final String[] BUILTIN_PROXIES = new String[]{
            "https://gh-proxy.com/",
            "https://v4.gh-proxy.org/",
            "https://gh-proxy.org/",
            "https://ghfast.top/"
    };
    static final long MAX_APK_BYTES = 100L * 1024 * 1024;
    static final long CHECK_INTERVAL = 24L * 60 * 60 * 1000;

    static boolean automaticCheckDue(long now, long lastAttempt) {
        return lastAttempt <= 0 || lastAttempt > now || now - lastAttempt >= CHECK_INTERVAL;
    }

    static String[] sources(String origin) {
        String[] result = new String[BUILTIN_PROXIES.length + 1];
        for (int i = 0; i < BUILTIN_PROXIES.length; i++) result[i] = BUILTIN_PROXIES[i] + origin;
        result[BUILTIN_PROXIES.length] = origin;
        return result;
    }

    static void validate(String packageName, int code, String name, int minSdk, long bytes,
                         String sha256, String download, String installedPackage, int installedCode, String installedName) {
        if (code < installedCode || code == installedCode && !installedName.equals(name))
            throw new IllegalArgumentException("更新信息尚未刷新或版本不一致，请稍后重试");
        if (!installedPackage.equals(packageName) || code <= 0 || name == null
                || !name.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")
                || ("rocks.aston.hongguotv.android5test".equals(installedPackage) ? minSdk != 21 : minSdk < 23)
                || bytes <= 0 || bytes > MAX_APK_BYTES
                || sha256 == null || !sha256.matches("[a-fA-F0-9]{64}"))
            throw new IllegalArgumentException("版本信息不完整或不匹配");
        URI uri = URI.create(download);
        String path = uri.getRawPath();
        String prefix = "/" + REPOSITORY + "/releases/download/v" + name + "/";
        if (!"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost())
                || uri.getRawUserInfo() != null || uri.getPort() != -1
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || path == null || !path.equals(prefix + "hongguo-tv-" +
                    (installedPackage.endsWith(".android5test") ? "android5-" : installedPackage.endsWith(".mpv") ? "mpv-" : "") + name + ".apk"))
            throw new IllegalArgumentException("安装包地址不是红果短剧公开发行文件");
    }

    static boolean matchingArchive(String installedPackage, int installedCode, String archivePackage,
                                   int archiveCode, String archiveName, int expectedCode, String expectedName,
                                   String[] installedSigners, String[] archiveSigners) {
        if (!installedPackage.equals(archivePackage) || archiveCode <= installedCode
                || archiveCode != expectedCode || !expectedName.equals(archiveName)
                || installedSigners == null || archiveSigners == null
                || installedSigners.length == 0 || installedSigners.length != archiveSigners.length) return false;
        String[] left = installedSigners.clone(), right = archiveSigners.clone();
        Arrays.sort(left); Arrays.sort(right);
        return Arrays.equals(left, right);
    }

    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
