const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'),'utf8');
const start=source.indexOf("    if (zone === 'repairSettings') {"),end=source.indexOf("    if (zone === 'appUpdates') {",start);
const announcementStart=source.indexOf("    if (zone === 'announcements') {"),announcementEnd=source.indexOf("    if (zone ===",announcementStart+12);
function fixture(on){
 const nodes={toggle:{id:'toggle'},check:{id:'check'},restore:{id:'restore'},sidebar:{id:'sidebar'},menu:{id:'menu'},notice:{id:'notice'}};
 const visible=selector=>selector==='#playback-repair-check'?nodes.check:selector==='#playback-repair-restore'?(on?nodes.restore:null):selector==='#playback-repair-toggle'?nodes.toggle:null;
 const context=vm.createContext({document:{getElementById:()=>nodes.toggle},firstVisible:visible,selectedSidebarDisplay:()=>nodes.menu,activeSidebar:()=>nodes.sidebar,focusables:()=>[nodes.notice,nodes.toggle,nodes.menu]});
 vm.runInContext('function route(zone,current,direction){'+source.slice(start,end)+source.slice(announcementStart,announcementEnd)+'}',context);
 return {nodes,move:(node,direction)=>context.route('repairSettings',node,direction),announcement:()=>context.route('announcements',nodes.notice,'down')};
}
test('repair switch is reached from notice and returns through the same settings path',()=>{
 const {nodes,move,announcement}=fixture(false);assert.equal(announcement(),nodes.toggle);assert.equal(move(nodes.toggle,'down'),nodes.check);assert.equal(move(nodes.check,'down'),nodes.menu);assert.equal(move(nodes.check,'up'),nodes.toggle);assert.equal(move(nodes.check,'right'),null);assert.equal(move(nodes.toggle,'up'),nodes.notice);assert.equal(move(nodes.toggle,'left'),nodes.sidebar);
});
test('enabled controls have deterministic remote focus without changing layout',()=>{
 const {nodes,move}=fixture(true);assert.equal(move(nodes.toggle,'down'),nodes.check);assert.equal(move(nodes.check,'right'),nodes.restore);assert.equal(move(nodes.restore,'left'),nodes.check);assert.equal(move(nodes.check,'up'),nodes.toggle);assert.equal(move(nodes.restore,'down'),nodes.menu);
});
test('settings first entry prioritizes notice then playback repair before ordinary settings',()=>{
 assert.match(source,/pageMode\(\) === 'settings'\) return firstVisible\('\.announcement-action'\) \|\| firstVisible\('#playback-repair-toggle'\)/);
 assert.match(source,/zoneSelectors = \{[\s\S]*?repairSettings: '\.repair-action'/);
});
