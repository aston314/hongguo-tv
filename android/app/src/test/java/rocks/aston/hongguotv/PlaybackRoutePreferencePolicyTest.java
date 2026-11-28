package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class PlaybackRoutePreferencePolicyTest {
    @Test public void missingAndInvalidPreferencesPreserveAutomaticPlayback() {
        for (String mode : new String[]{null, "", "html5", "mpv", "software", "MEDIA3"}) {
            assertFalse(PlaybackRoutePreferencePolicy.valid(mode));
            assertEquals("auto", PlaybackRoutePreferencePolicy.normalize(mode));
            assertFalse(PlaybackRoutePreferencePolicy.primary("webview_media3", true, mode));
        }
        assertTrue(PlaybackRoutePreferencePolicy.valid("auto"));
        assertTrue(PlaybackRoutePreferencePolicy.valid("media3"));
        assertEquals("media3", PlaybackRoutePreferencePolicy.normalize("media3"));
    }

    @Test public void manualPrimaryRouteRequiresAnAvailableStandardPlayer() {
        assertTrue(PlaybackRoutePreferencePolicy.supported("webview_media3", true));
        assertTrue(PlaybackRoutePreferencePolicy.primary("webview_media3", true, "media3"));
        assertFalse(PlaybackRoutePreferencePolicy.primary("webview_media3", true, "auto"));
        assertFalse(PlaybackRoutePreferencePolicy.primary("webview_media3", false, "media3"));
        for (String engine : new String[]{null, "", "mpv", "media3", "desktop", "webos"}) {
            assertFalse(PlaybackRoutePreferencePolicy.supported(engine, true));
            assertFalse(PlaybackRoutePreferencePolicy.primary(engine, true, "media3"));
        }
    }
}
