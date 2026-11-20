'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'core/internal/jsresolver/resolver.js'),'utf8');

// Keep Buffer compatibility patches private to this sandbox, not Node itself.
function sandboxBuffer(){
  function LocalBuffer(value){return LocalBuffer.from(value);}
  Object.setPrototypeOf(LocalBuffer,Buffer);
  LocalBuffer.prototype=Object.create(Buffer.prototype);
  Object.defineProperty(LocalBuffer.prototype,'constructor',{value:LocalBuffer});
  function wrap(b){Object.setPrototypeOf(b,LocalBuffer.prototype);return b;}
  LocalBuffer.from=function(){return wrap(Buffer.from.apply(Buffer,arguments));};
  LocalBuffer.alloc=function(){return wrap(Buffer.alloc.apply(Buffer,arguments));};
  LocalBuffer.concat=function(){return wrap(Buffer.concat.apply(Buffer,arguments));};
  return LocalBuffer;
}
function create(http,options){
  const host={random:n=>crypto.randomBytes(n),hash:(name,b)=>{if(options&&options.noNativeSM3&&name==='sm3')throw Error('unsupported hash');return crypto.createHash(name).update(b).digest();},
    gzip:(b,level)=>zlib.gzipSync(b,{level}),gunzip:b=>zlib.gunzipSync(b),http,
    cipher:(name,key,iv,data,decrypt,padding)=>{const c=(decrypt?crypto.createDecipheriv:crypto.createCipheriv)(name,key,iv);c.setAutoPadding(padding);return Buffer.concat([c.update(data),c.final()]);}};
  return vm.runInNewContext(source,{Buffer:sandboxBuffer(),__resolverHost:host},{timeout:3000});
}
test('same script passes independent vectors with the Node byte host',()=>{
  const slice=Buffer.prototype.slice;
  const api=create(()=>{throw Error('unexpected network');});
  const vectors=fs.readFileSync(path.join(root,'core/internal/playbackresolver/testdata/signing-v5-wire.json'),'utf8');
  assert.equal(api.selfTest(vectors),4);
  assert.equal(Buffer.prototype.slice,slice,'sandbox modified the host Buffer prototype');
});
test('older hosts retain the pure-JS SM3 path with identical signatures',()=>{
  const api=create(()=>{throw Error('unexpected network');},{noNativeSM3:true});
  assert.equal(api.metadata().native_sm3,false);
  const vectors=fs.readFileSync(path.join(root,'core/internal/playbackresolver/testdata/signing-v5-wire.json'),'utf8');
  assert.equal(api.selfTest(vectors),4);
});
test('same script supports asynchronous HTTP, refresh and compatible fallback',async()=>{
  let registrations=0,models=0;const codecs=[];
  const model=codec=>({video_id:'123',video_duration:90.5,video_list:{q:{codec_type:codec,vwidth:1920,vheight:1080,definition:'1080P',main_url:'https://cdn.example/episode.mp4'}}});
  const api=create((method,target,headers,body)=>new Promise(resolve=>setImmediate(()=>{
    const u=new URL(target);let value;
    if(u.pathname==='/service/2/device_register/'){
      registrations++;assert.ok(headers['X-Gorgon']);assert.equal(body[0],0x74);
      // Numeric identities exceed JS's safe integer range; their digits survive.
      resolve({status:200,body:Buffer.from('{"device_id":7390000000000000001,"install_id":7390000000000000002}')});return;
    }
    if(u.pathname==='/fallback'){
      codecs.push(u.searchParams.get('codec_type'));
      value={code:0,video_info:{code:0,data:model(codecs.at(-1)==='1'?'h265':'bytevc2')}};
    }else{
      models++;assert.ok(headers['X-Medusa']);assert.equal(u.searchParams.get('device_id'),'7390000000000000001');
      assert.equal(headers['X-SS-STUB'],crypto.createHash('md5').update(body).digest('hex').toUpperCase());
      if(models===1){resolve({status:200,body:Buffer.alloc(0)});return;}
      const m=model('bytevc2');m.fallback_api='https://api.fqnovel.com/fallback?signed=a%2Fb&codec_type=4';value={code:0,data:{'123':{video_model:m}}};
    }
    resolve({status:200,body:Buffer.from(JSON.stringify(value))});
  })));
  const result=JSON.parse(await api.resolve(JSON.stringify({vid:'123'})));
  assert.equal(result.options[0].Codec,'h265');assert.equal(result.options[0].Duration,90);
  assert.equal(registrations,2);assert.equal(models,2);assert.deepEqual(codecs,['4','1']);
});
