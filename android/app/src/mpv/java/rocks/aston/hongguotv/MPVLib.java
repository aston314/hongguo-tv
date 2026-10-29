package rocks.aston.hongguotv;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;
import java.util.ArrayList;
import java.util.List;

/** Small MIT-licensed libmpv client. Native calls and callbacks belong to the UI thread. */
final class MPVLib {
    static {
        System.loadLibrary("mpv");
        System.loadLibrary("hongguompv");
    }
    interface EventObserver {
        void eventProperty(String name, boolean value);
        void event(int value);
        void outputMessage(int component, int level);
        void startFile(long playlistEntryId);
        void endFile(int reason, int error, long playlistEntryId);
        void commandReply(long requestId, int error);
        void eventsDrained();
        void error();
    }
    static final class MpvEvent {
        static final int MPV_EVENT_LOG_MESSAGE = 2;
        static final int MPV_EVENT_COMMAND_REPLY = 5;
        static final int MPV_EVENT_START_FILE = 6;
        static final int MPV_EVENT_END_FILE = 7;
        static final int MPV_EVENT_FILE_LOADED = 8;
        static final int MPV_EVENT_PLAYBACK_RESTART = 21;
        static final int MPV_EVENT_PROPERTY_CHANGE = 22;
    }
    static final class MpvFormat { static final int MPV_FORMAT_FLAG = 3; }
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<EventObserver> observers = new ArrayList<>();
    private final List<String> properties = new ArrayList<>();
    private long pointer;
    private boolean initialized;

    static MPVLib create(Context ignored) { return new MPVLib(); }
    private MPVLib() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("MPV requires UI thread");
        pointer = nativeCreate(); if (pointer == 0) throw new IllegalStateException("Cannot create MPV");
    }
    private long handle() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("MPV requires UI thread");
        if (pointer == 0) throw new IllegalStateException("MPV released");
        return pointer;
    }
    void init() {
        nativeInit(handle()); initialized = true;
        handler.post(poll);
    }
    void addObserver(EventObserver observer) { handle(); observers.add(observer); }
    void observeProperty(String name, int format) {
        if (format != MpvFormat.MPV_FORMAT_FLAG) throw new IllegalArgumentException("Only flag properties are observed");
        nativeObserve(handle(), properties.size() + 1, name);
        properties.add(name);
    }
    int setOptionString(String name, String value) { return nativeOption(handle(), name, value); }
    void setPropertyBoolean(String name, boolean value) { nativeSet(handle(), name, value ? "yes" : "no"); }
    void setPropertyDouble(String name, double value) { nativeSet(handle(), name, Double.toString(value)); }
    void setPropertyString(String name, String value) { nativeSet(handle(), name, value); }
    Double getPropertyDouble(String name) { return nativeDouble(handle(), name); }
    Integer getPropertyInt(String name) { Double value = getPropertyDouble(name); return value == null ? null : value.intValue(); }
    Boolean getPropertyBoolean(String name) { return nativeFlag(handle(), name); }
    String getPropertyString(String name) { return nativeString(handle(), name); }
    void command(String[] args) { nativeCommand(handle(), args); }
    void commandAsync(String[] args, long requestId) { nativeCommandAsync(handle(), requestId, args); }
    void attachSurface(Surface surface) { nativeSurface(handle(), surface); }
    void detachSurface() { nativeSurface(handle(), null); }
    void destroy() {
        if (pointer == 0) return;
        long old = handle(); pointer = 0; initialized = false;
        handler.removeCallbacks(poll); observers.clear(); properties.clear();
        nativeDestroy(old);
    }
    private final Runnable poll = new Runnable() {
        @Override public void run() {
            if (pointer == 0 || !initialized) return;
            boolean queueEmpty = false;
            try {
                // Bounded, non-blocking draining avoids a native event thread
                // racing source replacement or a released Java surface.
                for (int count = 0; count < 32 && pointer != 0; count++) {
                    long[] event = nativePoll(pointer);
                    if (event == null) { queueEmpty = true; break; }
                    int kind = (int) event[0];
                    List<EventObserver> snapshot = new ArrayList<>(observers);
                    for (EventObserver observer : snapshot) {
                        if (pointer == 0) break;
                        int index = (int) event[1] - 1;
                        if (kind == MpvEvent.MPV_EVENT_PROPERTY_CHANGE) {
                            if (index >= 0 && index < properties.size() && event[2] >= 0)
                                observer.eventProperty(properties.get(index), event[2] != 0);
                        } else if (kind == MpvEvent.MPV_EVENT_LOG_MESSAGE) {
                            if (event[3] > 0) observer.outputMessage((int) event[3], (int) event[2]);
                        } else if (kind == MpvEvent.MPV_EVENT_END_FILE) {
                            observer.endFile((int) event[2], (int) event[3], event[4]);
                        } else if (kind == MpvEvent.MPV_EVENT_START_FILE) {
                            observer.startFile(event[4]);
                        } else if (kind == MpvEvent.MPV_EVENT_COMMAND_REPLY) {
                            observer.commandReply(event[1], (int) event[2]);
                        } else observer.event(kind);
                    }
                }
                if (queueEmpty) for (EventObserver observer : new ArrayList<>(observers)) observer.eventsDrained();
            } catch (RuntimeException failure) {
                initialized = false;
                for (EventObserver observer : new ArrayList<>(observers)) observer.error();
            } finally { if (pointer != 0 && initialized) handler.postDelayed(this, 50); }
        }
    };
    private static native long nativeCreate();
    private static native void nativeInit(long pointer);
    private static native void nativeDestroy(long pointer);
    private static native long[] nativePoll(long pointer);
    private static native void nativeObserve(long pointer, int id, String name);
    private static native int nativeOption(long pointer, String name, String value);
    private static native void nativeSet(long pointer, String name, String value);
    private static native Double nativeDouble(long pointer, String name);
    private static native Boolean nativeFlag(long pointer, String name);
    private static native String nativeString(long pointer, String name);
    private static native void nativeCommand(long pointer, String[] args);
    private static native void nativeCommandAsync(long pointer, long requestId, String[] args);
    private static native void nativeSurface(long pointer, Surface surface);
}
