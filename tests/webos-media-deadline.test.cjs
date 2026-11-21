'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const media=require('../webos/service/range-media'),cancel=require('../webos/service/audio-cancel');
async function fixture(t,handler){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hongguo-media-deadline-'));
 const sockets=new Set();const server=http.createServer(handler);server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});});
 return {url:'http://127.0.0.1:'+server.address().port,file:path.join(directory,'media.part')};
}
test('full download has a total deadline even while upstream continually drips data',async t=>{
 const f=await fixture(t,(req,res)=>{res.writeHead(200);const timer=setInterval(()=>res.write(Buffer.alloc(32)),5);res.on('close',()=>clearInterval(timer));});
 const start=Date.now();await assert.rejects(media.downloadFile(f.url,f.file,{},1e6,null,{totalTimeoutMs:120,idleTimeoutMs:1000}),{code:'MEDIA_DOWNLOAD_TIMEOUT'});
 assert(Date.now()-start<1000);fs.rmSync(f.file,{force:true});
});
test('download cancellation closes the redirected HTTP response and releases its file before rejecting',async t=>{
 let received;const reached=new Promise(r=>received=r);let closed;const disconnected=new Promise(r=>closed=r);
 const f=await fixture(t,(req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'/media'});res.end();return;}res.writeHead(200);res.write(Buffer.alloc(1024));req.on('close',closed);received();});
 const c=cancel.create(),result=media.downloadFile(f.url+'/redirect',f.file,{},1e6,null,{signal:c.signal});
 const rejected=assert.rejects(result,{code:'WEBOS_AUDIO_CANCELLED'});await reached;c.abort();await rejected;await disconnected;
 fs.rmSync(f.file,{force:true});await media.downloadFile(f.url+'/redirect',f.file,{},1e6,null,{signal:alreadyAborted()}).catch(e=>assert.equal(e.code,'WEBOS_AUDIO_CANCELLED'));
});
function alreadyAborted(){const c=cancel.create();c.abort();return c.signal;}
test('Range initialization is abortable and does not wait for its socket timeout',async t=>{
 let received;const reached=new Promise(r=>received=r);const f=await fixture(t,()=>received());
 const c=cancel.create(),result=media.open(f.url,Buffer.alloc(16),{}, {signal:c.signal});
 const rejected=assert.rejects(result,{code:'WEBOS_AUDIO_CANCELLED'});await reached;c.abort();await rejected;
});
test('Range initialization deadline includes redirects and a continuously active socket',async t=>{
 const f=await fixture(t,(req,res)=>{
  if(req.url==='/redirect'){setTimeout(()=>{res.writeHead(302,{Location:'/media'});res.end();},35);return;}
  res.writeHead(206,{'Content-Range':'bytes 0-65535/100000',ETag:'"stable"'});
  const timer=setInterval(()=>res.write(Buffer.alloc(10)),5);res.on('close',()=>clearInterval(timer));
 });
 const start=Date.now();await assert.rejects(media.open(f.url+'/redirect',Buffer.alloc(16),{}, {timeout:1000,totalTimeoutMs:100}),{code:'RANGE_TIMEOUT'});
 assert(Date.now()-start<1000);
});
test('an interrupted full response rejects instead of accepting a partial cache file',async t=>{
 const f=await fixture(t,(req,res)=>{res.writeHead(200,{'Content-Length':10000});res.write(Buffer.alloc(128));setTimeout(()=>res.destroy(),10);});
 await assert.rejects(media.downloadFile(f.url,f.file),{code:'MEDIA_DOWNLOAD_INTERRUPTED'});
});

test('closing the local media response cancels its actual upstream Range read',async t=>{
 let reached,closed;const upstreamReached=new Promise(r=>reached=r),upstreamClosed=new Promise(r=>closed=r);
 const upstream=await fixture(t,(req,res)=>{req.on('close',closed);reached();});
 const source={url:upstream.url,etag:'"fixture"',length:1000,prefix:Buffer.alloc(16),samples:[],key:Buffer.alloc(16)};
 const proxy=http.createServer((req,res)=>media.serve(req,res,source));await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>proxy.close(r)));
 const request=http.get('http://127.0.0.1:'+proxy.address().port,()=>{});request.on('error',()=>{});
 await upstreamReached;request.destroy();await upstreamClosed;
});
