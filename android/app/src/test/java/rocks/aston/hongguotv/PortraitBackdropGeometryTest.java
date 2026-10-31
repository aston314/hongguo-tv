package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class PortraitBackdropGeometryTest {
    @Test public void cropRemovesSurfaceLetterboxAndStaysInsideBuffer() {
        assertArrayEquals(new int[]{437, 0, 842, 720}, PortraitBackdropGeometry.crop(1280, 720, 9.0/16));
        assertArrayEquals(new int[]{0, 0, 405, 720}, PortraitBackdropGeometry.crop(405, 720, 9.0/16));
        assertArrayEquals(new int[]{0, 320, 360, 960}, PortraitBackdropGeometry.crop(360, 1280, 9.0/16));
        int[] odd = PortraitBackdropGeometry.crop(1279, 719, 9.0/16);
        assertTrue(odd[0]>=0 && odd[1]>=0 && odd[2]<=1279 && odd[3]<=719);
    }
    @Test public void unknownOrLandscapeGeometryCannotStartCapture() {
        for (double aspect : new double[]{0, -1, 1, 16.0/9, Double.NaN, Double.POSITIVE_INFINITY})
            assertNull(PortraitBackdropGeometry.crop(1280, 720, aspect));
        assertNull(PortraitBackdropGeometry.crop(0,720,0.5));
        assertNull(PortraitBackdropGeometry.crop(1280,1,0.5));
    }
    @Test public void callbacksAcceptOnlyBoundedOpaqueLoadAndRequestIds() {
        assertTrue(PortraitBackdropGeometry.validRequest("load_123-a", "103"));
        assertFalse(PortraitBackdropGeometry.validRequest(null,"1"));
        assertFalse(PortraitBackdropGeometry.validRequest("a","x"));
        assertFalse(PortraitBackdropGeometry.validRequest("a\";alert(1)","1"));
        assertFalse(PortraitBackdropGeometry.validRequest("a","12345678901234567"));
    }
}
