'use strict';
require('./runtime-compat');
var https=require('https'),url=require('url'),zlib=require('zlib'),tlsOptions=require('./upstream-tls');
var verify=require('./playback-rule-verifier'),fault=verify.fault;
var PROXIES=['https://gh-proxy.com/','https://v4.gh-proxy.org/','https://gh-proxy.org/','https://ghfast.top/',''];
function upstream(raw) {
  if(typeof raw!=='string'||raw.length>8192)return false;
  var u=url.parse(raw),h=String(u.hostname||'').toLowerCase().replace(/\.$/,'');
  return u.protocol==='https:'&&!u.auth&&!u.hash&&(!u.port||u.port==='443')&&/^(?:[a-z0-9-]+\.)*(?:fqnovel|snssdk)\.com$/.test(h);
}
function cookie(value) {return typeof value==='string'&&value.length<=4096&&value.split(';').every(function(part){return /^(install_id|ttreq|store-region|store-region-src)=[^\r\n;=][^\r\n;]*$/.test(part.trim());});}
function read(input,signal,timeout,limit) {
 return new Promise(function(resolve,reject){
  var request,response,stream,done=false,chunks=[],size=0;
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);if(signal)signal.removeEventListener('abort',aborted);if(error){if(request)request.destroy();if(response)response.destroy();if(stream&&stream!==response)stream.destroy();reject(error);}else resolve(value);}
  function aborted(){finish(fault('RESOLVER_CANCELLED'));}
  var timer=setTimeout(function(){finish(fault('UPSTREAM_TIMEOUT'));},timeout);
  if(signal&&signal.aborted){aborted();return;}if(signal)signal.addEventListener('abort',aborted);
  try{
   var p=url.parse(input.url),opts={protocol:'https:',hostname:p.hostname,port:p.port||443,path:p.path,method:input.method,headers:input.headers||{},rejectUnauthorized:true};
   request=https.request(tlsOptions(opts),function(res){
    response=res;stream=res;
    if(/^[Gg][Zz][Ii][Pp]$/.test(res.headers['content-encoding']||'')){stream=zlib.createGunzip();res.pipe(stream);}
    var wireSize=0;res.on('data',function(b){wireSize+=b.length;if(wireSize>limit)finish(fault('RULE_RESPONSE_TOO_LARGE'));});
    stream.on('data',function(b){size+=b.length;if(size>limit){finish(fault('RULE_RESPONSE_TOO_LARGE'));return;}chunks.push(b);});
    res.on('error',function(){finish(fault('RULE_NETWORK_FAILED'));});if(stream!==res)stream.on('error',function(){finish(fault('RULE_NETWORK_FAILED'));});
    stream.on('end',function(){
     var cookies={};if(p.pathname==='/service/2/device_register/') (res.headers['set-cookie']||[]).forEach(function(line){var pair=String(line).split(';')[0],at=pair.indexOf('='),k=pair.slice(0,at),v=pair.slice(at+1);if(['install_id','ttreq','store-region','store-region-src'].indexOf(k)>=0&&v.length<=1024)cookies[k]=v;});
     finish(null,{status:res.statusCode,body:Buffer.concat(chunks),cookies:cookies,retry_after:!!res.headers['retry-after'],location:String(res.headers.location||'').slice(0,8192)});
    });
   });request.on('error',function(){finish(fault('RULE_NETWORK_FAILED'));});if(input.body&&input.body.length)request.write(input.body);request.end();
  }catch(ignored){finish(fault('RULE_NETWORK_FAILED'));}
 });
}
function http(input,signal,timeout) {
 if(!input||!upstream(input.url)||['GET','POST'].indexOf(input.method)<0||!input.headers||typeof input.headers!=='object'||Object.keys(input.headers).length>32)return Promise.reject(fault('RULE_HTTP_REJECTED'));
 var headers=Object.create(null),bad=false;
 Object.keys(input.headers).forEach(function(k){var v=input.headers[k],key=k.trim().toLowerCase();if(typeof v!=='string'||v.length>4096||/[\r\n]/.test(k+v)||!k.trim()||['authorization','set-cookie'].indexOf(key)>=0||key==='cookie'&&(!cookie(v)||!/^\/.*\/v1\/$/.test(url.parse(input.url).pathname)))bad=true;headers[k]=v;});
 var body;try{body=Buffer.from(input.body||'','base64');}catch(ignored){bad=true;}
 if(bad||body.length>16384||!Number.isSafeInteger(timeout)||timeout<1||timeout>8000)return Promise.reject(fault('RULE_HTTP_REJECTED'));
 return read({url:input.url,method:input.method,headers:headers,body:body},signal,timeout,5242880);
}
function fetchRule(raw,limit,accept,signal) {
 if(!verify.official(raw))return Promise.reject(fault('RULE_URL_REJECTED'));
 var i=0;
 function next(){if(signal&&signal.aborted)return Promise.reject(fault('RESOLVER_CANCELLED'));if(i>=PROXIES.length)return Promise.reject(fault('RULE_UPDATE_UNAVAILABLE'));
  return read({url:PROXIES[i++]+raw,method:'GET',headers:{Accept:'application/octet-stream','Cache-Control':'no-cache'}},signal,4000,limit).then(function(r){if(r.status!==200)throw fault('RULE_DOWNLOAD_FAILED');accept(r.body);return r.body;}).catch(next);
 }return next();
}
module.exports={http:http,fetch:fetchRule,upstream:upstream,cookie:cookie};
