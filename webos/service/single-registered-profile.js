'use strict';
var sign = require('./passport-sign');
var crypto = require('crypto');
var networkDiagnostic = require('./network-diagnostic');
var UA = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
function query(d) {
  return {aid:'8662',app_name:'novelread',version_code:'73532',version_name:'7.3.5.32',manifest_version_code:'73532',update_version_code:'73532',channel:'update_64',device_platform:'android',os:'android',ssmix:'a',device_type:'25053RT47C',device_brand:'Redmi',language:'zh',os_api:'36',os_version:'16',resolution:'1280*2772',dpi:'520',ac:'wifi',device_id:d.deviceID || '',iid:d.installID || ''};
}
function uuid(){var b=crypto.randomBytes(16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;return b.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,"$1-$2-$3-$4-$5");}
function register(send) {
  var stamp=Date.now(), cdid=uuid(), clientudid=uuid();
  var h={display_name:'红果免费短剧',aid:8662,app_version:'7.3.5.32',version_code:73532,manifest_version_code:73532,update_version_code:73532,channel:'update_64',package:'com.phoenix.read',app_language:'zh',os:'Android',os_version:'16',os_api:36,device_model:'25053RT47C',device_brand:'Redmi',device_manufacturer:'Xiaomi',cpu_abi:'arm64-v8a',density_dpi:520,display_density:'xxhdpi',resolution:'2772x1280',language:'zh',timezone:8,access:'wifi',openudid:crypto.randomBytes(8).toString('hex'),clientudid:clientudid,cdid:cdid,region:'CN',tz_name:'Asia/Shanghai',tz_offset:28800,sim_region:'cn',device_platform:'android',not_request_sender:0,is_system_app:0,sdk_flavor:'china',rom:'OS2.0',rom_version:'BP2A.250605.031.A3'};
  var q=query({}); delete q.device_id;delete q.iid;q.req_id=uuid();q._rticket=String(stamp);
  var raw=Buffer.from(JSON.stringify({magic_tag:'ss_app_log',header:h,_gen_time:stamp}));
  var encoded=Object.keys(q).sort().map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(q[k]).replace(/\*/g,'%2A');}).join('&');
  return send('https://log.snssdk.com/service/2/device_register/?'+encoded,'POST',{'User-Agent':UA,Accept:'application/json','Content-Type':'application/json; charset=utf-8'},raw,65536).then(function(res){
    var error=new Error('匿名播放身份注册失败');error.code='ACCOUNT_DEVICE';error.status=res.status;
    if(res.status!==200)throw error;
    var p;try{p=JSON.parse(res.body.toString('utf8').replace(/("(?:device_id|install_id)"\s*:\s*)(\d{16,})/g,'$1"$2"'));}catch(ignored){throw error;}
    if(!p || typeof p!=='object' || Array.isArray(p))throw error;
    var d=String(p.device_id_str || p.device_id || ''),i=String(p.install_id_str || p.install_id || '');
    if(!/^[0-9]{1,32}$/.test(d)||!/[1-9]/.test(d)||!/^[0-9]{1,32}$/.test(i)||!/[1-9]/.test(i))throw error;
    return {deviceID:d,installID:i};
  }).catch(function(error){
    if(error.code==='ACCOUNT_DEVICE' || error.name==='AbortError')throw error;
    var failure=new Error('匿名播放身份注册失败');failure.code='ACCOUNT_DEVICE';failure.status=502;
    failure.stage='device_register';failure.network_reason=networkDiagnostic(error);throw failure;
  });
}
module.exports={ua:UA,query:query,register:register,sign:sign.signSingleRegistered,endpoint:'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/video_model/v1/'};
