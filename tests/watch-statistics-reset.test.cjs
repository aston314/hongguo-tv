const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const stats = require('../core/cmd/hongguotv/ui/watch-statistics.js');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function element() {
  const classes = new Set();
  return {dataset:{},style:{},children:[],textContent:'',disabled:false,
    classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),toggle(x,on){if(on)classes.add(x);else classes.delete(x);},contains:x=>classes.has(x)},
    setAttribute(){},appendChild(child){this.children.push(child);},
    set innerHTML(value){this.children=[];}};
}
function viewFixture() {
  const nodes = new Map(), q = key => {if(!nodes.has(key))nodes.set(key,element());return nodes.get(key);};
  const buttons=['types','genres'].map(kind=>{const el=element();el.dataset.statKind=kind;return el;});
  const events={};
  const root={querySelector:q,querySelectorAll:selector=>selector==='[data-stat-kind]'?buttons:q('[data-stat-columns]').children,contains:()=>true,addEventListener:(name,fn)=>events[name]=fn};
  let owner='account',saved={since:'2026-11-01',days:{[stats.dayKey(Date.now())]:{ms:60000,types:{real:60000},genres:{悬疑:60000}}}};
  let reset=async()=>{saved={since:stats.dayKey(Date.now()),reset_at:Date.now(),revision:'reset',days:{}};return saved;};
  const text=(_,fallback,params)=>fallback.replace(/\{(\w+)\}/g,(m,key)=>params&&params[key]!==undefined?params[key]:m);
  const prior=global.document;global.document={createElement:element};
  const view=stats.createView({root,text,owner:()=>owner,flush:async()=>{},request:async()=>saved,reset:owner=>reset(owner)});
  return {view,q,setOwner:v=>owner=v,setSaved:v=>saved=v,setReset:v=>reset=v,restore:()=>global.document=prior,
    clickKind:kind=>events.click({target:{closest:()=>({dataset:{statKind:kind},hasAttribute:name=>name==='data-stat-kind'})}})};
}

test('view updates totals and exact start only after a successful reset, and preserves them on failure',async()=>{
 const f=viewFixture();
 try {
 f.view.show();await tick();assert.equal(f.q('[data-stat-value="today"]').textContent,'1 分钟');
 const original=f.q('[data-stat-since]').textContent;
 f.setReset(async()=>{throw Error('disk full');});
 await assert.rejects(f.view.reset('account'));
 assert.equal(f.q('[data-stat-value="today"]').textContent,'1 分钟');assert.equal(f.q('[data-stat-since]').textContent,original);assert.equal(f.q('[data-stat-reset]').disabled,false);
 const resetAt=new Date(2026,10,11,14,30).getTime();
 const saved={since:'2026-11-11',reset_at:resetAt,revision:'reset',days:{}};
 f.setReset(async()=>{f.setSaved(saved);return saved;});
 assert.equal(await f.view.reset('account'),true);
 assert.equal(f.q('[data-stat-value="today"]').textContent,'0 分钟');assert.equal(f.q('[data-stat-value="month"]').textContent,'0 分钟');
 assert.equal(f.q('[data-stat-since]').textContent,'开始记录：2026-11-11 14:30');
 f.view.hide();f.view.show();await tick();assert.equal(f.q('[data-stat-since]').textContent,'开始记录：2026-11-11 14:30');
 }finally{f.restore();}
});

test('late reset responses cannot replace another account statistics',async()=>{
 const f=viewFixture();
 try {
 f.view.show();await tick();let finish;
 f.setReset(()=>new Promise(resolve=>finish=resolve));
 const pending=f.view.reset('account');await tick();
 assert.equal(f.q('[data-stat-reset]').disabled,true);
 f.setOwner('other');f.setSaved({since:'2026-11-02',days:{}});f.view.reload();await tick();
 finish({since:'2026-11-11',reset_at:Date.now(),revision:'old-account',days:{}});
 assert.equal(await pending,false);assert.equal(f.q('[data-stat-since]').textContent,'开始记录：2026-11-02');
 assert.equal(await f.view.reset('account'),false,'account change before confirmation also prevents a reset');
 }finally{f.restore();}
});

test('confirmation defaults to Cancel, restores reset focus, and rechecks the account before deletion',async()=>{
 const nodes=new Map(),q=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 let owner='',resets=0;
 const context=vm.createContext({Promise,confirmationGeneration:0,confirmOpen:false,confirmAfterClose:null,accountEpoch:1,
  document:{getElementById:q,querySelector:()=>q('reset'),activeElement:q('reset')},
  watchStatisticsOwner:()=>owner,watchStatisticsView:{isOpen:()=>true,reset:async()=>{resets++;return true;}},
  uiText:(_,fallback)=>fallback,goFocus:node=>context.document.activeElement=node,focusables:()=>Array.from(nodes.values()),
  firstContentFocus:()=>q('back'),showNotice(){},flushEndRecommendations(){}});
 vm.runInContext(source.slice(source.indexOf('  function closeConfirmation('),source.indexOf('  function confirmClearLibrary('))+
  source.slice(source.indexOf('  function confirmResetWatchStatistics('),source.indexOf('  var watchStatisticsCollector =')),context);
 context.confirmResetWatchStatistics();assert.equal(context.document.activeElement,q('confirm-cancel'));assert.equal(resets,0);
 context.closeConfirmation();assert.equal(context.document.activeElement,q('reset'));assert.equal(resets,0);
 context.confirmResetWatchStatistics();owner='other';await context.confirmOperation();assert.equal(resets,0);
 context.closeConfirmation();context.confirmResetWatchStatistics();await context.confirmOperation();assert.equal(resets,1);
});

test('preference count and scrolling include all genres when switching categories',async()=>{
 const f=viewFixture();
 try {
 const genres=Object.fromEntries(Array.from({length:12},(_,i)=>['题材'+i,(12-i)*60000]));
 f.setSaved({days:{[stats.dayKey(Date.now())]:{ms:78*60000,types:{real:78*60000},genres}}});
 f.view.show();await tick();assert.equal(f.q('[data-stat-preference-count]').textContent,'本月 · 共 1 项');
 f.clickKind('genres');
 const list=f.q('[data-stat-preferences]');assert.equal(list.children.length,12);
 assert.equal(f.q('[data-stat-preference-count]').textContent,'本月 · 共 12 项');
 assert.equal(list.children[11].children[0].children[0].textContent,'题材11','lower-ranked entries remain available');
 list.scrollTop=200;f.clickKind('types');assert.equal(list.scrollTop,0);assert.equal(list.children.length,1);
 f.clickKind('genres');assert.equal(list.children.length,12);assert.equal(list.scrollTop,0);
 }finally{f.restore();}
});

test('stacked statistics focus follows the vertical layout and supports empty preferences',()=>{
 const back={hasAttribute:k=>k==='data-stat-back'},reset={hasAttribute:k=>k==='data-stat-reset'},kind={dataset:{statKind:'types'},hasAttribute:k=>k==='data-stat-kind'};
 const sidebar={},targets={'[data-stat-back]':back,'[data-stat-reset]':reset,'[data-stat-kind][aria-pressed="true"]':kind};
 const block=source.slice(source.indexOf("    if (zone === 'watchStatistics')"),source.indexOf("    if (zone === 'libraryActions')"));
 const days=[0,1].map(i=>({hasAttribute:k=>k==='data-stat-day',index:i}));
 const preferences=[0,1,2].map(i=>({hasAttribute:k=>k==='data-stat-preference',index:i}));
 const context=vm.createContext({firstVisible:s=>targets[s]||null,activeSidebar:()=>sidebar,
  focusables:s=>s==='[data-stat-day]'?days:preferences});
 vm.runInContext('function route(current,direction){var zone="watchStatistics";'+block+'}',context);
 assert.equal(context.route(back,'right'),reset);assert.equal(context.route(reset,'left'),back);
 assert.equal(context.route(kind,'up'),back);assert.equal(context.route(reset,'down'),kind);
 assert.equal(context.route(back,'left'),sidebar);
 targets['[data-stat-day][aria-pressed="true"]']=days[1];targets['[data-stat-preference]']=preferences[0];
 assert.equal(context.route(reset,'down'),days[1]);assert.equal(context.route(days[1],'down'),kind);
 assert.equal(context.route(days[1],'right'),null,'right boundary stays in the trend row');
 assert.equal(context.route(kind,'up'),days[1]);assert.equal(context.route(kind,'down'),preferences[0]);
 assert.equal(context.route(kind,'left'),sidebar);
 assert.equal(context.route(preferences[0],'up'),kind);assert.equal(context.route(preferences[0],'down'),preferences[1]);
 assert.equal(context.route(preferences[2],'down'),null);assert.equal(context.route(preferences[2],'left'),sidebar);
});
