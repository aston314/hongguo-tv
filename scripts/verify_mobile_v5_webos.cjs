'use strict';
// Explicit live check: use the production webOS resolver, complete media
// download/decryption and FFmpeg decoding. Never print upstream URLs or keys.
if (process.env.HONGGUO_LIVE_MOBILE_V5 !== '1') {
  console.log('webOS mobile-v5 live verification: skipped (opt-in)');
  process.exit(0);
}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'hongguo-v5-webos-live-'));
process.env.HONGGUO_WEBOS_CACHE_DIR = root;
process.env.HONGGUO_WEBOS_DATA_DIR = root;
const mobile = require('../webos/service/mobile-playback-v5');
const normalize = mobile.normalize;
let v5Calls = 0, onlyByteVC2 = false;
mobile.normalize = function(envelope,vid,type) {
  v5Calls++;
  const value = normalize(envelope,vid,type);
  let model = value.data[vid] && value.data[vid].video_model;
  if(typeof model === 'string') {try{model=JSON.parse(model);}catch(_){model={};}}
  let list = model && model.video_list || [];
  if(!Array.isArray(list))list=Object.values(list);
  onlyByteVC2=list.length>0 && list.every(v=>/^(bytevc2|bvc2)$/i.test(v.codec_type || v.video_meta && v.video_meta.codec_type || ''));
  return value;
};
const provider = require('../webos/service/provider');
const vids=(process.env.HONGGUO_LIVE_MINIREEL_VIDEO_ID || '7706514645208534041,7702841946812714008,7702841953875938328,7703473857562151961').split(',');
(async()=>{
 try {
  for(const vid of vids) {
   const previous=v5Calls, started=Date.now();onlyByteVC2=false;
   const r=await provider.prepare('123',vid,'1080P',false,'full',false,null,'1004');
   if(v5Calls===previous)throw Error('V5_NOT_USED');
   const token=path.basename(r.path,'.mp4'),file=path.join(root,token,token+'.mp4');
   const p=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height:format=duration,size','-of','json',file],{timeout:15000,maxBuffer:1048576}));
   const video=p.streams.find(s=>s.codec_type==='video');
   if(!video || video.codec_name!=='hevc' || !p.streams.some(s=>s.codec_type==='audio'))throw Error('MEDIA_CODEC_MISMATCH');
   const output=execFileSync('ffmpeg',['-nostdin','-v','error','-xerror','-i',file,'-map','0:v:0','-map','0:a:0?','-f','null','-'],{timeout:90000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']});
   if(output.length)throw Error('DECODE_OUTPUT');
   console.log(JSON.stringify({vid,only_bytevc2:onlyByteVC2,codec:video.codec_name,width:video.width,height:video.height,bytes:p.format.size,duration:p.format.duration,prepare_ms:Date.now()-started,full_decode:true}));
  }
 } catch(e) {
  console.error(JSON.stringify({result:'FAIL',code:e.code || 'LIVE_MEDIA_FAILED',stage:e.stage || ''}));process.exitCode=1;
 } finally {provider.closeCache();fs.rmSync(root,{recursive:true,force:true});}
})();
