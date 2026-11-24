'use strict';
// Disposable, loopback-only signed fixtures for the isolated APK. Private key
// stays outside the repo/APK. ADB reverse supplies transport; no resolver runs here.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path');
const keyPath=process.argv[2];
if(!keyPath)throw Error('Usage: node scripts/resolver_js_update_lab.cjs /private/path/private.pem');
const key=crypto.createPrivateKey(fs.readFileSync(keyPath));
const expected=fs.readFileSync('core/internal/jsupdatelab/publickey.txt','utf8').trim();
if(crypto.createPublicKey(key).export({type:'spki',format:'der'}).subarray(-32).toString('hex')!==expected)throw Error('lab key does not match isolated APK');
const source=fs.readFileSync('core/internal/jsresolver/resolver.js','utf8');
const origin='http://127.0.0.1:18872';
let selected={mode:'offline',revision:0},env=null,script=null,records=[],saved=new Map();
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function configure(c){
 if(c.mode==='replay') {const old=saved.get(c.revision);if(!old)throw Error('unknown revision');({selected,env,script}=old);return;}
 if(!['good','bad_signature','corrupt','truncated','syntax','infinite','broken_abi','upstream_empty','disable','offline','slow'].includes(c.mode))throw Error('invalid mode');
 if(!Number.isSafeInteger(c.revision)||c.revision<1)throw Error('invalid revision');
 selected={mode:c.mode,revision:c.revision,delay_ms:c.delay_ms||0};
 const version='2026.11.24.'+c.revision;
 let text=source.replaceAll('2026.11.24.1',version);
 if(c.mode==='syntax')text='invalid syntax ! ;';
 if(c.mode==='infinite')text=text.replace('selfTest:selfTest,','selfTest:function(){for(;;){}},');
 if(c.mode==='broken_abi')text=text.replace('resolve:resolve,',"resolve:function(){return 'invalid ABI'},");
 if(c.mode==='upstream_empty')text=text.replace('resolve:resolve,',"resolve:function(){return JSON.stringify({error_code:'VIDEO_MODEL_EMPTY',error_stage:'video_tab'})},");
 script=Buffer.from(text);
 const now=Math.floor(Date.now()/1000),enabled=c.mode!=='disable';
 const payload=JSON.stringify({schema:1,product:'hongguo-js-resolver-experiment',revision:c.revision,enabled,issued_at:now-60,expires_at:now+86400,module:enabled?{version,protocol:1,host_api:1,url:origin+'/resolver.js',size:script.length,sha256:sha(script)}:null});
 env={payload:Buffer.from(payload).toString('base64'),signature:crypto.sign(null,Buffer.from(payload),key).toString('base64')};
 if(c.mode==='bad_signature')env.signature=Buffer.alloc(64).toString('base64');
 saved.set(c.revision,{selected:{...selected},env:{...env},script});
}
http.createServer(async(req,res)=>{
 try{
  if(req.url==='/control'&&req.method==='POST'){
   let data='';for await(const c of req){data+=c;if(data.length>4096)throw Error('oversize');}
   configure(JSON.parse(data));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(selected));return;
  }
  if(req.url==='/records'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(records));return;}
  if(req.url!=='/manifest.json'&&req.url!=='/resolver.js'){res.writeHead(404);res.end();return;}
  const current={...selected};records.push({time:new Date().toISOString(),path:req.url,mode:current.mode,revision:current.revision});if(records.length>500)records.shift();
  res.setHeader('Cache-Control','no-store');
  if(current.mode==='offline'||!env){res.writeHead(503);res.end('lab offline');return;}
  if(req.url==='/manifest.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(env));return;}
  const bytes=current.mode==='corrupt'?Buffer.alloc(script.length):script;
  res.setHeader('Content-Type','application/javascript');res.setHeader('Content-Length',bytes.length);
  if(current.mode==='truncated'){res.write(bytes.subarray(0,bytes.length/2));res.destroy();return;}
  if(current.mode==='slow'){
   res.write(bytes.subarray(0,1024));const timer=setTimeout(()=>res.end(bytes.subarray(1024)),current.delay_ms||15000);res.on('close',()=>clearTimeout(timer));return;
  }
  res.end(bytes);
 }catch(e){res.writeHead(400);res.end('invalid lab request');}
}).listen(18872,'127.0.0.1',()=>console.log('Signed JS update fixtures ready on loopback:18872 (initially offline)'));
