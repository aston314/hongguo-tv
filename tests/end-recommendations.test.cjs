const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {create,itemsFor}=require('../core/cmd/hongguotv/ui/end-recommendations.js');
const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
const slice=(a,b)=>source.slice(source.indexOf('  function '+a+'('),source.indexOf('  function '+b+'('));
const tick=()=>new Promise(r=>setImmediate(r));
const related=Array.from({length:12},(_,i)=>({series_id:'r'+i,title:'相关推荐'+i,episode_count:10}));

test('recommendations preserve upstream order, remove the current drama/duplicates/unreleased rows and cap the list',()=>{
  const rows=itemsFor([{series_id:'self',title:'本剧'},...related,related[0],{series_id:'soon',title:'未上线',upcoming:true},{series_id:'unavailable',title:'不可播放',playable:false},{series_id:'empty'},null],'self');
  assert.deepEqual(rows,related);
  assert.equal(itemsFor(Array.from({length:40},(_,i)=>({series_id:String(i),title:'剧'})),'none').length,20);
  assert.deepEqual(itemsFor(null,'self'),[]);
});
function fixture(){
  const calls=[],playback={item:{series_id:'self'}};
  const state={current:playback,safe:true};
  const panel=create({isCurrent:p=>state.current===p,canPresent:()=>state.safe,
    show:items=>calls.push(['show',items]),hide:(restore,animate)=>calls.push(['hide',restore,animate]),play:item=>calls.push(['play',item])});
  return {panel,calls,state,playback};
}
test('an empty response never opens an empty sheet',()=>{
  const f=fixture();assert.equal(f.panel.offer(f.playback,[]),false);assert.equal(f.panel.isOpen(),false);assert.deepEqual(f.calls,[]);
});
test('reservation, other dialogs and active controls defer focus until safe, with one automatic opening per playback',()=>{
  const f=fixture();f.state.safe=false;
  f.panel.offer(f.playback,related);f.panel.flush();assert.deepEqual(f.calls,[]);
  f.state.safe=true;assert.equal(f.panel.flush(),true);assert.equal(f.panel.isOpen(),true);
  assert.equal(f.calls[0][0],'show');
  f.panel.close(true);assert.deepEqual(f.calls.at(-1),['hide',true,true]);
  assert.equal(f.panel.offer(f.playback,related),false);assert.equal(f.panel.flush(),false);assert.equal(f.calls.filter(c=>c[0]==='show').length,1);
});
test('page/account/source changes invalidate deferred offers and stale choices',()=>{
  for(const open of [false,true]){
    const f=fixture();f.state.safe=open;f.panel.offer(f.playback,related);f.state.current=null;
    if(open)assert.equal(f.panel.choose(0),false);else assert.equal(f.panel.flush(),false);
    assert.equal(f.panel.isOpen(),false);assert.equal(f.calls.filter(c=>c[0]==='play').length,0);
  }
});
test('confirming a recommendation closes the sheet before starting exactly the selected drama',()=>{
  const f=fixture();f.panel.offer(f.playback,related);f.panel.choose(4);
  assert.deepEqual(f.calls.slice(-2),[['hide',false,false],['play',related[4]]]);
  assert.equal(f.panel.choose(4),false);assert.equal(f.calls.filter(c=>c[0]==='play').length,1);
});
test('reset clears the old playback offer so the new completed drama can have its own recommendations',()=>{
  const f=fixture();f.panel.offer(f.playback,related);f.panel.reset();
  const next={item:{series_id:'new'}};f.state.current=next;
  assert.equal(f.panel.offer(next,related),true);assert.equal(f.calls.filter(c=>c[0]==='show').length,2);
});

function timedFixture(){
  const calls=[],playback={item:{series_id:'self'}},jobs=new Map();let time=0,id=0;
  const state={current:playback,safe:true,eligible:true};
  const panel=create({isCurrent:p=>state.current===p,canPresent:()=>state.safe,canAutoplay:()=>state.eligible,
    now:()=>time,schedule:(fn,delay)=>{jobs.set(++id,{fn,at:time+delay});return id},unschedule:handle=>jobs.delete(handle),
    countdown:seconds=>calls.push(['countdown',seconds]),show:items=>calls.push(['show',items]),
    hide:(restore,animate)=>calls.push(['hide',restore,animate]),play:item=>calls.push(['play',item])});
  function advance(ms){const target=time+ms;while(jobs.size){const [key,job]=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0];if(job.at>target)break;time=job.at;jobs.delete(key);job.fn()}time=target}
  return {panel,calls,state,playback,jobs,advance,jump(ms){time+=ms}};
}
test('the thirty seconds start after readiness, then autoplay exactly the first card through the normal selection path',()=>{
  const f=timedFixture();f.panel.offer(f.playback,related);f.advance(60000);
  assert.equal(f.jobs.size,0);assert.equal(f.panel.ready(),true);assert.deepEqual(f.calls.at(-1),['countdown',30]);
  f.advance(1000);assert.deepEqual(f.calls.at(-1),['countdown',29]);
  assert.equal(f.panel.ready(),false);f.advance(28999);assert.equal(f.calls.filter(c=>c[0]==='play').length,0);
  f.advance(1);assert.equal(f.panel.isOpen(),false);assert.deepEqual(f.calls.slice(-2),[['hide',false,false],['play',related[0]]]);
  f.advance(60000);assert.equal(f.calls.filter(c=>c[0]==='play').length,1);assert.equal(f.jobs.size,0);
});
test('reservation or active controls delay both the sheet and its full countdown',()=>{
  const f=timedFixture();f.state.safe=false;f.panel.offer(f.playback,related);
  assert.equal(f.panel.ready(),false);f.advance(90000);assert.equal(f.jobs.size,0);
  f.state.safe=true;f.panel.flush();f.panel.ready();assert.deepEqual(f.calls.at(-1),['countdown',30]);
});
test('manual browsing before or after readiness cancels permanently, including returning to the first card',()=>{
  for(const started of [false,true]){
    const f=timedFixture();f.panel.offer(f.playback,related);if(started){f.panel.ready();f.advance(8000)}
    f.panel.cancelAutoplay();assert.deepEqual(f.calls.at(-1),['countdown',null]);
    assert.equal(f.panel.ready(),false);f.advance(60000);assert.equal(f.calls.filter(c=>c[0]==='play').length,0);
    assert.equal(f.panel.isOpen(),true);assert.equal(f.jobs.size,0);
    f.panel.choose(7);assert.deepEqual(f.calls.at(-1),['play',related[7]]);
  }
});
test('closing or leaving a playback cancels queued callbacks, including a callback already delivered late',()=>{
  for(const action of ['close','reset','stale','modal']){
    const f=timedFixture();f.panel.offer(f.playback,related);f.panel.ready();const late=[...f.jobs.values()][0].fn;
    if(action==='close')f.panel.close(true);
    else if(action==='reset')f.panel.reset();
    else if(action==='stale')f.state.current=null;
    else f.state.eligible=false;
    f.jump(31000);late();f.advance(60000);assert.equal(f.calls.filter(c=>c[0]==='play').length,0);assert.equal(f.jobs.size,0);
  }
});
test('an old session timer cannot clear or fire a newer session countdown',()=>{
  const f=timedFixture();f.panel.offer(f.playback,related);f.panel.ready();const old=[...f.jobs.values()][0].fn;
  f.panel.reset();const next={item:{series_id:'new'}};f.state.current=next;f.panel.offer(next,related);f.panel.ready();
  f.advance(9000);old();assert.equal(f.jobs.size,1);assert.deepEqual(f.calls.at(-1),['countdown',21]);
  f.advance(21000);assert.deepEqual(f.calls.at(-1),['play',related[0]]);assert.equal(f.calls.filter(c=>c[0]==='play').length,1);
});
test('a duplicate ended event after background reset cannot offer a fresh countdown for the same playback',()=>{
  const f=timedFixture();f.panel.offer(f.playback,related);f.panel.ready();f.panel.reset();
  assert.equal(f.panel.offer(f.playback,related),false);assert.equal(f.panel.ready(),false);
  f.advance(60000);assert.equal(f.calls.filter(c=>c[0]==='play').length,0);assert.equal(f.calls.filter(c=>c[0]==='show').length,1);
});
test('a delayed foreground tick uses elapsed time, while a manual choice at the deadline wins only once',()=>{
  const f=timedFixture();f.panel.offer(f.playback,related);f.panel.ready();const late=[...f.jobs.values()][0].fn;
  f.jump(17000);f.jobs.clear();late();assert.deepEqual(f.calls.at(-1),['countdown',13]);
  f.jump(13000);f.panel.choose(4);late();assert.deepEqual(f.calls.at(-1),['play',related[4]]);
  assert.equal(f.calls.filter(c=>c[0]==='play').length,1);
});

function keysFixture(){
  const plays=[],rows=related.map((item,i)=>({id:'card-'+i,classList:{contains:n=>n==='end-recommendation-card'},closest:()=>true,click(){panel.choose(i)}}));
  const close={id:'end-recommendations-close',closest:()=>true,click(){panel.close(true)}};
  const document={activeElement:rows[0],getElementById:id=>id==='end-recommendations-track'?{children:rows}:close};
  const panel=create({isCurrent:()=>true,canPresent:()=>true,show(){},hide(){document.activeElement={id:'hero-feed-focus'}},play:item=>plays.push(item)});
  panel.offer({item:{series_id:'self'}},related);
  const c=vm.createContext({document,endRecommendations:panel,coreConnectionModalOpen:false,endRecommendationIndex:0,autoCinemaCandidate:false,
    goFocus(node){document.activeElement=node;const index=rows.indexOf(node);if(index>=0)c.endRecommendationIndex=index}});
  vm.runInContext(source.match(/  var keyNames = \{[\s\S]*?\n  \};/)[0]+slice('normalizedKey','showNotice')+slice('handleEndRecommendationKey','canContinuePlayback'),c);
  function press(key){let prevented=0,stopped=0;c.handleKey({...key,preventDefault(){prevented++},stopPropagation(){stopped++}});assert.equal(prevented,1);assert.equal(stopped,1)}
  return {c,rows,close,panel,plays,press,document};
}
test('modern and legacy D-pad keys stay in the row, stop at edges and restore the last card from Close',()=>{
  const f=keysFixture();f.press({keyCode:37});assert.equal(f.document.activeElement,f.rows[0]);
  for(let i=0;i<20;i++)f.press({keyCode:39});assert.equal(f.document.activeElement,f.rows.at(-1));
  f.press({keyCode:19});assert.equal(f.document.activeElement,f.close);
  f.press({keyCode:20});assert.equal(f.document.activeElement,f.rows.at(-1));
  f.press({key:'Tab'});assert.equal(f.document.activeElement,f.close);
  f.press({key:'Tab'});assert.equal(f.document.activeElement,f.rows.at(-1));
  assert.deepEqual(f.plays,[]);
});
test('Enter activates once; media shortcuts and held confirmation cannot seek or replay the background',()=>{
  const f=keysFixture();
  for(const key of [' ','MediaPlayPause','MediaFastForward','MediaRewind'])f.press({key});
  f.press({keyCode:23,repeat:true});assert.deepEqual(f.plays,[]);
  f.press({keyCode:23});assert.deepEqual(f.plays,[related[0]]);
});
test('Back and native requestBack close the sheet before fullscreen or player navigation',()=>{
  for(const key of [{key:'Escape'},{keyCode:4},{key:'Backspace'}]){
    const f=keysFixture();f.press(key);assert.equal(f.panel.isOpen(),false);assert.equal(f.document.activeElement.id,'hero-feed-focus');
  }
  const f=keysFixture();vm.runInContext(slice('handleBack','handleMediaCommand'),f.c);
  assert.equal(f.c.handleBack(),true);assert.equal(f.panel.isOpen(),false);
});

async function completion({mode='player',episode=2,season=1,successor=null,includeCurrent=true,relationSeason=1,relationNext=null,relationError=false,relatedRows=related,incomplete=false,late=false,followPrompt=false}={}){
  const calls=[],notices=[],playback={item:{series_id:'self',episode_count:2},episode,owner:1,generation:1,completed:true,started:true};
  let relationCalls=0;
  const c=vm.createContext({Promise,Object,Array,encodeURIComponent,activePlayback:playback,feedGeneration:1,accountEpoch:1,
    continuationGeneration:0,applicationInBackground:false,seasonSwitchRequest:null,confirmAfterClose:null,feedItems:[playback.item,{}],feedIndex:0,
    isPlaybackPage:()=>true,pageMode:()=>mode,applicationHidden:()=>false,
    getDetail:async()=>{if(late)c.activePlayback=null;return {vid_list:incomplete?['111']:['111','222'],episode_count:incomplete?8:2,related:relatedRows}},
    setPlayerStatus(){},episodeLoadingText(){return 'loading'},revealControls(){},showNotice:message=>notices.push(message),
    uiText:(key,fallback,values)=>Object.keys(values||{}).reduce((text,name)=>text.replace('{'+name+'}',values[name]),fallback),localizedError:error=>error.message,
    playFeedItem:(index,ep)=>calls.push(['play',index,ep]),refreshDetailAfterSeason(){},
    fetch:async()=>{relationCalls++;if(relationError)throw new Error('upstream response empty');return {ok:true,json:async()=>({ok:true,data:{next:relationNext,current_season:relationSeason}})}},
    fetchData:async()=>({items:[...(includeCurrent?[{series_id:'self',season_index:season}]:[]),...(successor?[successor]:[])]}),
    offerNextSeasonReservation:()=>{calls.push(['reservation']);return true},offerFollowAtEnd:(p,d,after)=>{if(!followPrompt)return false;calls.push(['follow',p,d]);c.confirmAfterClose=after;return true},offerEndRecommendations:(p,d)=>calls.push(['related',p,d.related])});
  vm.runInContext(slice('canContinuePlayback','offerNextSeasonReservation'),c);
  c.continueAfterEpisode(playback);for(let i=0;i<6;i++)await tick();return {calls,notices,c,playback,relationCalls};
}
test('ordinary episode continuation and a playable next season keep autoplay without a recommendation sheet',async()=>{
  assert.deepEqual((await completion({episode:1})).calls,[['play',0,2]]);
  const f=await completion({successor:{series_id:'next',season_index:2,vid:'333',episode_count:2,playable:true}});
  assert.deepEqual(f.calls,[['play',0,1]]);
});
test('the complete season selector drives autoplay and reservation even if the relationship endpoint is empty',async()=>{
  const playable=await completion({season:2,relationError:true,successor:{series_id:'s3',season_index:3,vid:'333',episode_count:133,playable:true}});
  assert.deepEqual(playable.calls,[['play',0,1]]);
  assert.equal(playable.relationCalls,0);

  const upcoming=await completion({season:3,relationError:true,successor:{series_id:'s4',season_index:4,upcoming:true,reservation_id:'s4'}});
  assert.deepEqual(upcoming.calls,[['reservation']]);
  assert.equal(upcoming.relationCalls,0);
});
test('relationship data only fills an unknown current season and cannot skip a missing season',async()=>{
  const fallback=await completion({includeCurrent:false,relationSeason:2,relationNext:{series_id:'wrong',season_index:9,vid:'999',episode_count:9,playable:true},successor:{series_id:'s3',season_index:3,vid:'333',episode_count:133,playable:true}});
  assert.deepEqual(fallback.calls,[['play',0,1]]);
  assert.equal(fallback.relationCalls,1);

  const gap=await completion({season:2,relationError:true,successor:{series_id:'s4',season_index:4,vid:'444',episode_count:12,playable:true}});
  assert.equal(gap.calls.some(call=>call[0]==='play'),false);
  assert.match(gap.notices[0],/季列表不完整/);
  assert.equal(gap.relationCalls,0);

  const noSkip=await completion({includeCurrent:false,relationSeason:2,relationNext:{series_id:'s4',season_index:4,vid:'444',episode_count:12,playable:true},successor:{series_id:'s4',season_index:4,vid:'444',episode_count:12,playable:true}});
  assert.equal(noSkip.calls.some(call=>call[0]==='play'),false);
  assert.match(noSkip.notices[0],/季列表不完整/);
  assert.equal(noSkip.relationCalls,1);
});
test('a missing current season still pauses safely when its season number cannot be confirmed',async()=>{
  const f=await completion({includeCurrent:false,relationError:true,successor:{series_id:'s3',season_index:3,vid:'333',episode_count:133,playable:true}});
  assert.equal(f.calls.some(call=>call[0]==='play'),false);
  assert.match(f.notices[0],/upstream response empty/);
  assert.equal(f.relationCalls,1);
});
test('terminal playback offers the current detail data, after any next-season reservation prompt',async()=>{
  const end=await completion();assert.equal(end.calls[0][0],'related');assert.equal(end.calls[0][1],end.playback);assert.equal(end.calls[0][2],related);
  const reserve=await completion({successor:{series_id:'next',season_index:2,upcoming:true,reservation_id:'book'}});
  assert.deepEqual(reserve.calls.map(c=>c[0]),['reservation']);
  assert.equal(typeof reserve.c.confirmAfterClose, 'function');
  reserve.c.confirmAfterClose();
  assert.deepEqual(reserve.calls.map(c=>c[0]),['reservation','related']);
});
test('terminal card playback sequences reservation, follow and recommendations after each prompt closes',async()=>{
  const end=await completion({followPrompt:true});
  assert.deepEqual(end.calls.map(c=>c[0]),['follow']);
  end.c.confirmAfterClose();
  assert.deepEqual(end.calls.map(c=>c[0]),['follow','related']);

  const reserve=await completion({successor:{series_id:'next',season_index:2,upcoming:true,reservation_id:'book'},followPrompt:true});
  assert.deepEqual(reserve.calls.map(c=>c[0]),['reservation']);
  reserve.c.confirmAfterClose();
  assert.deepEqual(reserve.calls.map(c=>c[0]),['reservation','follow']);
  reserve.c.confirmAfterClose();
  assert.deepEqual(reserve.calls.map(c=>c[0]),['reservation','follow','related']);
});
test('recommendation feed, incomplete season data and stale completion callbacks do not offer a row',async()=>{
  const recommend=await completion({mode:'recommend'});assert.equal(recommend.calls.filter(c=>c[0]==='related').length,0);
  for(const args of [{incomplete:true},{late:true}])assert.deepEqual((await completion(args)).calls,[]);
});
