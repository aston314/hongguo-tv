package rocks.aston.hongguotv;

import android.graphics.Matrix;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.media3.common.MediaItem;
import androidx.media3.common.C;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.Format;
import androidx.media3.common.VideoSize;
import androidx.media3.common.Tracks;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** UI-thread owned player. Sources share one ExoPlayer and Surface when the player configuration is unchanged. */
@android.annotation.SuppressLint("UnsafeOptInUsageError")
final class PlayerBridge implements NativePlayerAdapter {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final WebView web;
    private final FrameLayout holder;
    private final SharedPreferences preferences;
    private final TextureView texture;
    private final SurfaceView surface;
    private final View renderView;
    private volatile String diagnostic="{}";
    private JSONObject diagnosticFields=new JSONObject();
    private ExoPlayer player;
    private boolean playerCompatibility, playerPcmAudio, playerLive, playerForceSoftwareHevc;
    private Map<String,String> playerHeaders=Collections.emptyMap();
    private Session session;
    private long nextSessionGeneration;
    private boolean destroyed, background;
    private float requestedVolume = 1f;
    private boolean requestedMuted = true;
    private float left, top, width, height;
    private int videoWidth, videoHeight;
    private float pixelRatio = 1;
    private Runnable timeout;
    private final Runnable progress=new Runnable(){public void run(){
        if(destroyed)return;
        if(session!=null&&player!=null&&session.firstFrame){
            Session target=session;long duration=player.getDuration(),position=player.getCurrentPosition();
            if(!target.live&&target.clock.observe(position,SystemClock.elapsedRealtime(),player.isPlaying()&&!background))fail(target,"clock",0);
            else{
                updateDiagnostic(target,diagnosticFields.optString("state","playing"));
                web.evaluateJavascript("window.HongguoNativePlayback&&window.HongguoNativePlayback.progress("+JSONObject.quote(target.id)+","+position+","+Math.max(0,duration)+")",null);
            }
        }handler.postDelayed(this,500);
    }};
    private static final class Session {
        final long generation;
        final String id;
        String diagnosticId = "";
        final List<String> urls;
        final Map<String,String> headers;
        final boolean live;
        final boolean compatibility;
        final boolean pcmAudio;
        final PlaybackClock clock=new PlaybackClock();
        int candidate;
        boolean wantsPlay = true, firstFrame;
        long position;
        boolean triedSoftwareHevcFallback;
        boolean forceSoftwareHevc;
        Session(long generation, String id, List<String> urls, Map<String,String> headers,boolean live,boolean compatibility) {
            this.generation=generation;this.id=id;this.urls=urls;this.headers=headers;this.live=live;this.compatibility=compatibility;
            pcmAudio=PlaybackCodecPolicy.pcmAudio(compatibility,live,Build.VERSION.SDK_INT);
        }
    }
    PlayerBridge(WebView web, FrameLayout holder) {
        this.web=web;this.holder=holder;
        preferences=web.getContext().getSharedPreferences("doudou_playback",Context.MODE_PRIVATE);
        diagnostic=preferences.getString("last_diagnostics","{}");
        // Media3 is a fallback surface. The page starts with the real HTML
        // video element and enables this bridge only when WebView playback
        // cannot load the source or produce a frame.
        surface=new SurfaceView(web.getContext());texture=null;renderView=surface;
        renderView.setFocusable(false);holder.addView(renderView,new FrameLayout.LayoutParams(-1,-1));
        holder.setVisibility(View.GONE);handler.postDelayed(progress,500);
        holder.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->{
            fit();
            if(session!=null&&player!=null&&holder.getVisibility()==View.VISIBLE)
                updateDiagnostic(session,diagnosticFields.optString("state","preparing"));
        });
        web.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->applyBounds());
    }
    static boolean nativePlaybackAvailable(int sdk) { return sdk >= (BuildConfig.ANDROID5_COMPAT_TEST ? 21 : 23); }

    /** Media3 is available as a fallback on every supported Android release. */
    @JavascriptInterface public boolean isAvailable() { return nativePlaybackAvailable(Build.VERSION.SDK_INT); }
    @JavascriptInterface public String engine() { return "webview_media3"; }

    @JavascriptInterface public void play(String loadId, String payload) {
        // Never accept arbitrary external URLs from a web page.
        if(loadId==null || !loadId.matches("[A-Za-z0-9_-]{1,80}") || payload==null || payload.length()>65536)return;
        try {
            JSONObject data=new JSONObject(payload);JSONArray list=data.optJSONArray("urls");
            List<String> urls=new ArrayList<>();
            if (list != null) for(int i=0;i<Math.min(8,list.length());i++){String url=list.optString(i);if(MediaUrlPolicy.valid(url))urls.add(url);}
            String source=data.optString("source", "");
            if (urls.isEmpty() && MediaUrlPolicy.valid(source)) urls.add(source);
            Map<String,String> headers=new HashMap<>();JSONObject supplied=data.optJSONObject("headers");
            if(supplied!=null)for(String key:new String[]{"User-Agent","Referer"}){
                String value=supplied.optString(key);if(value.length()<=512 && !value.contains("\r") && !value.contains("\n"))headers.put(key,value);
            }
            handler.post(()->{
                if(destroyed)return;
                clearTimeout();
                // Keep the native surface and ExoPlayer alive across ordinary source
                // changes. The media item is cleared below after the new session is
                // installed; callbacks for the cleared item see no matching media id.
                if(player!=null){player.setVolume(0);player.pause();player.clearMediaItems();}
                diagnosticFields=new JSONObject();videoWidth=videoHeight=0;
                session=new Session(++nextSessionGeneration,loadId,urls,headers,"hls".equals(data.optString("format")),"compatibility".equals(decoderMode()));
                String diagnosticId=data.optString("diagnostic_id","");
                if(diagnosticId.matches("[A-Za-z0-9_-]{1,120}"))session.diagnosticId=diagnosticId;
                session.position=PlaybackStart.positionMs(data.optDouble("start_position",0),session.live);
                session.wantsPlay=!data.optBoolean("paused",false);
                if(urls.isEmpty()){event(session,"error");return;}
                if(!applyBounds()){fail(session,"display",0);return;}
                if(!preferences.edit().putBoolean("playback_active",Build.VERSION.SDK_INT<=23&&!session.live).commit()){
                    fail(session,"settings",0);return;
                }
                holder.setVisibility(View.VISIBLE);startCandidate(session);
            });
        } catch(Exception ignored){handler.post(()->{if(!destroyed)send(loadId,"error");});}
    }
    private void startCandidate(Session target) {
        if(destroyed||session!=target)return;
        target.firstFrame=false;target.clock.reset();videoWidth=videoHeight=0;
        if(texture!=null)texture.setTransform(new Matrix());
        else surface.setLayoutParams(new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
        ExoPlayer active=ensurePlayer(target);
        if(active==null||session!=target)return;
        active.setVolume(requestedMuted ? 0 : requestedVolume);
        active.pause();
        active.clearMediaItems();
        event(target,"buffering");
        MediaItem item=new MediaItem.Builder()
            .setMediaId(target.generation+"#"+target.candidate)
            .setUri(target.urls.get(target.candidate))
            .setMimeType(target.live?MimeTypes.APPLICATION_M3U8:MimeTypes.VIDEO_MP4).build();
        active.setMediaItem(item,target.position);
        active.prepare();active.setPlayWhenReady(target.wantsPlay&&!background);
        timeout=()->{if(session==target&&player==active&&currentMediaMatches(target)&&!target.firstFrame&&!background)retry(target,"first_frame_timeout",0);};
        handler.postDelayed(timeout,25000);
    }
    private ExoPlayer ensurePlayer(Session target) {
        if(player!=null&&playerCompatibility==target.compatibility&&playerPcmAudio==target.pcmAudio&&playerLive==target.live&&playerHeaders.equals(target.headers)&&playerForceSoftwareHevc==target.forceSoftwareHevc)return player;
        releasePlayer();
        final Session configuredTarget=target;
        DefaultHttpDataSource.Factory source=new DefaultHttpDataSource.Factory()
            .setConnectTimeoutMs(10000).setReadTimeoutMs(120000).setDefaultRequestProperties(target.headers);
        DefaultRenderersFactory renderers=new DefaultRenderersFactory(web.getContext()){
            @Override protected AudioSink buildAudioSink(Context context,boolean floatOutput,boolean playbackParams){
                if(!configuredTarget.pcmAudio)return super.buildAudioSink(context,floatOutput,playbackParams);
                // The context-free builder deliberately fixes PCM-only capabilities. Supplying
                // a Context would re-enable the device's encoded-audio passthrough detection.
                return new DefaultAudioSink.Builder().setEnableFloatOutput(false)
                    .setEnableAudioTrackPlaybackParams(false).build();
            }
        }
            .setEnableDecoderFallback(true)
            .setMediaCodecSelector((mime,secure,tunnel)->{
                if(!PlaybackCodecPolicy.allowsDecoder(mime))return Collections.emptyList();
                List<MediaCodecInfo> choices=new ArrayList<>();
                List<MediaCodecInfo> software=new ArrayList<>();
                List<MediaCodecInfo> hardware=new ArrayList<>();
                for(MediaCodecInfo info:MediaCodecSelector.DEFAULT.getDecoderInfos(mime,secure,tunnel)) {
                    if(PlaybackCodecPolicy.excludesDecoderForSoftwareHevc(
                            configuredTarget.forceSoftwareHevc, mime, info.name))continue;
                    if(PlaybackCodecPolicy.allowsInMode(mime,info.name,configuredTarget.compatibility||configuredTarget.pcmAudio&&"audio/mp4a-latm".equals(mime))) {
                        if(PlaybackCodecPolicy.platformSoftware(info.name)) software.add(info); else hardware.add(info);
                    }
                }
                if(PlaybackCodecPolicy.preferSoftware(mime,Build.VERSION.SDK_INT)) {
                    choices.addAll(software); choices.addAll(hardware);
                } else {
                    choices.addAll(hardware); choices.addAll(software);
                }
                return choices;
            });
        ExoPlayer.Builder builder=new ExoPlayer.Builder(web.getContext(),renderers)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(source));
        if(configuredTarget.live){
            // Live streams need a short startup cushion, not the VOD default.
            // Keep it bounded and retain a larger cushion for rebuffering.
            builder.setLoadControl(new DefaultLoadControl.Builder()
                .setBufferDurationsMs(3000,10000,750,1500)
                .setBackBuffer(0,false).build());
        }
        ExoPlayer active=builder.build();
        player=active;playerCompatibility=target.compatibility;playerPcmAudio=target.pcmAudio;playerLive=target.live;playerForceSoftwareHevc=target.forceSoftwareHevc;playerHeaders=new HashMap<>(target.headers);
        if(surface!=null)active.setVideoSurfaceView(surface);else active.setVideoTextureView(texture);
        active.setPlaybackParameters(PlaybackParameters.DEFAULT);
        active.setVolume(requestedMuted ? 0 : requestedVolume);
        active.addAnalyticsListener(new AnalyticsListener(){
            private void decoder(String field,String name){
                Session current=session;
                if(current==null||player!=active||!currentMediaMatches(current))return;
                try{
                    diagnosticFields.put(field,name);
                    Format video=active.getVideoFormat();
                    if("video_decoder".equals(field)&&configuredTarget.forceSoftwareHevc&&video!=null
                            &&MimeTypes.VIDEO_H265.equals(video.sampleMimeType)&&PlaybackCodecPolicy.platformSoftware(name)){
                        diagnosticFields.put("hevc_software_retry","initialized");
                    }
                }catch(Exception ignored){}
                updateDiagnostic(current,"preparing");saveDiagnostic();
            }
            @Override public void onVideoDecoderInitialized(AnalyticsListener.EventTime time,String name,long timestamp,long duration){decoder("video_decoder",name);}
            @Override public void onAudioDecoderInitialized(AnalyticsListener.EventTime time,String name,long timestamp,long duration){decoder("audio_decoder",name);}
        });
        active.addListener(new Player.Listener(){
            private boolean current(){Session current=session;return !destroyed&&current!=null&&player==active&&currentMediaMatches(current);}
            @Override public void onTracksChanged(Tracks tracks){
                Session current=session;
                if(current())recordTrackDiagnostics(current,tracks);
                if(current()&&!tracks.getGroups().isEmpty()&&!tracks.isTypeSelected(C.TRACK_TYPE_VIDEO)){
                    fail(current,"decoder",PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED);
                    return;
                }
                // One-time HEVC software decoder fallback for FORMAT_EXCEEDS_CAPABILITIES
                // Only trigger if we haven't rendered first frame yet (to avoid interrupting working playback)
                if(current()&&PlaybackCodecPolicy.shouldRetryHevcSoftwareFallback(
                        hasExceedsCapabilitiesHevc(tracks), current.firstFrame, current.triedSoftwareHevcFallback)){
                    retrySoftwareHevc(current);
                }
            }
            @Override public void onVideoSizeChanged(VideoSize size){if(current()){videoWidth=size.width;videoHeight=size.height;pixelRatio=size.pixelWidthHeightRatio;fit();}}
            @Override public void onRenderedFirstFrame(){
                Session current=session;if(!current())return;current.firstFrame=true;clearTimeout();
                JSONObject frame = new JSONObject();
                try { frame.put("width", videoWidth).put("height", videoHeight); } catch (Exception ignored) {}
                // Keep audio held until the HTML cover has painted. If the
                // device reports the first frame before STATE_READY or
                // onIsPlayingChanged, emit playing here as well; otherwise
                // the page can keep its loading cover while the clock moves.
                active.setVolume(requestedMuted ? 0 : requestedVolume);
                event(current,"frame", frame);
                if(!current.wantsPlay) event(current,"paused");
                else if(active.isPlaying()) event(current,"playing");
            }
            @Override public void onPlaybackStateChanged(int state){
                if(!current())return;
                Session current=session;
                if(state==Player.STATE_BUFFERING){current.clock.reset();event(current,"buffering");}
                if(state==Player.STATE_READY&&current.firstFrame)event(current,current.wantsPlay?"playing":"paused");
                if(state==Player.STATE_ENDED){event(current,"ended");markInactive();}
            }
            @Override public void onIsPlayingChanged(boolean playing){Session current=session;if(current()){if(!playing)current.clock.reset();else if(current.firstFrame)event(current,"playing");}}
            @Override public void onPositionDiscontinuity(Player.PositionInfo oldPosition,Player.PositionInfo newPosition,int reason){if(current()){Session current=session;current.clock.reset();}}
            @Override public void onPlayerError(PlaybackException error){
                if(!current())return;
                Session current=session;
                String kind=PlaybackCodecPolicy.failureKind(error.errorCode);
                if("decoder".equals(kind))fail(current,kind,error.errorCode);else retry(current,kind,error.errorCode);
            }
        });
        return active;
    }
    private void recordTrackDiagnostics(Session target,Tracks tracks){
        if(session!=target)return;
        Format selectedVideo=null;int selectedSupport=-1;boolean selected=false;int videoTracks=0;
        StringBuilder unselectedHevc=new StringBuilder();
        for(Tracks.Group group:tracks.getGroups()){
            if(group.getType()!=C.TRACK_TYPE_VIDEO)continue;
            for(int i=0;i<group.length;i++){
                videoTracks++;
                Format format=group.getTrackFormat(i);int support=group.getTrackSupport(i);
                if(group.isTrackSelected(i)){
                    selected=true;selectedVideo=format;selectedSupport=support;
                }else if(MimeTypes.VIDEO_H265.equals(format.sampleMimeType)&&unselectedHevc.length()<768){
                    if(unselectedHevc.length()>0)unselectedHevc.append(' ');
                    unselectedHevc.append(describeFormat(format)).append('=').append(supportName(support));
                }
            }
        }
        try{
            diagnosticFields.put("video_track",selectedVideo==null?"无":describeFormat(selectedVideo))
                .put("track_support",selectedVideo==null?"-":supportName(selectedSupport))
                .put("track_selected",selected?"是":"否")
                .put("video_track_count",videoTracks);
            if(unselectedHevc.length()>0)diagnosticFields.put("unselected_hevc",unselectedHevc.toString());
            else diagnosticFields.remove("unselected_hevc");
        }catch(Exception ignored){}
        updateDiagnostic(target,diagnosticFields.optString("state","preparing"));saveDiagnostic();
    }
    private boolean hasExceedsCapabilitiesHevc(Tracks tracks){
        for(Tracks.Group group:tracks.getGroups()){
            if(group.getType()!=C.TRACK_TYPE_VIDEO)continue;
            for(int i=0;i<group.length;i++){
                if(!group.isTrackSelected(i))continue;
                Format format=group.getTrackFormat(i);
                if(MimeTypes.VIDEO_H265.equals(format.sampleMimeType)&&group.getTrackSupport(i)==C.FORMAT_EXCEEDS_CAPABILITIES){
                    return true;
                }
            }
        }
        return false;
    }
    private void retrySoftwareHevc(Session target){
        if(session!=target||destroyed||target.triedSoftwareHevcFallback)return;
        // Check if software HEVC decoder is available
        boolean hasSoftwareHevc=false;
        try{
            for(MediaCodecInfo info:MediaCodecSelector.DEFAULT.getDecoderInfos(MimeTypes.VIDEO_H265,false,false)){
                if(PlaybackCodecPolicy.platformSoftware(info.name)){
                    hasSoftwareHevc=true;
                    break;
                }
            }
        }catch(Exception ignored){}
        if(!hasSoftwareHevc){
            // No software HEVC decoder available, let the normal error path handle it
            return;
        }
        clearTimeout();
        target.triedSoftwareHevcFallback=true;
        target.forceSoftwareHevc=true;
        if(player!=null&&!target.live)target.position=Math.max(target.position,Math.max(0,player.getCurrentPosition()));
        // Drop data from the hardware attempt; video_decoder is populated only
        // when Media3 confirms which decoder the retry actually initialized.
        try{
            for(String key:new String[]{"video_decoder","audio_decoder","video_track","track_support",
                    "track_selected","video_track_count","unselected_hevc","video_mime","audio_mime",
                    "sample_rate","channels"})diagnosticFields.remove(key);
            diagnosticFields.put("hevc_software_retry","requested");
        }catch(Exception ignored){}
        // Restart with software HEVC only
        startCandidate(target);
    }
    private static String supportName(int support){
        switch(support){
            case C.FORMAT_HANDLED:return "FORMAT_HANDLED";
            case C.FORMAT_EXCEEDS_CAPABILITIES:return "FORMAT_EXCEEDS_CAPABILITIES";
            case C.FORMAT_UNSUPPORTED_DRM:return "FORMAT_UNSUPPORTED_DRM";
            case C.FORMAT_UNSUPPORTED_SUBTYPE:return "FORMAT_UNSUPPORTED_SUBTYPE";
            case C.FORMAT_UNSUPPORTED_TYPE:return "FORMAT_UNSUPPORTED_TYPE";
            default:return "UNKNOWN("+support+")";
        }
    }
    private static String describeFormat(Format format){
        StringBuilder value=new StringBuilder();
        value.append(format.sampleMimeType==null?"?":format.sampleMimeType);
        if(format.codecs!=null&&!format.codecs.isEmpty())value.append(" [").append(format.codecs).append(']');
        if(format.width>0&&format.height>0)value.append(" · ").append(format.width).append('x').append(format.height);
        if(format.frameRate>0)value.append(" · ").append(Math.round(format.frameRate)).append("fps");
        if(format.colorInfo!=null)value.append(" · ").append(format.colorInfo.toLogString());
        return value.toString();
    }
    private void retry(Session target,String kind,int code){
        clearTimeout();if(session!=target)return;
        if(player!=null&&target.firstFrame&&!target.live)target.position=Math.max(0,player.getCurrentPosition());
        if(++target.candidate<target.urls.size())startCandidate(target);
        else fail(target,kind,code);
    }
    private void fail(Session target,String kind,int code){
        if(session!=target)return;
        try{diagnosticFields.put("error_kind",kind).put("error_code",code);}catch(Exception ignored){}
        updateDiagnostic(target,"error");
        saveDiagnostic();
        releasePlayer();holder.setVisibility(View.GONE);
        markInactive();
        try{JSONObject detail=new JSONObject().put("kind",kind);if(code>0)detail.put("code",code);
            web.evaluateJavascript("window.HongguoNativePlayback&&window.HongguoNativePlayback.event("+JSONObject.quote(target.id)+",\"error\","+detail.toString()+")",null);
        }catch(Exception ignored){event(target,"error");}
    }
    @JavascriptInterface public void begin(String id){handler.post(()->{if(!destroyed){releasePlayer();markInactive();session=null;holder.setVisibility(View.GONE);}});}
    @JavascriptInterface public void stop(){handler.post(()->{releasePlayer();markInactive();session=null;holder.setVisibility(View.GONE);});}
    @JavascriptInterface public void pause(){handler.post(()->{if(session!=null){session.clock.reset();session.wantsPlay=false;clearTimeout();if(player!=null)player.pause();if(session.firstFrame)event(session,"paused");}});}
    @JavascriptInterface public void setSpeed(double speed){
        if(Double.isNaN(speed)||Double.isInfinite(speed)||speed<=0||speed>4)return;
        handler.post(()->{if(player!=null)player.setPlaybackParameters(new PlaybackParameters((float)speed));});
    }
    @JavascriptInterface public void setVolume(double volume, boolean muted){
        if(Double.isNaN(volume)||Double.isInfinite(volume))return;
        final float value=(float)Math.max(0,Math.min(1,volume));
        handler.post(()->{requestedVolume=value;requestedMuted=muted;if(player!=null)player.setVolume(muted?0:value);});
    }
    @JavascriptInterface public void resume(){handler.post(()->{if(session!=null){session.wantsPlay=true;if(player!=null&&!background)player.play();if(session.firstFrame)event(session,"playing");}});}
    @JavascriptInterface public void seekBy(int seconds){handler.post(()->{if(player!=null&&session!=null&&!session.live&&session.firstFrame){long duration=player.getDuration();long position=player.getCurrentPosition()+Math.max(-60,Math.min(60,seconds))*1000L;player.seekTo(Math.max(0,duration>0?Math.min(duration,position):position));}});}
    @JavascriptInterface public void seekTo(double seconds){if(Double.isNaN(seconds)||Double.isInfinite(seconds)||seconds<0)return;handler.post(()->{if(player!=null&&session!=null&&!session.live&&session.firstFrame){long duration=player.getDuration();if(duration>0)player.seekTo((long)Math.min(duration,seconds*1000));}});}
    @JavascriptInterface public void bounds(float l,float t,float w,float h){handler.post(()->{
        if(!PlaybackBounds.valid(l,t,w,h))return;
        if(!PlaybackBounds.visible(Math.round(web.getWidth()*w),Math.round(web.getHeight()*h)))return;
        left=Math.max(0,Math.min(1,l));top=Math.max(0,Math.min(1,t));
        width=Math.max(0,Math.min(1-left,w));height=Math.max(0,Math.min(1-top,h));applyBounds();
    });}
    private boolean applyBounds(){
        if(!PlaybackBounds.valid(left,top,width,height))return false;
        int viewW=Math.round(web.getWidth()*width),viewH=Math.round(web.getHeight()*height);
        if(!PlaybackBounds.visible(viewW,viewH))return false;
        FrameLayout.LayoutParams layout=new FrameLayout.LayoutParams(viewW,viewH);
        layout.leftMargin=Math.round(web.getWidth()*left);layout.topMargin=Math.round(web.getHeight()*top);holder.setLayoutParams(layout);
        return true;
    }
    private void fit(){
        if(videoWidth<=0||videoHeight<=0||holder.getWidth()<=0||holder.getHeight()<=0)return;
        float w=holder.getWidth(),h=holder.getHeight(),aspect=videoWidth*pixelRatio/videoHeight;
        float fitW=Math.min(w,h*aspect),fitH=fitW/aspect;
        if(surface!=null){
            int targetW=Math.max(1,Math.round(fitW)),targetH=Math.max(1,Math.round(fitH));
            if(surface.getLayoutParams().width!=targetW||surface.getLayoutParams().height!=targetH)surface.setLayoutParams(new FrameLayout.LayoutParams(targetW,targetH,Gravity.CENTER));
        }else{Matrix transform=new Matrix();transform.setScale(fitW/w,fitH/h,w/2,h/2);texture.setTransform(transform);}
    }
    private void updateDiagnostic(Session target,String state){
        if(session!=target)return;
        try{
            diagnosticFields.put("diagnostic_id",target.diagnosticId).put("state",state).put("surface",surface!=null?"SurfaceView":"TextureView")
                .put("mode",target.compatibility?"compatibility":"standard")
                .put("audio_output",target.pcmAudio?"PCM":"system")
                .put("clock_ratio",target.clock.ratio())
                .put("first_frame",target.firstFrame).put("width",videoWidth).put("height",videoHeight);
            if(PlaybackBounds.visible(holder.getWidth(),holder.getHeight())&&holder.getVisibility()==View.VISIBLE)
                diagnosticFields.put("view_width",holder.getWidth()).put("view_height",holder.getHeight())
                    .put("render_width",renderView.getWidth()).put("render_height",renderView.getHeight());
            if(player!=null){
                diagnosticFields.put("speed",player.getPlaybackParameters().speed);
                androidx.media3.common.Format video=player.getVideoFormat(),audio=player.getAudioFormat();
                if(video!=null)diagnosticFields.put("video_mime",video.sampleMimeType);
                if(audio!=null)diagnosticFields.put("audio_mime",audio.sampleMimeType).put("sample_rate",audio.sampleRate).put("channels",audio.channelCount);
            }
            diagnostic=diagnosticFields.toString();
        }catch(Exception ignored){}
    }
    @JavascriptInterface public String diagnostics(){return diagnostic;}
    @JavascriptInterface public String decoderMode(){return preferences.getString("decoder_mode","standard");}
    @JavascriptInterface public boolean safeStart(){
        return Build.VERSION.SDK_INT<=23&&(!preferences.getBoolean("playback_setup_v2",false)||preferences.getBoolean("playback_active",false));
    }
    @JavascriptInterface public void setDecoderMode(String mode){
        if("standard".equals(mode)||"compatibility".equals(mode))preferences.edit().putString("decoder_mode",mode).putBoolean("playback_setup_v2",true).apply();
    }
    private void saveDiagnostic(){preferences.edit().putString("last_diagnostics",diagnostic).apply();}
    private void markInactive(){
        if(session!=null)saveDiagnostic();
        preferences.edit().putBoolean("playback_active",false).apply();
    }
    private void event(Session target,String name){ event(target,name,null); }
    private void event(Session target,String name,JSONObject detail){if(session==target){updateDiagnostic(target,name);saveDiagnostic();send(target.id,name,detail);}}
    private void send(String id,String name){ send(id,name,null); }
    private void send(String id,String name,JSONObject detail){
        if(destroyed)return;
        String suffix = detail == null ? "{}" : detail.toString();
        web.evaluateJavascript("window.HongguoNativePlayback&&window.HongguoNativePlayback.event("+JSONObject.quote(id)+","+JSONObject.quote(name)+","+suffix+")",null);
    }
    private boolean currentMediaMatches(Session target){
        if(player==null||target==null)return false;
        MediaItem item=player.getCurrentMediaItem();
        return item!=null&&(target.generation+"#"+target.candidate).equals(item.mediaId);
    }
    private void clearTimeout(){if(timeout!=null){handler.removeCallbacks(timeout);timeout=null;}}
    private void releasePlayer(){clearTimeout();ExoPlayer old=player;player=null;playerHeaders=Collections.emptyMap();playerCompatibility=false;playerPcmAudio=false;playerLive=false;if(old!=null){old.setVolume(0);if(surface!=null)old.clearVideoSurfaceView(surface);else old.clearVideoTextureView(texture);old.release();}}
    public void onPause(){background=true;clearTimeout();if(session!=null)session.clock.reset();if(player!=null)player.pause();markInactive();}
    public void onResume(){background=false;if(session!=null&&player!=null&&session.wantsPlay){
        if(!preferences.edit().putBoolean("playback_active",Build.VERSION.SDK_INT<=23&&!session.live).commit()){fail(session,"settings",0);return;}
        player.play();if(!session.firstFrame){Session target=session;ExoPlayer active=player;timeout=()->{if(session==target&&player==active&&!target.firstFrame)retry(target,"first_frame_timeout",0);};handler.postDelayed(timeout,25000);}}}
    public void destroy(){destroyed=true;handler.removeCallbacksAndMessages(null);releasePlayer();markInactive();session=null;holder.setVisibility(View.GONE);}
}
