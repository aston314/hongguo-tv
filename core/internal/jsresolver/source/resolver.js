'use strict';
var device=require('./device-pure'),model=require('./model-pure'),v5=require('./mobile-playback-v5'),sign=require('./passport-sign'),crypto=require('crypto');
var identity=null,refreshAfter=0;
var fallbackUA='com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
function failure(stage,code){var e=new Error(code);e.code=code;e.stage=stage;throw e;}
function http(method,url,headers,body){return Promise.resolve().then(function(){return __resolverHost.http(method,url,headers,body||Buffer.alloc(0));});}
function registrationQuery(q){
  function encode(value){return encodeURIComponent(String(value)).replace(/[!'()*]/g,function(c){return '%'+c.charCodeAt(0).toString(16).toUpperCase();}).replace(/%20/g,'+');}
  return Object.keys(q).sort().map(function(key){return encode(key)+'='+encode(q[key]);}).join('&');
}
function register(){
  var d=device.device(),stamp=Date.now(),ts=Math.floor(stamp/1000),body=device.ttEncrypt(device.protocolDevicePayload(d,stamp),crypto.randomBytes(32));
  var q=device.appQuery({device:d});delete q.device_id;delete q.iid;q.tt_data='a';q.ts=String(ts);q._rticket=String(stamp);q.package='com.phoenix.read';
  var query=registrationQuery(q),headers={'User-Agent':device.ua,'Content-Type':'application/octet-stream;tt-data=a','Accept':'application/json; charset=utf-8,application/x-protobuf','Content-Encoding':'gzip','X-Tt-Request-Tag':'t=0;n=1','Log-Encode-Type':'gzip','Lc':'102','Sdk-Version':'2','Passport-Sdk-Version':'60755','Passport-Sdk-Settings':'device_transfer_s_0,device_transfer_ab_1','X-SS-DP':'8662','X-Vc-Bdturing-Sdk-Version':'4.0.3.cn','X-Tt-Store-Region':'cn','X-Tt-Store-Region-Src':'did','X-Khronos':String(ts),'X-Argus':device.le32(ts).toString('base64'),'X-SS-Req-Ticket':String(stamp),'X-SS-STUB':crypto.createHash('md5').update(body).digest('hex'),'X-Gorgon':sign.gorgon(query,body,ts,crypto.randomBytes(2).readUInt16LE(0))};
  return http('POST','https://log.snssdk.com/service/2/device_register/?'+query,headers,body).then(function(response){
  if(response.status!==200)failure('device_register','DEVICE_REGISTER_HTTP');
  var bytes=response.body;if(bytes.slice(0,6).equals(Buffer.from([0x74,0x63,5,0x10,0,0])))bytes=device.ttDecrypt(bytes);
  var root=device.parseExactJSON(bytes.toString('utf8')),did=device.str(root.device_id_str||root.device_id),iid=device.str(root.install_id_str||root.install_id);
  if(!device.validID(did)||!device.validID(iid)||did==='0'||iid==='0')failure('device_register','DEVICE_REGISTER_INVALID');
  return {deviceID:did,installID:iid,cdid:d.cdid};});
}
function options(m){
  var out=[];
  model.modelRows(m.video_list).forEach(function(row){
    var meta=row.video_meta||{},enc=row.encrypt_info||{},codec=String(row.codec_type||meta.codec_type||'');if(model.isByteVC2(codec))return;
    var backup=row.backup_url_list||[],raw=String(row.main_url||row.backup_url||backup[0]||''),url=model.modelURL(raw,m);if(!/^https:\/\//i.test(url))return;
    var key=null,spade=enc.spade_a||row.spade_a;if(spade){try{key=model.decodeSpade(spade);}catch(ignored){return;}}if(!key&&(row.encrypt===true||meta.encrypt===true))return;
    var width=Number(row.vwidth||row.width||meta.vwidth||meta.width)||0,height=Number(row.vheight||row.height||meta.vheight||meta.height)||0;
    var definition=String(row.quality_desc||row.definition||meta.definition||'').match(/(\d{3,4})/);if(definition)height=Number(definition[1]);
    out.push({URL:url,Key:key?key.toString('base64'):null,Codec:codec,Width:Math.floor(width),Height:Math.floor(height),Quality:height>0?height+'P':'',Duration:Math.floor(Number(m.video_duration)||0)});
  });return out;
}
function fallback(raw){
  return http('GET',raw,{'User-Agent':fallbackUA,'Accept':'application/json; charset=utf-8,application/x-protobuf'}).then(function(r){
  if(r.status!==200)failure('fallback_api','FALLBACK_API_HTTP');
  var root=model.parseExactJSON(r.body.toString('utf8'));if(model.businessCode(root)&&model.businessCode(root)!=='0')failure('fallback_api','FALLBACK_API_BUSINESS');
  var info=root.video_info;if(!info||typeof info!=='object')failure('fallback_api','FALLBACK_API_INVALID');
  if(model.businessCode(info)&&model.businessCode(info)!=='0')failure('fallback_api','FALLBACK_API_BUSINESS');
  if(!info.data||typeof info.data!=='object')failure('fallback_api','FALLBACK_API_INVALID');return info.data;});
}
function compatible(m){
  if(model.modelRows(m.video_list).length&&!model.onlyByteVC2(m))return Promise.resolve(m);
  var raw=model.fallbackAPI(m.fallback_api);if(!raw)return Promise.resolve(m);
  return fallback(raw).then(function(original){
    if(!model.sameFallbackVideo(m,original)){if(model.onlyByteVC2(m))return m;failure('fallback_api','FALLBACK_API_MISMATCH');}
    if(!model.onlyByteVC2(original))return original;
    var codecs=['codec_type=1','codec_type=0&force_codec=h264','codec_type=3'];
    function next(i){
      if(i>=codecs.length)return Promise.resolve(original);
      return fallback(model.fallbackCodecURL(raw,codecs[i])).then(function(candidate){
        if(model.sameFallbackVideo(m,candidate)&&model.sameFallbackVideo(original,candidate)&&options(candidate).length)return candidate;
        return next(i+1);
      },function(e){if(e.code==='FALLBACK_API_BUSINESS')throw e;return next(i+1);});
    }return next(0);
  },function(e){if(model.onlyByteVC2(m)&&e.code!=='FALLBACK_API_BUSINESS')return m;throw e;});
}
function getModel(request){
  var built=v5.build(request.vid,request.content_type,identity,Date.now());
  return http('POST',built.url,built.headers,built.body).then(function(r){
    if(r.status!==200)failure('multi_video_model','VIDEO_MODEL_HTTP');if(!r.body.toString('utf8').trim())failure('multi_video_model','VIDEO_MODEL_EMPTY');
    var root=model.parseExactJSON(r.body.toString('utf8'));if(model.businessCode(root)&&model.businessCode(root)!=='0')failure('multi_video_model','VIDEO_MODEL_BUSINESS');
    var entries=root.data||{};entries=entries[request.content_type]||entries;var entry=entries[request.vid];if(!entry||entry.video_model==null)failure('multi_video_model','VIDEO_MODEL_MISSING');
    var m=typeof entry.video_model==='string'?model.parseExactJSON(entry.video_model):entry.video_model;
    if(!m||typeof m!=='object')failure('multi_video_model','VIDEO_MODEL_MISSING');return compatible(m);
  }).then(function(m){var result=options(m);if(!result.length)failure('multi_video_model','VIDEO_MODEL_LIST_EMPTY');return result;});
}
// Promise-only ES5 syntax also works with the asynchronous webOS host. Goja's
// host returns completed bounded HTTP work; Node hosts may return a Promise.
function resolve(text){
  var request;
  return Promise.resolve().then(function(){
    request=JSON.parse(text);if(!/^[0-9]{1,32}$/.test(request.vid||''))failure('multi_video_model','INVALID_VIDEO_ID');
    if(['','default','auto','mpv_auto','software','mpv_software','standard'].indexOf(request.codec_mode||'')<0)failure('multi_video_model','INVALID_CODEC_MODE');
    request.content_type=request.content_type||'1004';if(!/^[0-9]{1,16}$/.test(request.content_type))failure('multi_video_model','INVALID_CONTENT_TYPE');
    if(!identity)return register().then(function(value){identity=value;});
  }).then(function(){
    return getModel(request).catch(function(e){
      if(e.code!=='VIDEO_MODEL_EMPTY'||Date.now()<refreshAfter)throw e;
      refreshAfter=Date.now()+30000;
      return register().then(function(value){identity=value;return getModel(request);});
    });
  }).then(function(result){return JSON.stringify({options:result});},function(e){
    return JSON.stringify({error_code:/^[A-Z0-9_]{1,64}$/.test(e.code||'')?e.code:'RESOLVER_SCRIPT_FAILED',error_stage:/^[a-z_]{1,40}$/.test(e.stage||'')?e.stage:'resolver_js'});
  });
}
function selfTest(text){
  var rows=JSON.parse(text),s=require('./playback-v5-sign'),q=v5.query({deviceID:'123',installID:'456',cdid:'synthetic'});
  for(var i=0;i<rows.length;i++){var r=rows[i],t=s.tune(q,Buffer.from(r.body,'hex'),r.ts*1000),med=s.medusa(q,r.ts,t.q,t.m,[0x80000000,0x80000000,0x80000000],{nonce:'synthetic',started:1800000000000});if(t.query!==r.query||med!==r.medusa||s.helios(r.ts,0x80000000)!==r.helios)return 0;}return rows.length;
}
module.exports={resolve:resolve,selfTest:selfTest,metadata:function(){return {name:'js-v5',version:'2026.11.20.2',protocol:1}},test:{device:device,model:model,options:options}};
