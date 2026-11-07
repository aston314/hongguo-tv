package rocks.aston.hongguotv;

/** Keep installer fallback order explicit and testable across Android editions. */
final class UpdateInstallPolicy {
    static final String VIEW = "view";
    static final String INSTALL_PACKAGE = "install_package";
    static final String SESSION = "session";
    static final String SETTINGS = "settings";

    private UpdateInstallPolicy() {}

    static String[] routes(boolean canUsePackageInstallerSession) {
        return canUsePackageInstallerSession
                ? new String[]{VIEW, INSTALL_PACKAGE, SESSION}
                : new String[]{VIEW, INSTALL_PACKAGE, SETTINGS};
    }

    static String retryRoute(String attemptedRoute) {
        return VIEW.equals(attemptedRoute) ? INSTALL_PACKAGE : VIEW;
    }

    static boolean canUsePackageInstallerSession(int sdk, boolean canRequestInstalls) {
        return sdk < 26 || canRequestInstalls;
    }
}
