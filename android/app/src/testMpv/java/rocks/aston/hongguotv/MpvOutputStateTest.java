package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class MpvOutputStateTest {
    @Test public void onlyVideoDecodeErrorsPermitDecodeFallback() {
        MpvOutputState state = new MpvOutputState();
        assertFalse(state.videoDecodeError());
        state.message(2, 10);
        assertFalse(state.videoDecodeError());
        state.message(3, 20);
        assertTrue(state.videoDecodeError());
        state.message(3, 30);
        assertTrue(state.videoDecodeError());
    }
    @Test public void recreatedSurfaceAllowsDeferredStartButRejectsStaleAndDuplicateStarts() {
        assertFalse(MpvStartPolicy.mayStart(true, false, false));
        assertTrue(MpvStartPolicy.mayStart(true, false, true));
        assertFalse(MpvStartPolicy.mayStart(false, false, true));
        assertFalse(MpvStartPolicy.mayStart(true, true, true));
    }

    private MpvOutputState configured() {
        MpvOutputState state = new MpvOutputState();
        state.loaded = state.attached = state.restarted = state.configured = true;
        state.vo = "gpu"; state.width = 720; state.height = 1280;
        state.surfaceWidth = 1280; state.surfaceHeight = 720;
        return state;
    }

    @Test public void restartAndVideoDimensionsDoNotProveAnAttachedVideoOutput() {
        MpvOutputState state = configured();
        assertTrue(state.ready(true));
        assertFalse(state.ready(false));
        state.attached = false; assertFalse(state.ready(true));
        state.attached = true; state.surfaceWidth = 0; assertFalse(state.ready(true));
        state.surfaceWidth = 1280; state.configured = false; assertFalse(state.ready(true));
        state.configured = true; state.vo = "null"; assertFalse(state.ready(true));
    }

    @Test public void configuredIdleWindowDoesNotReleaseLoadingUntilLoadedAndRestarted() {
        MpvOutputState state = configured();
        state.loaded = false; assertFalse(state.ready(true));
        state.loaded = true; state.restarted = false; assertFalse(state.ready(true));
        state.restarted = true; state.height = 0; assertFalse(state.ready(true));
        assertFalse(new MpvOutputState().ready(true));
    }

    @Test public void warningsStayBoundedAndRetainHighestSeverityWithoutRawLogs() {
        MpvOutputState state = new MpvOutputState();
        state.message(2, 30); state.message(2, 20); state.message(2, 30);
        state.message(1, 30); state.message(0, 20); state.message(3, 50);
        assertEquals("视频输出警告 · 音频输出错误", state.messages());
        assertEquals("", new MpvOutputState().messages());
    }
}
