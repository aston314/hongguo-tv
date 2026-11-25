const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const repair=require('../core/cmd/hongguotv/ui/playback-repair.js'),{uiText}=require('./helpers/app-text.cjs');
const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
function fixture(){
 const nodes={};const document={activeElement:null,getElementById(id){if(!nodes[id])nodes[id]={id,textContent:'',attrs:{},hidden:false,classList:{contains(name){return name==='is-hidden'&&nodes[id].hidden;},toggle(name,value){if(name==='is-hidden')nodes[id].hidden=value;}},getAttribute(name){return this.attrs[name];},setAttribute(name,value){this.attrs[name]=value;},querySelector(){return nodes.label;}};return nodes[id];}};
 nodes.label={textContent:''};let focus=null;const context=vm.createContext({document,window:{HongguoPlaybackRepair:repair},repairSaving:false,repairText:(k,p)=>uiText('repair.'+k,'',p),repairTextContent:(id,v)=>document.getElementById(id).textContent=v,updatePlaybackRepairOffer(){},announcements:null,goFocus:n=>{focus=n;}});
 vm.runInContext(source.slice(source.indexOf('  function renderPlaybackRepair('),source.indexOf('  var playbackRepair = window.HongguoPlaybackRepair.create')),context);
 return {nodes,document,render:s=>context.renderPlaybackRepair(s),focus:()=>focus};
}
const baseline={supported:true,enabled:false,source:'native',checking:false,change:0,event:'native',native_profile:{automatic:true,version:'default.1',source:'embedded',event:'embedded_ready',checking:false,change:0}};
test('settings keeps check reachable with JS off, shows actual priority, and updates without replacing focused controls',()=>{
 const f=fixture();f.render(baseline);assert.equal(f.nodes['playback-repair-current'].textContent,'默认规则');assert.equal(f.nodes['playback-repair-badge'].textContent,'JSON');assert.equal(f.nodes['playback-repair-version'].textContent,'版本 default.1');assert.equal(f.nodes['playback-repair-restore'].hidden,true);
 const check=f.nodes['playback-repair-check'];f.document.activeElement=check;
 f.render({...baseline,native_profile:{...baseline.native_profile,checking:true}});assert.equal(check.attrs['aria-disabled'],'true');assert.equal(f.nodes['playback-repair-status'].textContent,'正在检查并验证解析更新…');assert.equal(f.document.activeElement,check);assert.equal(f.focus(),null);
 f.render({...baseline,enabled:true});assert.equal(f.nodes['playback-repair-current'].textContent,'默认规则');assert.equal(f.nodes['playback-repair-restore'].hidden,false);
 f.render({...baseline,enabled:true,source:'repair',version:'js.2'});assert.equal(f.nodes['playback-repair-current'].textContent,'修复规则');assert.equal(f.nodes['playback-repair-badge'].textContent,'JS');assert.equal(f.nodes['playback-repair-version'].textContent,'版本 js.2');
 f.document.activeElement=f.nodes['playback-repair-restore'];f.render(baseline);assert.equal(f.focus(),check);assert.equal(f.nodes['playback-repair-restore'].hidden,true);
});
test('all supported locales name current priority, rule types, version and check outcomes without missing labels',()=>{
 for(const [file,locale] of [['zh-CN','zh-CN'],['zh-TW','zh-TW'],['ja-JP','ja-JP']]){
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/locales/'+file+'.js'),'utf8'),context);const messages=context.HongguoLocales[locale];
  for(const key of ['automatic','currentPriority','defaultRule','repairRule','builtinRule','version','defaultReady','pendingDefault','defaultDisabled'])assert.ok(messages['repair.'+key],locale+':'+key);
 }
});
