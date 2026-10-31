package rocks.aston.hongguotv;

/** One speculative source, owned by the currently playing load, never a second player. */
final class NativePreloadLease {
    static final long MAX_AGE_MS = 120000;
    final String owner, key, source;
    final long startedAt;
    long readyMs = -1;
    boolean failed, claimed;
    NativePreloadLease(String owner, String key, String source, long now) {
        this.owner=owner;this.key=key;this.source=source;this.startedAt=now;
    }
    boolean claim(String key, String source, long position, int candidate, long now) {
        if(failed||claimed||position!=0||candidate!=0||now<startedAt||now-startedAt>MAX_AGE_MS
                ||!this.key.equals(key)||!this.source.equals(source))return false;
        claimed=true;return true;
    }
    boolean cancel(String key) {
        if(claimed||!this.key.equals(key))return false;
        failed=true;return true;
    }
    void completed(long now) {if(!failed&&!claimed)readyMs=Math.max(0,now-startedAt);}
}
