package rocks.aston.hongguotv;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Event-order contract for an in-place libmpv source replacement. */
public final class MpvSourceSwitchStateTest {
    @Test public void onlyTheNewEntryCanCrossTheReplacementBoundary() {
        MpvSourceSwitchState state = new MpvSourceSwitchState();
        state.begin(10);

        assertFalse(state.onStartFile(10));
        assertFalse(state.acceptsEndFile(10));
        assertFalse(state.onStartFile(11));
        assertFalse(state.onFileLoaded());
        assertTrue(state.notePreviousEndFile(10));
        assertTrue(state.onStartFile(11));
        assertTrue(state.onFileLoaded());
        assertFalse(state.acceptsEndFile(10));
        assertTrue(state.onPlaybackRestart());
        assertTrue(state.acceptsEndFile(11));
        assertFalse(state.onStartFile(10));
    }

    @Test public void anUntaggedEventCannotCloseTheReplacementGeneration() {
        MpvSourceSwitchState state = new MpvSourceSwitchState();
        state.begin(20);

        assertFalse(state.onStartFile(-1));
        assertFalse(state.onFileLoaded());
        assertFalse(state.onPlaybackRestart());

        assertFalse(state.onStartFile(21));
        assertTrue(state.notePreviousEndFile(20));

        assertTrue(state.onStartFile(21));
        assertTrue(state.onFileLoaded());
        assertTrue(state.onPlaybackRestart());
        assertFalse(state.acceptsEndFile(-1));
        assertFalse(state.onStartFile(-1));
    }

    @Test public void rapidSecondReplacementCarriesRetiredEntryIdsForward() {
        MpvSourceSwitchState episodeA = new MpvSourceSwitchState();
        episodeA.onStartFile(30);

        MpvSourceSwitchState episodeB = new MpvSourceSwitchState();
        episodeB.inheritRetiredEntries(episodeA);
        episodeB.begin(30);
        assertTrue(episodeB.notePreviousEndFile(30));
        assertTrue(episodeB.onStartFile(31));
        assertTrue(episodeB.onFileLoaded());
        assertTrue(episodeB.onPlaybackRestart());

        MpvSourceSwitchState episodeC = new MpvSourceSwitchState();
        episodeC.inheritRetiredEntries(episodeB);
        episodeC.begin(31);
        assertFalse(episodeC.onStartFile(30));
        assertFalse(episodeC.onStartFile(31));
        assertFalse(episodeC.acceptsEndFile(30));
        assertFalse(episodeC.acceptsEndFile(31));
        assertTrue(episodeC.notePreviousEndFile(31));
        assertTrue(episodeC.onStartFile(32));
        assertTrue(episodeC.onFileLoaded());
        assertTrue(episodeC.onPlaybackRestart());
        assertFalse(episodeC.acceptsEndFile(30));
        assertFalse(episodeC.acceptsEndFile(31));
        assertTrue(episodeC.acceptsEndFile(32));
    }

    @Test public void normalSessionWithoutReplacementBoundaryAcceptsItsEndFile() {
        MpvSourceSwitchState state = new MpvSourceSwitchState();
        assertTrue(state.onStartFile(40));
        assertTrue(state.acceptsEndFile(40));
        assertTrue(state.acceptsEndFile(-1));
    }

    @Test public void clearReturnsStateToNormalSessionMode() {
        MpvSourceSwitchState state = new MpvSourceSwitchState();
        state.begin(50);
        assertTrue(state.notePreviousEndFile(50));
        state.onStartFile(51);
        state.onFileLoaded();
        state.onPlaybackRestart();
        state.clear();

        assertTrue(state.onStartFile(52));
        assertTrue(state.acceptsEndFile(-1));
    }
}
