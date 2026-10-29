package rocks.aston.hongguotv;

import java.util.HashSet;
import java.util.Set;

/** Filters queued libmpv events from the source that was replaced in place. */
final class MpvSourceSwitchState {
    private boolean active;
    private boolean replacementBoundary;
    private boolean newFileStarted;
    private boolean newFileLoaded;
    private boolean previousFileEnded;
    private long previousEntryId = -1;
    private long currentEntryId = -1;
    private final Set<Long> retiredEntryIds = new HashSet<>();

    void inheritRetiredEntries(MpvSourceSwitchState previous) {
        if (previous != null) retiredEntryIds.addAll(previous.retiredEntryIds);
    }

    void begin(long previousEntryId) {
        if (previousEntryId >= 0) retiredEntryIds.add(previousEntryId);
        active = true;
        replacementBoundary = true;
        newFileStarted = false;
        newFileLoaded = false;
        previousFileEnded = previousEntryId < 0;
        this.previousEntryId = previousEntryId;
        currentEntryId = -1;
    }

    boolean onStartFile(long playlistEntryId) {
        if (playlistEntryId < 0) return !replacementBoundary;
        if (retiredEntryIds.contains(playlistEntryId)) return false;
        if (!active) {
            if (replacementBoundary) return currentEntryId >= 0 && playlistEntryId == currentEntryId;
            currentEntryId = playlistEntryId;
            return true;
        }
        // libmpv documents END_FILE after the old file is unloaded and before
        // START_FILE for the replacement. FILE_LOADED and PLAYBACK_RESTART do
        // not carry an entry id, so this boundary is required to keep a late
        // old-source event from being attributed to the new source.
        if (!previousFileEnded) return false;
        // A replacement must have a distinct, tagged playlist entry. An
        // untagged event cannot safely be assigned to the new generation.
        if (playlistEntryId == previousEntryId) return false;
        currentEntryId = playlistEntryId;
        newFileStarted = true;
        return true;
    }

    boolean onFileLoaded() {
        if (!active) return true;
        if (!previousFileEnded || !newFileStarted) return false;
        newFileLoaded = true;
        return true;
    }

    boolean onPlaybackRestart() {
        if (!active) return true;
        if (!previousFileEnded || !newFileStarted || !newFileLoaded) return false;
        active = false;
        return true;
    }

    boolean isPreviousEntry(long playlistEntryId) {
        return active && previousEntryId >= 0 && playlistEntryId == previousEntryId;
    }

    boolean notePreviousEndFile(long playlistEntryId) {
        if (!isPreviousEntry(playlistEntryId)) return false;
        previousFileEnded = true;
        return true;
    }

    boolean acceptsEndFile(long playlistEntryId) {
        if (playlistEntryId < 0) return !replacementBoundary;
        if (retiredEntryIds.contains(playlistEntryId)) return false;
        if (active) return newFileStarted && currentEntryId >= 0 && playlistEntryId == currentEntryId;
        if (!replacementBoundary) return true;
        // Once an in-place replacement has crossed PLAYBACK_RESTART, an
        // untagged late END_FILE cannot be attributed safely. Only the
        // currently loaded playlist entry may close this generation.
        return currentEntryId >= 0 && playlistEntryId == currentEntryId;
    }

    boolean isActive() { return active; }

    void clear() {
        active = false;
        replacementBoundary = false;
        newFileStarted = false;
        newFileLoaded = false;
        previousFileEnded = false;
        previousEntryId = -1;
        currentEntryId = -1;
        retiredEntryIds.clear();
    }
}
