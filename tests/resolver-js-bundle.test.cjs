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
test('official GET uses activated exact identity, complete query and no body headers; identity survives episode switches',async()=>{
  const calls=[];
  const api=create((method,target,headers,body,timeout)=>{
    const u=new URL(target);calls.push(u.pathname);
    if(u.pathname==='/service/2/device_register/'){
      assert.equal(u.hostname,'log5-applog-lf.fqnovel.com');
      assert.equal(u.searchParams.get('cronet_version'),'8d40f833_2026-03-03');
      const payload=JSON.parse(api.test.device.ttDecrypt(body).toString('utf8'));
      assert.equal(payload.header.device_model,'25053RT47C');
      assert.equal(payload.header.channel,'update_64');
      assert.equal(payload.header.cdid.length,36);
      return {status:200,body:Buffer.from('{"device_id":7390000000000000001,"install_id":7390000000000000002,"data":{"klink_egdi":"synthetic+token"}}'),cookies:{sessionid:'must-not-leak'}};
    }
    assert.equal(u.searchParams.get('device_id'),'7390000000000000001');
    assert.equal(u.searchParams.get('iid'),'7390000000000000002');
    assert.equal(headers.Cookie,undefined);
    if(u.pathname==='/service/2/app_alert_check/'){
      assert.equal(timeout,3000);assert.equal(method,'GET');
      return {status:503,body:Buffer.alloc(0)}; // Best-effort activation cannot block an otherwise valid GET.
    }
    assert.equal(u.pathname,'/reading/bookapi/video_tab/multi_video_model/v1/');
    for(const [key,value] of Object.entries({resolution:'1920*1080',os_api:'31',host_abi:'arm64-v8a',rom_version:'V417IR+release-keys',klink_egdi:'synthetic+token'}))assert.equal(u.searchParams.get(key),value);
    assert.match(u.search,/resolution=1920\*1080/);
    for(const key of ['X-Khronos','X-Medusa','X-Helios'])assert.ok(headers[key]);
    for(const key of ['X-SS-STUB','Content-Type','Content-Encoding'])assert.equal(headers[key],undefined);
    assert.equal(body.length,0);
    const id=u.searchParams.get('video_id');
    return {status:200,body:Buffer.from(JSON.stringify({code:0,data:{video_model_data:{[id]:{video_model:{video_id:'cdn-'+id,video_duration:90,video_list:{q:{codec_type:'h265',definition:'1080P',vwidth:1920,vheight:1080,main_url:'https://cdn.example/'+id+'.mp4'}}}}}}}))};
  });
  for(const vid of ['123','124','123'])assert.equal(JSON.parse(await api.resolve(JSON.stringify({vid}))).options[0].Quality,'1080P');
  assert.deepEqual(calls,['/service/2/device_register/','/service/2/app_alert_check/',...Array(3).fill('/reading/bookapi/video_tab/multi_video_model/v1/')]);
});
test('official Kotlin vectors cover all carrier branches and gate activation on the new envelope',()=>{
  const api=create(()=>{throw Error('unexpected network');});
  assert.equal(api.test.official.selfTest(),true);
  const badSource=source.replace("sint(p, 21, 312);", "sint(p, 21, 313);");
  assert.notEqual(badSource,source);
  const bad=vm.runInNewContext(badSource,{Buffer:sandboxBuffer(),__resolverHost:{
    random:n=>crypto.randomBytes(n),hash:(n,b)=>crypto.createHash(n).update(b).digest()
  }});
  const vectors=fs.readFileSync(path.join(root,'core/internal/jsresolver/testdata/signing-v5-wire.json'),'utf8');
  assert.equal(bad.selfTest(vectors),0,'new signature corruption must fail installed clients\' four-vector contract');
});
test('malformed anonymous registration is an upstream error, without leaking its response',async()=>{
  const api=create(()=>{throw Error('unexpected network');});
  for(const text of ['<html>private upstream detail</html>','null','[]','{}','{"device_id":0,"install_id":0}']){
    await assert.rejects(api.test.official.register(()=>Promise.resolve({status:200,body:Buffer.from(text)})),e=>e.code==='DEVICE_REGISTER_INVALID'&&e.stage==='device_register'&&!e.message.includes('private'));
  }
});
test('same script supports asynchronous HTTP, alternate V5 host and compatible fallback',async()=>{
  let registrations=0,models=0;const codecs=[];
  const model=codec=>({video_id:'123',video_duration:90.5,video_list:{q:{codec_type:codec,vwidth:1920,vheight:1080,definition:'1080P',main_url:'https://cdn.example/episode.mp4'}}});
  const api=create((method,target,headers,body)=>new Promise(resolve=>setImmediate(()=>{
    const u=new URL(target);let value;
    if(u.pathname==='/service/2/device_register/'){
      registrations++;assert.ok(headers['X-Gorgon']||headers['x-neptune']);assert.equal(body[0],0x74);
      // Numeric identities exceed JS's safe integer range; their digits survive.
      resolve({status:200,body:Buffer.from('{"device_id":7390000000000000001,"install_id":7390000000000000002}')});return;
    }
    if(u.pathname==='/service/2/app_alert_check/') { resolve({status:200,body:Buffer.from('{}')});return; }
    if(u.pathname==='/reading/bookapi/video_tab/multi_video_model/v1/') { resolve({status:200,body:Buffer.alloc(0)});return; }
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
