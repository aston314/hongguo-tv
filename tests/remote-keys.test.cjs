const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('./helpers/app-text.cjs');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const keyNames = source.match(/  var keyNames = \{[\s\S]*?\n  \};/)[0];
const remoteFocus = source.slice(source.indexOf('  function remoteFocusTarget('), source.indexOf('  function paintFocus('));
const keys = source.slice(source.indexOf('  function normalizedKey('), source.indexOf('  function showNotice('));
function keyboard() {
  const c = vm.createContext({});
  vm.runInContext(`
    var current={id:'sidebar-recommend',classList:{contains:function(){return false}}};
    var highlighted=current;
    var document={activeElement:current,body:{id:'body'},querySelector:function(selector){return selector==='.is-focused'?highlighted:null}};
    function focusables(){return highlighted?[highlighted]:[]}
    var lastPageFocus={search:current};
    var detailModalOpen=false,playerOptionsOpen=false,confirmOpen=false,discussionOpen=false;
    var androidShell=false,searchSuggestionActivation=null; function accountKeypadOpen(){return false}
    function firstVisible(selector){return {id:selector.slice(1)}}
    var shellState={};
    var shell={classList:{contains:function(name){return shellState[name]===true}}};
    var moved=[],focused=[],clicks=0,backs=0,searches=0,played=[],notices=[];
    var activePlayback=null,playbackRequest=null,feedItems=[],feedIndex=0,featuredItem=null;
    function playFeedItem(index,episode,position){played.push([index,episode,position])}
    function showNotice(message){notices.push(message)}
    document.getElementById=function(id){return {id:id}}
    function pageMode(){return 'search'}
    function isPlaybackPage(){return false}
    function zoneOf(){return 'sidebar'}
    function moveFrom(current,direction){moved.push(direction);return {id:direction}}
    function goFocus(target){focused.push(target.id);highlighted=target;if(!target.classList)target.classList={contains:function(){return false}};if(!target.click)target.click=function(){clicks++}}
    function revealControls(){}
    function handleMediaCommand(){return false}
    function handleEndRecommendationKey(){return false}
    function handleBack(){backs++;return true}
    function submitSearch(){searches++}
    current.click=function(){clicks++};
  ` + remoteFocus + keyNames + keys, c);
  return c;
}
test('Android 6 DOM arrows without event.key enter the application focus router', () => {
  const c=keyboard();
  for (const keyCode of [37,38,39,40]) {
    let prevented=0,stopped=0;
    c.handleKey({keyCode,preventDefault(){prevented++},stopPropagation(){stopped++}});
    assert.equal(prevented,1);assert.equal(stopped,1);
  }
  assert.deepEqual(Array.from(c.moved),['left','up','right','down']);
  assert.deepEqual(Array.from(c.focused),['left','up','right','down']);
});
test('legacy arrow names, keyIdentifier, Unknown and numeric fallbacks are accepted', () => {
  const c=keyboard();
  for (const [event,key] of [
    [{key:'Left'},'ArrowLeft'],[{key:'Up'},'ArrowUp'],[{key:'Right'},'ArrowRight'],[{key:'Down'},'ArrowDown'],
    [{keyIdentifier:'Down',keyCode:40},'ArrowDown'],[{key:'Unidentified',keyCode:38},'ArrowUp'],
    [{key:'Unknown',keyCode:39},'ArrowRight'],[{which:37},'ArrowLeft'],
    [{keyIdentifier:'U+000D',keyCode:13},'Enter'],[{keyCode:27},'Escape'],
    [{keyCode:19},'ArrowUp'],[{keyCode:23},'Enter'],[{keyCode:66},'Enter'],
    [{key:'ArrowDown',keyCode:0},'ArrowDown'],[{key:'a',keyCode:65},'a']
  ]) assert.equal(c.normalizedKey(event),key);
});
test('old DOM Enter activates once and repeat is suppressed', () => {
  const c=keyboard();
  const event={keyCode:13,preventDefault(){},stopPropagation(){}};
  c.handleKey(event);c.handleKey({...event,repeat:true});
  assert.equal(c.clicks,1);
});
test('text editing retains native left and right keys instead of moving focus', () => {
  const c=keyboard();
  for (const id of ['search-input','player-compose-input']) {
    vm.runInContext(`document.activeElement={id:'${id}',classList:{contains:function(name){return name==='${id==='account-phone'?'account-input':id==='player-compose-input'?'player-text-input':''}'}}}`,c);
    for (const keyCode of [37,39]) c.handleKey({keyCode,preventDefault(){assert.fail('editing key consumed')},stopPropagation(){assert.fail('editing key stopped')}});
  }
  assert.equal(c.moved.length,0);
});
test('search deletion stays native for modern and legacy keys, including held Backspace', () => {
  const c=keyboard();c.document.activeElement.id='search-input';
  for(const event of [{key:'Backspace'},{keyIdentifier:'U+0008',keyCode:8},{key:'Unknown',keyCode:8},{which:8},{keyCode:8,repeat:true},{key:'Delete'},{keyCode:46}]) {
    c.handleKey({...event,preventDefault(){assert.fail('editing key consumed')},stopPropagation(){assert.fail('editing key stopped')}});
  }
  assert.equal(c.backs,0);assert.equal(c.moved.length,0);assert.equal(c.focused.length,0);assert.equal(c.searches,0);
});
test('application Backspace outside search and Escape inside search retain back navigation', () => {
  const c=keyboard();let prevented=0,stopped=0;
  const event={preventDefault(){prevented++},stopPropagation(){stopped++}};
  c.handleKey({...event,keyCode:8});c.document.activeElement.id='search-input';c.handleKey({...event,keyCode:27});
  assert.equal(c.backs,2);assert.equal(prevented,2);assert.equal(stopped,2);
});
test('search Enter still submits once while up/down retain focus navigation', () => {
  const c=keyboard();c.document.activeElement.id='search-input';
  const event={preventDefault(){},stopPropagation(){}};
  c.handleKey({...event,keyCode:13});c.handleKey({...event,keyCode:13,repeat:true});
  c.handleKey({...event,keyCode:38});c.handleKey({...event,keyCode:40});
  assert.equal(c.searches,1);assert.deepEqual(Array.from(c.moved),['up','down']);assert.equal(c.backs,0);
});
test('Android search input notifies the native shell without changing browser focus behavior', () => {
  assert.match(source, /startSearchEditing/);
  assert.match(source, /event\.target\.id === 'search-input'/);
  assert.match(source, /androidShell && event\.target/);
});
test('native remote bridge uses the existing focus router for arrows and confirm', () => {
  const c=keyboard();
  assert.equal(c.remoteKey(20,false),true);
  assert.equal(c.remoteKey(19,true),true);
  assert.equal(c.remoteKey(21,false),true);
  assert.equal(c.remoteKey(22,false),true);
  assert.equal(c.remoteKey(23,false),true);
  assert.equal(c.clicks,1);
  assert.deepEqual(Array.from(c.moved),['down','up','left','right']);
  assert.deepEqual(Array.from(c.focused),['down','up','left','right']);
});
test('native remote navigation follows the painted focus when WebView activeElement is lost', () => {
  const c=keyboard();
  c.searchInput={id:'search-input',classList:{contains:function(){return false}}};
  c.suggestion={id:'suggestion',classList:{contains:function(){return false},add:function(){}}};
  vm.runInContext(`
    document.activeElement=document.body;
    highlighted=searchInput;
    lastPageFocus.search=searchInput;
    searchSuggestionOpen=true;
    moveFrom=function(current,direction){moved.push(current.id+':'+direction);return current===searchInput&&direction==='down'?suggestion:null};
  `,c);
  assert.equal(c.remoteKey(20,false),true);
  assert.deepEqual(Array.from(c.moved),['search-input:down']);
  assert.deepEqual(Array.from(c.focused),['suggestion']);
  assert.equal(c.remoteKey(23,false),true);
  assert.equal(c.clicks,1);
});
test('account number buttons activate once without submitting SMS or login', () => {
  const c=keyboard();
  vm.runInContext("var submissions=0;function accountSendCode(){submissions++};function accountLogin(){submissions++};",c);
  for (const id of ['account-phone','account-code']) {
    vm.runInContext(`document.activeElement={id:'${id}',click:function(){clicks++},classList:{contains:function(name){return name==='account-input'}}}`,c);
    const e={keyCode:13,preventDefault(){},stopPropagation(){}};
    c.handleKey(e);c.handleKey({...e,repeat:true});
  }
  assert.equal(c.submissions,0);assert.equal(c.clicks,2);assert.equal(c.focused.length,0);
});
test('Android account number buttons route all arrows to navigation', () => {
  const c=keyboard();
  vm.runInContext("androidShell=true;document.activeElement={id:'account-phone',classList:{contains:function(name){return name==='account-input'}}}",c);
  for (const keyCode of [37,38,39,40]) c.handleKey({keyCode,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(Array.from(c.moved),['left','up','right','down']);
});
test('single-player feed arrows switch episodes while recommendation arrows stay on recommendation items', () => {
  const c=keyboard();
  vm.runInContext(`
    pageMode=function(){return 'player'};
    zoneOf=function(){return 'feed'};
    isPlaybackPage=function(){return true};
    activePlayback={episode:4,item:{series_id:'series-1',episode_count:8}};
    feedItems=[activePlayback.item]; feedIndex=0;
  `,c);
  c.handleKey({keyCode:38,preventDefault(){},stopPropagation(){}});
  c.handleKey({keyCode:40,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(c.played))),[[0,3,0],[0,5,0]]);
  assert.deepEqual(Array.from(c.focused),['hero-feed-focus','hero-feed-focus']);

  vm.runInContext(`pageMode=function(){return 'recommend'}; played=[]; focused=[];`,c);
  vm.runInContext(`switchRecommendation=function(step){played.push(['recommend',step])}`,c);
  c.handleKey({keyCode:38,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(c.played))),[['recommend',-1]]);
});
test('fullscreen recommendation playback switches episodes, while windowed recommendation playback changes dramas', () => {
  const c=keyboard();
  vm.runInContext(`
    pageMode=function(){return 'recommend'};
    zoneOf=function(){return 'feed'};
    activePlayback={episode:2,item:{series_id:'series-1',episode_count:6}};
    feedItems=[activePlayback.item]; feedIndex=0; played=[]; focused=[];
    shellState['is-cinema']=true;
  `,c);
  c.handleKey({keyCode:38,preventDefault(){},stopPropagation(){}});
  c.handleKey({keyCode:40,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(c.played))),[[0,1,0],[0,3,0]]);
  assert.deepEqual(Array.from(c.focused),['hero-feed-focus','hero-feed-focus']);

  vm.runInContext(`shellState['is-cinema']=false; played=[]; focused=[]; switchRecommendation=function(step){played.push(['recommend',step])}`,c);
  c.handleKey({keyCode:38,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(c.played))),[['recommend',-1]]);
});
test('single-player episode switching consumes held arrows and reports season boundaries', () => {
  const c=keyboard();
  vm.runInContext(`
    pageMode=function(){return 'player'};
    zoneOf=function(){return 'feed'};
    activePlayback={episode:1,item:{series_id:'series-1',episode_count:3}};
    feedItems=[activePlayback.item]; feedIndex=0; played=[]; notices=[];
  `,c);
  c.handleKey({keyCode:38,preventDefault(){},stopPropagation(){}});
  c.handleKey({keyCode:40,repeat:true,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(Array.from(c.played),[]);
  assert.deepEqual(Array.from(c.notices),['已经是第一集']);

  vm.runInContext(`activePlayback.episode=3; notices=[];`,c);
  c.handleKey({keyCode:40,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(Array.from(c.played),[]);
  assert.deepEqual(Array.from(c.notices),['已经是本季最后一集']);
});
test('playback control focus keeps its existing vertical focus routing', () => {
  const c=keyboard();
  vm.runInContext(`
    pageMode=function(){return 'player'};
    isPlaybackPage=function(){return true};
    zoneOf=function(){return 'controls'};
    moveFrom=function(current,direction){moved.push(direction);return {id:'control-'+direction}};
    revealControls=function(){};
    document.activeElement={classList:{contains:function(name){return name==='control-button'}}};
  `,c);
  c.handleKey({keyCode:38,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(Array.from(c.moved),['up']);
  assert.deepEqual(Array.from(c.focused),['control-up']);
  assert.deepEqual(Array.from(c.played),[]);
});
test('single-player feed seeks horizontally only in cinema or hidden-controls mode', () => {
  const c=keyboard();
  vm.runInContext(`
    pageMode=function(){return 'player'};
    zoneOf=function(){return 'feed'};
    isPlaybackPage=function(){return true};
    seekBy=function(delta,reveal){played.push(['seek',delta,reveal])};
    shellState['is-controls-hidden']=true;
  `,c);
  c.handleKey({keyCode:37,preventDefault(){},stopPropagation(){}});
  c.handleKey({keyCode:39,repeat:true,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(c.played))),[['seek',-10,false],['seek',10,false]]);
  assert.deepEqual(Array.from(c.focused),[]);

  vm.runInContext(`shellState['is-controls-hidden']=false; shellState['is-cinema']=false; played=[]; moveFrom=function(current,direction){return {id:'route-'+direction}}`,c);
  c.handleKey({keyCode:37,preventDefault(){},stopPropagation(){}});
  c.handleKey({keyCode:39,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(c.played))),[]);
  assert.deepEqual(Array.from(c.focused),['route-left','route-right']);

  vm.runInContext(`shellState['is-cinema']=true; focused=[]`,c);
  c.handleKey({keyCode:39,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(c.played))),[['seek',10,false]]);

  vm.runInContext(`pageMode=function(){return 'recommend'}; shellState['is-cinema']=true; played=[]`,c);
  c.handleKey({keyCode:37,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(c.played))),[['seek',-10,false]]);
});
