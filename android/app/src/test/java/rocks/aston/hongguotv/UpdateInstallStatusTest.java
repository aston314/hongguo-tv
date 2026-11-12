package rocks.aston.hongguotv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.pm.PackageInstaller;
import org.junit.Test;

public class UpdateInstallStatusTest {
    @Test public void onlyPendingUserActionRequiresLaunchingConfirmationIntent() {
        assertTrue(UpdateInstallStatus.needsUserAction(PackageInstaller.STATUS_PENDING_USER_ACTION));
        assertFalse(UpdateInstallStatus.needsUserAction(PackageInstaller.STATUS_SUCCESS));
        assertFalse(UpdateInstallStatus.needsUserAction(PackageInstaller.STATUS_FAILURE_STORAGE));
    }

    @Test public void failuresExplainCommonInstallerOutcomesAndKeepSystemDetail() {
        assertEquals("设备存储空间不足", UpdateInstallStatus.message(PackageInstaller.STATUS_FAILURE_STORAGE, ""));
        assertEquals("系统未能识别此安装包（bad signature）",
                UpdateInstallStatus.message(PackageInstaller.STATUS_FAILURE_INVALID, " bad signature "));
    }

    @Test public void userRestrictionIsNotMisreportedAsAnIncompatibleApk() {
        String detail = "INSTALL_FAILED_USER_RESTRICTED: Failed INSTALL_CANCELED_BY_USER";
        assertEquals("系统限制了本次安装，可保存安装包后自行安装（" + detail + "）",
                UpdateInstallStatus.message(PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, detail));
        assertEquals("安装包与此设备不兼容（INSTALL_FAILED_NO_MATCHING_ABIS）",
                UpdateInstallStatus.message(PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, "INSTALL_FAILED_NO_MATCHING_ABIS"));
    }
}
