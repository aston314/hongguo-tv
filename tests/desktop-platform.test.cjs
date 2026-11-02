const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mediaSource,editing}=require('../core/cmd/hongguotv/ui/desktop.js');
const vm=require('node:vm'),fs=require('node:fs');
const app=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
test('desktop media alone bypasses the Wails scheme; foreign URLs are not rewritten',()=>{
 const path='/minireel-proxy/media/ab12.mp4',config={mediaBase:'http://127.0.0.1:34567'};
 assert.equal(mediaSource(path,config),config.mediaBase+path);
 for(const p of ['https://cdn.test/a.mp4','/api/v1/account','//evil.test/a.mp4','/minireel-proxy/media/../a.mp4'])assert.equal(mediaSource(p,config),p);
 assert.equal(mediaSource(path,{mediaBase:'http://evil.test'}),path);assert.equal(mediaSource(path),path);
});
test('desktop input keys preserve deletion, paste, arrows, tab, space and IME; Enter submits the right form',()=>{
 const keys=app.slice(app.indexOf('  function normalizedKey('),app.indexOf('  function showNotice('));
 const c=vm.createContext({window:{HongguoDesktopUI:{editing}},document:{activeElement:{tagName:'INPUT',id:'account-phone'}},desktopShell:true,searchSuggestionActivation:null});
 vm.runInContext(`var keyNames={},numericKeypad;function handleEndRecommendationKey(){return false}function accountKeypadOpen(){return false}var actions=[];function accountSendCode(){actions.push('phone')}function accountLogin(){actions.push('code')}function submitSearch(){actions.push('search')}`+keys,c);
 for(const key of ['Backspace','Delete','ArrowLeft','ArrowDown','Tab',' ','v'])c.handleKey({key,ctrlKey:key==='v',preventDefault(){assert.fail(key)},stopPropagation(){assert.fail(key)}});
 c.handleKey({key:'Enter',isComposing:true,preventDefault(){assert.fail('IME')},stopPropagation(){}});
 for(const [id,name] of [['account-phone','phone'],['account-code','code'],['search-input','search']]){c.document.activeElement.id=id;let prevented=0;c.handleKey({key:'Enter',preventDefault(){prevented++},stopPropagation(){}});assert.equal(prevented,1);assert.equal(c.actions.at(-1),name)}
});

test('desktop search Escape closes suggestions and keyboard arrows reach suggestions and search',()=>{
 const keys=app.slice(app.indexOf('  function normalizedKey('),app.indexOf('  function showNotice('));
 const input={tagName:'INPUT',id:'search-input',value:'剧名',selectionStart:2,selectionEnd:2,classList:{contains(){return false}}};
 const c=vm.createContext({window:{HongguoDesktopUI:{editing}},document:{activeElement:input},desktopShell:true,searchSuggestionActivation:null,shell:{classList:{contains(){return false}}}});
 vm.runInContext(`var keyNames={},numericKeypad,searchSuggestionOpen=true,backs=0,moved=[],focused=[];
 function handleEndRecommendationKey(){return false} function accountKeypadOpen(){return false}
 function handleBack(){backs++;searchSuggestionOpen=false;return true}
 function moveFrom(current,direction){moved.push(direction);return {id:direction==='down'?'search-suggestion':'search-submit',classList:{contains(){return false}}}}
 function firstSearchAction(){return {id:'search-submit',classList:{contains(){return false}}}} function goFocus(target){focused.push(target.id);document.activeElement=target}
 function submitSearch(){} function accountSendCode(){} function accountLogin(){}`+keys,c);
 let prevented=0,stopped=0;
 c.handleKey({key:'Escape',preventDefault(){prevented++},stopPropagation(){stopped++}});
 assert.equal(c.backs,1);assert.equal(prevented,1);assert.equal(stopped,1);
 c.document.activeElement=input; c.searchSuggestionOpen=true; prevented=0;stopped=0;
 c.handleKey({key:'ArrowDown',preventDefault(){prevented++},stopPropagation(){stopped++}});
 assert.deepEqual(Array.from(c.focused),['search-suggestion']);assert.deepEqual(Array.from(c.moved),['down']);assert.equal(prevented,1);assert.equal(stopped,1);
 c.document.activeElement=input; input.selectionStart=input.value.length;input.selectionEnd=input.value.length;prevented=0;stopped=0;
 c.handleKey({key:'ArrowRight',preventDefault(){prevented++},stopPropagation(){stopped++}});
 assert.equal(c.focused.at(-1),'search-submit');assert.equal(prevented,1);assert.equal(stopped,1);
});

test('desktop update bridge reads async status and calls only download/folder bindings',async()=>{
 const {createUpdateBridge}=require('../core/cmd/hongguotv/ui/desktop.js');const calls=[];
 const win={go:{main:{desktopApp:{GetUpdateStatus:async()=>JSON.stringify({desktop:true,supported:true,state:'available',latest_code:2}),CheckUpdate:async()=>calls.push('check'),DownloadUpdate:async()=>calls.push('download'),OpenUpdateFolder:async()=>calls.push('folder')}}}};
 const bridge=createUpdateBridge(win,{platform:'darwin',version:'0.2.59'});
 bridge.setPromptAllowed(false);bridge.getStatus();await new Promise(r=>setImmediate(r));assert.equal(JSON.parse(bridge.getStatus()).prompt_allowed,false);
 bridge.check();bridge.download();bridge.openFolder();await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['check','download','folder']);
 bridge.setPromptAllowed(true);assert.equal(JSON.parse(bridge.getStatus()).prompt_allowed,true);
});

test('native desktop window state ignores transient WebView hiding, but minimisation still pauses once',async()=>{
 const {createWindowMonitor}=require('../core/cmd/hongguotv/ui/desktop.js');let hidden=false,fullscreen=false,pauses=0,resumes=0;const fullscreens=[];
 const config={platform:'darwin'};
 const win={document:{hidden:true},HongguoTV:{pauseForBackground(){pauses++},resumeFromBackground(){resumes++},desktopFullscreenChanged(value){fullscreens.push(value)}},go:{main:{desktopApp:{GetWindowState:async()=>JSON.stringify({hidden,fullscreen})}}}};
 const monitor=createWindowMonitor(win,config),flush=()=>new Promise(r=>setImmediate(r));
 monitor.refresh();await flush();assert.equal(pauses,0);assert.equal(config.background,false);
 fullscreen=true;monitor.refresh();await flush();assert.equal(pauses,0);assert.deepEqual(fullscreens,[false,true]);
 fullscreen=false;monitor.refresh();await flush();assert.equal(pauses,0);assert.deepEqual(fullscreens,[false,true,false]);
 hidden=true;monitor.refresh();monitor.refresh();await flush();assert.equal(pauses,1);assert.equal(config.background,true);
 monitor.refresh();await flush();assert.equal(pauses,1);
 hidden=false;monitor.refresh();await flush();assert.equal(resumes,1);assert.equal(config.background,false);
});

test('Android visibility and desktop native minimisation remain independent',()=>{
 const c=vm.createContext({desktopShell:true,window:{HongguoDesktop:{background:false}},document:{hidden:true}});
 vm.runInContext(app.match(/  function applicationHidden[^\n]+/)[0],c);
 assert.equal(c.applicationHidden(),false);
 c.window.HongguoDesktop.background=true;assert.equal(c.applicationHidden(),true);
 c.desktopShell=false;assert.equal(c.applicationHidden(),true);
 c.document.hidden=false;assert.equal(c.applicationHidden(),false);
});
