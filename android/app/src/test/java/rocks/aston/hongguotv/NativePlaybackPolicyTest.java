package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativePlaybackPolicyTest {
    @Test public void media3IsAvailableAsFallbackOnSupportedAndroid() {
        assertFalse(PlayerBridge.nativePlaybackAvailable(20));
        assertEquals(BuildConfig.ANDROID5_COMPAT_TEST, PlayerBridge.nativePlaybackAvailable(21));
        assertEquals(BuildConfig.ANDROID5_COMPAT_TEST, PlayerBridge.nativePlaybackAvailable(22));
        assertTrue(PlayerBridge.nativePlaybackAvailable(23));
        assertTrue(PlayerBridge.nativePlaybackAvailable(24));
        assertTrue(PlayerBridge.nativePlaybackAvailable(28));
        assertTrue(PlayerBridge.nativePlaybackAvailable(29));
        assertTrue(PlayerBridge.nativePlaybackAvailable(35));
    }
}
