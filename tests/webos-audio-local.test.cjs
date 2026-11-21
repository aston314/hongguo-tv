const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');

function box(type,payload){const p=Buffer.isBuffer(payload)?payload:Buffer.concat(payload),b=Buffer.alloc(p.length+8);b.writeUInt32BE(b.length,0);b.write(type,4);p.copy(b,8);return b;}
function u32(...values){const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeUInt32BE(v,i*4));return b;}
function esds(config=Buffer.from([0x12,0x10])){
  const decoder=Buffer.concat([Buffer.from([0x40,0x15]),Buffer.alloc(11),Buffer.from([0x05,config.length]),config]);
  const descriptor=Buffer.concat([Buffer.from([0x03,20+config.length,0,0,0,0x04,decoder.length]),decoder]);
  return box('esds',Buffer.concat([Buffer.alloc(4),descriptor]));
}
function fixture(tail=false,config){
  const ftyp=box('ftyp',Buffer.from('isom0000isom'));
  const samples=[Buffer.from('aac-one'),Buffer.from('aac-two'),Buffer.from('aac-three')];
  function movie(offsets){
    const handler=box('hdlr',Buffer.concat([u32(0,0),Buffer.from('soun'),Buffer.alloc(12)]));
    const sample=Buffer.alloc(28);sample.writeUInt16BE(2,16);sample.writeUInt32BE(44100*65536,24);
    const entry=box('mp4a',Buffer.concat([sample,esds(config)]));
    const stsd=box('stsd',Buffer.concat([u32(0,1),entry]));
    const stsz=box('stsz',Buffer.concat([u32(0,0,samples.length),...samples.map(s=>u32(s.length))]));
    const stsc=box('stsc',u32(0,1,1,1,1));
    const stco=box('stco',Buffer.concat([u32(0,samples.length),...offsets.map(x=>u32(x))]));
    const mdhd=box('mdhd',u32(0,0,0,44100,44100*samples.length));
    const stbl=box('stbl',[stsd,stsz,stsc,stco]);
    const track=box('trak',box('mdia',[mdhd,handler,box('minf',stbl)]));
    return box('moov',track);
  }
  let moov=movie([0,0,0]);
  const mdat=box('mdat',Buffer.concat(samples));
  const mediaStart=tail ? ftyp.length+8 : ftyp.length+moov.length+8;
  const offsets=[];let at=mediaStart;samples.forEach(s=>{offsets.push(at);at+=s.length;});
  moov=movie(offsets);
  return Buffer.concat(tail?[ftyp,mdat,moov]:[ftyp,moov,mdat]);
}
function source(){return '/minireel-proxy/media/'+('a'.repeat(24))+'.mp4';}
function loadLocal(){const context={};vm.runInNewContext(fs.readFileSync(require.resolve('../webos/app/webos-audio-local.js'),'utf8'),context);return context;}
function extract(bytes,options,signal){
  options=options||{};const context=loadLocal();let calls=0;
  function XHR(){this.status=0;this.response=null;this.headers={};this.aborted=false;}
  XHR.prototype.open=function(){};XHR.prototype.setRequestHeader=function(k,v){if(k.toLowerCase()==='range')this.range=v;};
  XHR.prototype.getResponseHeader=function(name){return this.headers[String(name).toLowerCase()]||null;};
  XHR.prototype.send=function(){const self=this;calls++;if(options.hold)return;setImmediate(function(){if(self.aborted)return;const p=self.range.slice(6).split('-').map(Number),start=p[0],end=p[1],actualEnd=options.short&&calls===options.short?end-1:end,body=bytes.subarray(start,actualEnd+1);self.status=206;self.response=body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength);self.headers['content-range']='bytes '+start+'-'+end+'/'+bytes.length;if(self.onload)self.onload();});};
  XHR.prototype.abort=function(){this.aborted=true;if(this.onabort)this.onabort();};
  context.XMLHttpRequest=XHR;
  return context.HongguoWebOSLocalAudio.extract(source(),signal,options.limits).then(function(result){return {result,calls};});
}
test('extracts AAC samples from moov before and after mdat',async()=>{
  for(const tail of [false,true]){const value=await extract(fixture(tail));assert.equal(value.result.channels,2);assert.equal(value.result.stats.samples,3);assert(value.result.data.byteLength>21);}
});
test('rejects a short Range body instead of decoding incomplete samples',async()=>{await assert.rejects(extract(fixture(),{short:4}),{code:'LOCAL_RANGE_MISMATCH'});});
test('aborting extraction aborts the in-flight XHR',async()=>{
  const signal={aborted:false,listeners:[],addEventListener(type,fn){if(type==='abort')this.listeners.push(fn);},removeEventListener(type,fn){this.listeners=this.listeners.filter(x=>x!==fn);}};
  const pending=extract(fixture(),{hold:true},signal);signal.aborted=true;signal.listeners.slice().forEach(fn=>fn());await assert.rejects(pending,{code:'WEBOS_AUDIO_CANCELLED'});
});
test('public helpers reject invalid sample spans and produce ADTS headers',()=>{
  const local=loadLocal().HongguoWebOSLocalAudio;assert.throws(()=>local._spansOf([{off:0,size:0}]),{code:'LOCAL_SAMPLE_RANGE'});
  const output=new Uint8Array(local._adts({objectType:2,freqIndex:4,channels:2},[new Uint8Array([1,2,3])],3));assert.deepEqual(Array.from(output.slice(0,7)),[255,241,80,128,1,95,252]);
});
function asc(aot,fi,ch,extension=4,core=2,flags=0){
  const bits=[[aot,5],[fi,4],[ch,4],[extension,4],[core,5],[flags,3]].map(([v,n])=>v.toString(2).padStart(n,'0')).join('').padEnd(32,'0');
  return Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)));
}
test('HE-AACv1/v2 ADTS keeps core rate and channels, with stereo PS output budget',async()=>{
  for(const [config,ch] of [[Buffer.from('eb8a0800','hex'),1],[asc(5,7,2),2]]){
    const {result}=await extract(fixture(false,config));const bytes=new Uint8Array(result.data);
    assert.equal((bytes[2]>>6)+1,2);assert.equal((bytes[2]>>2)&15,7);
    assert.equal(((bytes[2]&1)<<2)|(bytes[3]>>6),ch);assert.equal(result.channels,2);
    assert.equal(Buffer.from(bytes.subarray(7,14)).toString(),'aac-one');
  }
});
test('extended ASC rejects truncation, unsupported core, explicit rates and unsupported GASpecific flags',async()=>{
  for(const config of [Buffer.from('eb8a','hex'),asc(29,7,1,4,17),asc(5,7,2,15),asc(29,7,1,4,2,4),asc(29,7,0),asc(29,7,3)]){
    await assert.rejects(extract(fixture(false,config)),{code:'LOCAL_AAC_CONFIG_UNSUPPORTED'});
  }
});
test('speculative extraction rejects PCM/read budgets before fetching sample spans',async()=>{
  for(const limits of [{maxPCMBytes:1,maxReadBytes:1e8},{maxPCMBytes:1e8,maxReadBytes:1}]){
    await assert.rejects(extract(fixture(),{limits}),{code:'AUDIO_MEMORY_LIMIT'});
  }
});
