const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../core/cmd/hongguotv/ui/playback-loading-grace.js');
function fixture(){
  let now=1000,id=0,valid=true,quiet=false,shows=0;const jobs=new Map();
  const api=create({now:()=>now,schedule(fn,delay){jobs.set(++id,{fn,at:now+delay});return id},unschedule:id=>jobs.delete(id),quiet:v=>{quiet=v},valid:()=>valid,show:()=>shows++});
  return {api,jobs,start(extra={}){return api.start({eligible:true,started_at:1000,...extra})},advance(ms){now+=ms;for(const [id,j] of [...jobs])if(j.at<=now){jobs.delete(id);j.fn()}},get quiet(){return quiet},get shows(){return shows},invalidate(){valid=false}};
}
test('prepared adjacent switches suppress loading until 800ms; fast completion never flashes it',()=>{
  const f=fixture();f.start();f.advance(799);assert(f.quiet);assert.equal(f.shows,0);
  f.api.cancel();f.advance(1000);assert(!f.quiet);assert.equal(f.shows,0);
  const slow=fixture();slow.start();slow.advance(800);assert(!slow.quiet);assert.equal(slow.shows,1);
});
test('cold starts and misses do not defer; cancelled or stale deadlines cannot affect a later source',()=>{
  const f=fixture();assert.equal(f.start({eligible:false}),false);assert.equal(f.jobs.size,0);
  f.start();const stale=[...f.jobs.values()][0].fn;f.start({generation:2});stale();assert(f.quiet);
  f.api.cancel();assert.equal(f.jobs.size,0);f.advance(1000);assert.equal(f.shows,0);
  f.start();f.invalidate();f.advance(800);assert(!f.quiet);assert.equal(f.shows,0);
});
test('setup uses the original deadline rather than waiting an extra 800ms',()=>{
  const f=fixture();f.advance(350);f.start();f.advance(449);assert(f.quiet);f.advance(1);assert.equal(f.shows,1);
});
