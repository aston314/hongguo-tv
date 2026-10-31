package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public final class MpvDecodeMemoryTest {
    @Test public void remembersNormalizedCodecsAndIgnoresEmptyValues() {
        MpvDecodeMemory memory = new MpvDecodeMemory(" HEVC:yuv420p:1920x1080;avc:nv12:1280x720 ");
        assertTrue(memory.isBroken("hevc:yuv420p:1920x1080"));
        assertTrue(memory.isBroken("AVC:NV12:1280x720"));
        assertFalse(memory.isBroken("vp9:yuv420p:1920x1080"));
        assertFalse(memory.learn(" "));
    }

    @Test public void duplicateAndUnboundedValuesDoNotGrowMemory() {
        MpvDecodeMemory memory = new MpvDecodeMemory(null);
        for (int i = 0; i < 8; i++) assertTrue(memory.learn("codec-" + i + ":yuv420p:1920x1080"));
        assertFalse(memory.learn("codec-8:yuv420p:1920x1080"));
        assertFalse(memory.learn("codec-1:yuv420p:1920x1080"));
    }

    @Test public void profileRequiresACompleteBoundedIdentity() {
        assertEquals("hevc:yuv420p:1920x1080",
            MpvDecodeMemory.profile(" HEVC ", " yuv420p ", 1920, 1080));
        assertEquals("", MpvDecodeMemory.profile("hevc", "", 1920, 1080));
        assertEquals("", MpvDecodeMemory.profile("hevc", "yuv420p", 0, 1080));
    }
}
