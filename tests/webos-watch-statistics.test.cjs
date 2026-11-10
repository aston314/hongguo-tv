const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const create = require('../webos/service/watch-statistics');
test('webOS statistics are atomic, idempotent, bounded and separated by owner',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hg-stat-test-'));
 try {
 const service=create({dataDir:dir,now:()=>Date.UTC(2026,10,10,12)});
 const batch={owner_id:'',id:'webos-batch-001',items:[{day:'2026-11-10',ms:30000,type:'real',genre:'悬疑'}]};
 await Promise.all(Array.from({length:8},()=>service.request('POST','','2026-11-10',batch)));
 let data=await service.request('GET','','2026-11-10');assert.equal(data.days['2026-11-10'].ms,30000);assert.equal(data.days['2026-11-10'].genres.悬疑,30000);assert.equal(data.batches,undefined);
 assert.deepEqual((await service.request('GET','account','2026-11-10')).days,{});
 await assert.rejects(service.request('POST','account','2026-11-10',batch));
 for(let i=0;i<70;i++) {batch.id='webos-'+String(i).padStart(8,'0');batch.items[0].genre='题材'+i;await service.request('POST','','2026-11-10',batch);}
 data=await service.request('GET','','2026-11-10');assert.ok(Object.keys(data.days['2026-11-10'].genres).length<=16);
 const saved=JSON.parse(fs.readFileSync(path.join(dir,'watch-statistics',fs.readdirSync(path.join(dir,'watch-statistics'))[0])));assert.equal(saved.batches.length,64);
 assert.equal(fs.existsSync(path.join(dir,'library.json')),false);
 await assert.rejects(service.request('GET','','2026-11-15'));
 batch.items[0].genre='__proto__';assert.equal(create.validate(batch,'2026-11-10'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
