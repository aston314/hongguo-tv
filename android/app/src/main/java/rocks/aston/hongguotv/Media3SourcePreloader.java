package rocks.aston.hongguotv;

import android.content.Context;
import android.os.Handler;
import android.os.SystemClock;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.RenderersFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.preload.DefaultPreloadManager;
import androidx.media3.exoplayer.source.preload.PreloadException;
import androidx.media3.exoplayer.source.preload.PreloadManagerListener;

/** UI-thread owned sample preparation. Shares components with one ExoPlayer; no decoder is prestarted. */
@android.annotation.SuppressLint("UnsafeOptInUsageError")
final class Media3SourcePreloader {
    interface Events { void state(NativePreloadLease lease,String state); }
    static final class Claim {
        final MediaSource source;
        final MediaItem item;
        final NativePreloadLease lease;
        Claim(MediaSource source,MediaItem item,NativePreloadLease lease){this.source=source;this.item=item;this.lease=lease;}
    }
    private final DefaultPreloadManager.Builder builder;
    private final DefaultPreloadManager manager;
    private final Handler handler;
    private final Events events;
    private NativePreloadLease next;
    private MediaItem nextItem, playingItem;
    private Runnable timeout;
    private int rank;

    Media3SourcePreloader(Context context,Handler handler,RenderersFactory renderers,MediaSource.Factory sources,Events events) {
        this.handler=handler;this.events=events;
        builder=new DefaultPreloadManager.Builder(context, ignored->DefaultPreloadManager.PreloadStatus.specifiedRangeLoaded(1500))
            .setRenderersFactory(renderers).setMediaSourceFactory(sources);
        manager=builder.build();
        manager.addListener(new PreloadManagerListener(){
            @Override public void onCompleted(MediaItem item){
                if(next==null||nextItem==null||!nextItem.mediaId.equals(item.mediaId))return;
                next.completed(SystemClock.elapsedRealtime());clearTimeout();events.state(next,"ready");
            }
            @Override public void onError(PreloadException error){
                if(nextItem!=null&&nextItem.mediaId.equals(error.mediaItem.mediaId))discard("error");
            }
        });
    }
    ExoPlayer buildPlayer(ExoPlayer.Builder playerBuilder){return builder.buildExoPlayer(playerBuilder);}
    void offer(String owner,String key,String source){
        if(next!=null&&next.owner.equals(owner)&&next.key.equals(key)&&next.source.equals(source))return;
        discard("replaced");
        next=new NativePreloadLease(owner,key,source,SystemClock.elapsedRealtime());
        nextItem=new MediaItem.Builder().setMediaId(key).setUri(source).setMimeType(MimeTypes.VIDEO_MP4).build();
        manager.add(nextItem,++rank);manager.invalidate();events.state(next,"queued");
        final NativePreloadLease lease=next;
        timeout=()->{if(next==lease)discard("timeout");};handler.postDelayed(timeout,10000);
    }
    Claim take(String key,String source,long position,int candidate){
        if(next==null||!next.claim(key,source,position,candidate,SystemClock.elapsedRealtime())){
            discard("miss");return null;
        }
        MediaSource prepared=manager.getMediaSource(nextItem);
        if(prepared==null){discard("miss");return null;}
        clearTimeout();Claim claim=new Claim(prepared,nextItem,next);
        events.state(next,"claimed");next=null;nextItem=null;manager.setCurrentPlayingIndex(rank);return claim;
    }
    // Call only after the player has attached the new source and queued prepare.
    void activated(Claim claim){
        MediaItem previous=playingItem;playingItem=claim==null?null:claim.item;
        if(previous!=null&&previous!=playingItem)manager.remove(previous);
    }
    void cancel(String key){if(next!=null&&next.cancel(key))discard("cancelled");}
    void discard(String reason){
        clearTimeout();NativePreloadLease previous=next;MediaItem item=nextItem;next=null;nextItem=null;
        if(previous!=null){previous.failed=true;events.state(previous,reason);}
        if(item!=null)manager.remove(item);
    }
    void release(){discard("released");manager.release();playingItem=null;}
    private void clearTimeout(){if(timeout!=null){handler.removeCallbacks(timeout);timeout=null;}}
}
