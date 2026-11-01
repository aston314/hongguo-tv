package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class TvViewportPolicyTest {
    @Test public void normalizesOnlyHighDensity1080pTvSurface() {
        assertEquals(1280, TvViewportPolicy.targetWidth(true, 1920, 1080, 320, 960, 540));
    }

    @Test public void preservesZidooViewportAndOtherDisplayProfiles() {
        assertEquals(0, TvViewportPolicy.targetWidth(true, 1920, 1080, 240, 1280, 646));
        assertEquals(0, TvViewportPolicy.targetWidth(true, 3840, 2160, 320, 1920, 1080));
        assertEquals(0, TvViewportPolicy.targetWidth(true, 1280, 720, 160, 1280, 720));
    }

    @Test public void unrecognizedDeviceFallsBackToBaseViewport() {
        assertEquals(0, TvViewportPolicy.targetWidth(false, 1920, 1080, 320, 960, 540));
        assertEquals(0, TvViewportPolicy.targetWidth(true, 1920, 1080, 320, 960, 0));
    }
}
