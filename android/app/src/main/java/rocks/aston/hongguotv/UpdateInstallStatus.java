package rocks.aston.hongguotv;

import android.content.pm.PackageInstaller;

final class UpdateInstallStatus {
    private UpdateInstallStatus() {}

    static boolean needsUserAction(int status) {
        return status == PackageInstaller.STATUS_PENDING_USER_ACTION;
    }

    static String message(int status, String detail) {
        return message(status, detail, 0);
    }

    /**
     * Android 6 vendor installers sometimes report a user or installer policy
     * failure as STATUS_FAILURE_INCOMPATIBLE. Keep a real ABI/SDK error clear,
     * but direct the ambiguous legacy result to the verified APK fallback.
     */
    static String message(int status, String detail, int sdk) {
        String reason;
        // Some Android 6 ROMs map a user restriction to STATUS_FAILURE_INCOMPATIBLE.
        // The legacy detail distinguishes it from actual ABI/SDK incompatibility.
        if (detail != null && detail.contains("INSTALL_FAILED_USER_RESTRICTED")) {
            return "系统限制了本次安装，可保存安装包后自行安装（" + detail.trim() + "）";
        }
        if (legacyInstallerFailure(status, detail, sdk)) {
            return appendDetail("系统安装器未完成，可保存安装包后自行安装", detail);
        }
        switch (status) {
            case PackageInstaller.STATUS_FAILURE_ABORTED:
                reason = "安装已取消";
                break;
            case PackageInstaller.STATUS_FAILURE_BLOCKED:
                reason = "设备安全策略阻止了安装";
                break;
            case PackageInstaller.STATUS_FAILURE_CONFLICT:
                reason = "安装包与设备中现有应用冲突";
                break;
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE:
                reason = "安装包与此设备不兼容";
                break;
            case PackageInstaller.STATUS_FAILURE_INVALID:
                reason = "系统未能识别此安装包";
                break;
            case PackageInstaller.STATUS_FAILURE_STORAGE:
                reason = "设备存储空间不足";
                break;
            case PackageInstaller.STATUS_FAILURE_TIMEOUT:
                reason = "系统安装器响应超时";
                break;
            default:
                reason = "系统安装未完成";
                break;
        }
        return appendDetail(reason, detail);
    }

    static boolean legacyInstallerFailure(int status, String detail, int sdk) {
        if (status != PackageInstaller.STATUS_FAILURE_INCOMPATIBLE || sdk < 23 || sdk > 25) return false;
        String value = detail == null ? "" : detail.toUpperCase(java.util.Locale.ROOT);
        return !(value.contains("NO_MATCHING_ABIS")
                || value.contains("CPU_ABI")
                || value.contains("OLDER_SDK")
                || value.contains("NEWER_SDK")
                || value.contains("MISSING_FEATURE")
                || value.contains("INVALID_APK"));
    }

    private static String appendDetail(String reason, String detail) {
        if (detail != null && !detail.trim().isEmpty()) return reason + "（" + detail.trim() + "）";
        return reason;
    }
}
