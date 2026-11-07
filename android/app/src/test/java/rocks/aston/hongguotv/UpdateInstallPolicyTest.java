package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdateInstallPolicyTest {
    @Test public void installerIntentsAreTriedBeforePermissionSettings() {
        assertArrayEquals(new String[]{UpdateInstallPolicy.VIEW, UpdateInstallPolicy.INSTALL_PACKAGE,
                        UpdateInstallPolicy.SETTINGS}, UpdateInstallPolicy.routes(false));
        assertArrayEquals(new String[]{UpdateInstallPolicy.VIEW, UpdateInstallPolicy.INSTALL_PACKAGE,
                        UpdateInstallPolicy.SESSION}, UpdateInstallPolicy.routes(true));
    }

    @Test public void retryAfterReturningFromInstallerOffersTheOtherIntent() {
        assertEquals(UpdateInstallPolicy.INSTALL_PACKAGE, UpdateInstallPolicy.retryRoute(UpdateInstallPolicy.VIEW));
        assertEquals(UpdateInstallPolicy.VIEW, UpdateInstallPolicy.retryRoute(UpdateInstallPolicy.INSTALL_PACKAGE));
        assertEquals(UpdateInstallPolicy.VIEW, UpdateInstallPolicy.retryRoute(UpdateInstallPolicy.SESSION));
        assertEquals(UpdateInstallPolicy.VIEW, UpdateInstallPolicy.retryRoute(""));
    }

    @Test public void packageInstallerSessionStillRequiresItsPermissionOnAndroidOreoAndNewer() {
        assertTrue(UpdateInstallPolicy.canUsePackageInstallerSession(23, false));
        assertTrue(UpdateInstallPolicy.canUsePackageInstallerSession(25, false));
        assertFalse(UpdateInstallPolicy.canUsePackageInstallerSession(26, false));
        assertFalse(UpdateInstallPolicy.canUsePackageInstallerSession(34, false));
        assertTrue(UpdateInstallPolicy.canUsePackageInstallerSession(26, true));
        assertTrue(UpdateInstallPolicy.canUsePackageInstallerSession(34, true));
    }
}
