const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
const styles=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.css'),'utf8');
function between(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
function classes(...initial){const values=new Set(initial);return {add(...names){names.forEach(x=>values.add(x));},remove(...names){names.forEach(x=>values.delete(x));},contains(name){return values.has(name);}};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(engine='mpv',imageDecode){
 const hero={classList:classes('is-preparing-video')};
 const cover={classList:classes(),style:{backgroundImage:'none'}};
 const canvas={classList:classes(),width:0,height:0};
 const video={paused:false,seeking:false,ended:false,readyState:3,videoWidth:1280,videoHeight:720,classList:classes('has-source')};
 const root={classList:classes('native-playback')};
 const document={documentElement:root,getElementById(id){return id==='hero'?hero:id==='hero-episode-cover'?cover:id==='hero-video'?video:id==='hero-last-frame'?canvas:null;}};
 const images=[],timers=[];
 function Image(){images.push(this);}
 if(imageDecode) Image.prototype.decode=imageDecode;
 Object.defineProperty(Image.prototype,'src',{set(value){this._src=value;},get(){return this._src;}});
 const paint=deferred();
 const playback={item:{series_id:'series-1'},vid:'vid-2',generation:8,owner:3,presentation:{rendered:false,pending:false,epoch:0}};
 const context=vm.createContext({document,Image,Promise,Date,feedGeneration:8,accountEpoch:3,activePlayback:playback,playbackRequest:null,prewarmedEpisodeCover:null,episodePrefetch:{peek(){return null;}},
   setTimeout(fn,delay){timers.push({fn,delay});return timers.length;},clearTimeout(){},
   playbackEngineName(){return engine;},nativePlaybackActive(){return root.classList.contains('native-playback');},
   isNativeMedia3PlaybackActive(){return root.classList.contains('native-playback')&&engine!=='mpv';},
   clearRangeStallTimer(){},clearRangeTransitionHint(){},clearLastPlaybackFrame(){},
   playbackVideoReady(){return true;},waitForPlaybackPaint(){return paint.promise;},releasePresentedAudio(){},finishAutoCinema(){},setPlayerStatus(){},
   media:video,window:{}});
 vm.runInContext(between('  function clearEpisodeCover(', '  function layoutLastPlaybackFrame'),context);
 return {context,hero,cover,canvas,video,images,paint,playback,timers};
}
const target={series_id:'series-1',vid:'vid-2'};

test('preparing playback shows a poster only outside same-drama episode transitions',()=>{
 assert.match(styles,/\.hero\.is-preparing-video \.hero-backdrop, \.hero\.is-preparing-video \.hero-loading-poster \{ visibility: visible; \}/);
 assert.match(styles,/\.hero\.is-preparing-video\.is-episode-transition \.hero-backdrop, \.hero\.is-preparing-video\.is-episode-transition \.hero-loading-poster \{ visibility: hidden; \}/);
 assert.match(styles,/\.hero\.is-episode-cover \.hero-episode-cover \{ visibility: visible; \}/);
});

test('only the current episode can reveal its episode_cover for MPV and standard playback',()=>{
 const f=fixture();
 f.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});
 assert.equal(f.images.length,1);assert.equal(f.hero.classList.contains('is-episode-cover'),false);
 f.images[0].onload();
 assert.equal(f.cover.style.backgroundImage,'url("https://img.example/episode-2.jpg")');
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
 const standard=fixture('webview_media3');
 standard.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});
 assert.equal(standard.images.length,1);
 standard.images[0].onload();
 assert.equal(standard.hero.classList.contains('is-episode-cover'),true);
});

test('mismatched episode responses never show an episode cover',()=>{
 const stale=fixture();
 stale.context.setEpisodeCover({series_id:'series-1',vid:'vid-old'},{episode_cover:'https://img.example/old.jpg'});
 assert.equal(stale.images.length,0);
});

test('a late image response cannot cover a newer playback generation',()=>{
 const f=fixture();
 f.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});
 f.context.feedGeneration++;
 f.images[0].onload();
 assert.equal(f.hero.classList.contains('is-episode-cover'),false);
});

test('an Image.decode-prewarmed cover is reused without creating a second image',async()=>{
 const f=fixture('mpv',()=>Promise.resolve());
 f.context.prewarmEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'},f.playback);
 const warmed=f.images[0];
 warmed.onload();
 await new Promise(resolve=>setImmediate(resolve));
 f.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});
 assert.equal(f.images.length,1);
 assert.equal(f.cover.style.backgroundImage,'url("https://img.example/episode-2.jpg")');
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
});

test('a rejected Image.decode falls back to the already loaded image',async()=>{
 const f=fixture('mpv',()=>Promise.reject(new Error('decode unavailable')));
 f.context.prewarmEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'},f.playback);
 f.images[0].onload();
 await new Promise(resolve=>setImmediate(resolve));
 f.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});
 assert.equal(f.images.length,1);
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
});

test('a pending prewarmed image can be adopted by its target playback after the generation changes',()=>{
 const f=fixture();
 f.context.episodePrefetch={peek(){return null;}};
 f.context.prewarmEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'},f.playback);
 const warmed=f.images[0];
 const next=Object.assign({},f.playback,{vid:target.vid,generation:9,owner:3,presentation:{rendered:false,pending:false,epoch:0}});
 f.context.feedGeneration=9;f.context.activePlayback=next;
 f.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});
 assert.equal(f.images.length,1);
 warmed.onload();
 assert.equal(f.cover.style.backgroundImage,'url("https://img.example/episode-2.jpg")');
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
});

test('a pending image decode can finish while detail resolution has no active playback and survive source attachment',()=>{
 const f=fixture();
 f.context.prewarmEpisodeCover(target,{episode_cover:'next.jpg'},f.playback);
 const warmed=f.images[0];
 f.context.feedGeneration=9;f.context.activePlayback=null;
 f.context.playbackRequest={series_id:target.series_id,vid:target.vid,generation:9,owner:3};
 f.context.reusePrewarmedEpisodeCover(target);
 warmed.onload();
 assert.equal(f.context.prewarmedEpisodeCover.ready,true);
 assert.equal(f.cover.style.backgroundImage,'url("next.jpg")');
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
 f.context.activePlayback={...f.playback,generation:9};
 f.context.reusePrewarmedEpisodeCover(target);
 assert.equal(f.images.length,1);
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
});

test('late prewarmed image callbacks cannot cover cancellation, another selection or an already rendered frame',()=>{
 for(const kind of ['cancel','generation','owner','vid','rendered']) {
  const f=fixture();
  f.context.prewarmEpisodeCover(target,{episode_cover:'next.jpg'},f.playback);
  f.context.reusePrewarmedEpisodeCover(target);
  if(kind==='cancel')f.context.clearEpisodeCover();
  if(kind==='generation')f.context.feedGeneration++;
  if(kind==='owner')f.context.accountEpoch++;
  if(kind==='vid')f.playback.vid='other';
  if(kind==='rendered')f.playback.presentation.rendered=true;
  f.images[0].onload();
  assert.equal(f.hero.classList.contains('is-episode-cover'),false,kind);
 }
});

test('Media3 keeps the episode cover through first-frame until playback advances, then fades for 180ms',async()=>{
 const f=fixture('webview_media3');f.playback.preserveNativeTransition=true;
 f.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});f.images[0].onload();
 f.context.handlers={};
 f.context.media={paused:false,seeking:false,readyState:3,addEventListener(name,fn){f.context.handlers[name]=fn;}};
 vm.runInContext(between('  function finishPlaybackPreparation(', '  function markPlaybackStarted'),f.context);
 vm.runInContext(between("  media.addEventListener('nativeframe'",'  function checkPlaybackData'),f.context);
 f.context.handlers.nativeframe();
 assert.equal(f.playback.presentation.rendered,true);
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
 f.paint.resolve(true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
 assert.equal(f.playback.presentation.pending,false);
 f.playback.presentation.progressed=true;
 f.context.finishPlaybackPreparation(f.playback);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
 assert.equal(f.hero.classList.contains('is-native-frame-revealing'),true);
 assert.equal(f.timers[0].delay,200);
 f.timers[0].fn();
 assert.equal(f.hero.classList.contains('is-episode-cover'),false);
 assert.equal(f.hero.classList.contains('is-preparing-video'),false);
});

test('MPV retains its episode cover through its native-frame paint boundary without Media3 timing gate',async()=>{
 const f=fixture('mpv');
 f.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});f.images[0].onload();
 f.context.handlers={};
 f.context.media={paused:false,seeking:false,readyState:3,addEventListener(name,fn){f.context.handlers[name]=fn;}};
 vm.runInContext(between('  function finishPlaybackPreparation(', '  function markPlaybackStarted'),f.context);
 vm.runInContext(between("  media.addEventListener('nativeframe'",'  function checkPlaybackData'),f.context);
 f.context.handlers.nativeframe();
 assert.equal(f.hero.classList.contains('is-episode-cover'),true);
 f.paint.resolve(true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.hero.classList.contains('is-episode-cover'),false);
 assert.equal(f.hero.classList.contains('is-preparing-video'),false);
});

test('cancelling a transition clears the loaded target image',()=>{
 const f=fixture('webview_media3');
 f.context.setEpisodeCover(target,{episode_cover:'https://img.example/episode-2.jpg'});f.images[0].onload();
 f.context.clearEpisodeCover();
 assert.equal(f.hero.classList.contains('is-episode-cover'),false);
 assert.equal(f.cover.style.backgroundImage,'none');
 assert.equal(f.cover.classList.contains('is-ready'),false);
});
