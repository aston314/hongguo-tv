const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create, normalize} = require('../core/cmd/hongguotv/ui/search-discovery.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const board = {id:'short', items:Array.from({length:9}, (_,i)=>({series_id:String(90000+i), title:'热搜剧'+i, position:i+1}))};

test('discovery only accepts available playable boards and caps compact rows', () => {
  const value = normalize({guesses:[{title:'关键词',query:'关键词'}], boards:[board, board, {id:'topics',items:board.items}, {id:'comic',items:[{series_id:'0',title:'无效'}]}]});
  assert.equal(value.guesses[0].query, '关键词');
  assert.equal(value.boards.length, 1); assert.equal(value.boards[0].items.length, 6);
  assert.deepEqual(normalize({boards:{}, guesses:'bad'}), {guesses:[], boards:[]});
});
test('late response cannot reopen a submitted search; revisiting reuses cached data', async () => {
  let resolve, reads=0, clock=1; const renders=[];
  const controller = create({now:()=>clock, request:()=>{reads++;return new Promise(r=>resolve=r);}, render:data=>renders.push(data)});
  const first=controller.show(), second=controller.show(); await flush();
  assert.equal(reads,1); controller.hide(); const count=renders.length;
  resolve({boards:[board]}); await Promise.all([first,second]);
  assert.equal(renders.length,count); assert.deepEqual(renders.at(-1),{guesses:[],boards:[]});
  await controller.show(); assert.equal(reads,1); assert.equal(renders.at(-1).boards[0].items.length,6);
});
test('optional failures hide the area and cool down without blocking a later retry', async () => {
  let clock=100, reads=0; const renders=[];
  const controller=create({now:()=>clock,request:async()=>{if(++reads===1)throw Error('offline');return {boards:[board]};},render:data=>renders.push(data)});
  await controller.show(); assert.equal(renders.at(-1).boards.length,0);
  await controller.show(); assert.equal(reads,1);
  clock+=60001; await controller.show(); assert.equal(reads,2); assert.equal(renders.at(-1).boards.length,1);
});
test('player navigation suspends late rendering while retaining cached nodes for return focus', async () => {
  const renders=[];
  const controller=create({request:async()=>({boards:[board]}),render:data=>renders.push(data)});
  await controller.show(); const cached=renders.at(-1), count=renders.length;
  controller.hide(true); assert.equal(renders.length,count);
  await controller.show(); assert.equal(renders.at(-1),cached);
});
