'use strict';
var https=require('https'),url=require('url');
var CHANNEL='https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/announcements.json';
var ROUTES=['https://ghfast.top/',''];
function read(target){
 return new Promise(function(resolve,reject){
  var request,response,done=false,chunks=[],size=0;
  var timer=setTimeout(function(){finish(new Error('Announcement timeout'));if(request)request.destroy();},4000);
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);}
  try{
   var parsed=url.parse(target);
   request=https.get({hostname:parsed.hostname,path:parsed.path,port:443,headers:{Accept:'application/json','User-Agent':'HongguoTV-Announcements/1.0'}},function(res){
    response=res;if(res.statusCode!==200){res.resume();finish(new Error('Announcement HTTP'));return;}
    res.on('data',function(b){size+=b.length;if(size>131072){finish(new Error('Announcement size'));res.destroy();return;}chunks.push(b);});
    res.on('error',finish);res.on('end',function(){if(done)return;try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){finish(error);}});
   });request.on('error',finish);
  }catch(error){finish(error);}
 });
}
function before(current,limit){
 if(!current||!limit)return true;
 var a=String(current).replace(/^v/,'').split('-')[0].split('.'),b=String(limit).replace(/^v/,'').split('-')[0].split('.');
 for(var i=0;i<Math.max(a.length,b.length);i++){var x=Number(a[i]||0),y=Number(b[i]||0);if(!isFinite(x)||!isFinite(y))return true;if(x!==y)return x<y;}return false;
}
function normalize(document,now){
 if(!document||document.schema!==1||document.channel!=='stable'||!Array.isArray(document.items))throw new Error('Announcement schema');
 var seen={};return document.items.slice(0,100).filter(function(item){
  if(!item||item.enabled!==true||typeof item.id!=='string'||!item.id.trim()||!item.title||seen[item.id])return false;
  if(item.published_at&&(!isFinite(Date.parse(item.published_at))||Date.parse(item.published_at)>now))return false;
  if(item.expires_at&&(!isFinite(Date.parse(item.expires_at))||Date.parse(item.expires_at)<=now))return false;
  seen[item.id]=true;return true;
 }).map(function(item){
  var out={id:item.id,enabled:true,title:String(item.title),summary:String(item.summary||''),body:String(item.body||''),platforms:item.platforms,before_version:item.before_version,published_at:item.published_at,expires_at:item.expires_at,dismissible:item.dismissible!==false};
  if(item.action&&['check_update','repair_playback'].indexOf(item.action.type)>=0){out.action={type:item.action.type,label:String(item.action.label||'')};if(Number.isSafeInteger(item.action.min_revision)&&item.action.min_revision>0)out.action.min_revision=item.action.min_revision;}
  return out;
 }).sort(function(a,b){return String(b.published_at||'').localeCompare(String(a.published_at||''));});
}
module.exports=function(options){
 options=options||{};var fetch=options.read||read,now=options.now||Date.now,items=[],fetched=0,pending=null;
 function active(platform,version){
  function filtered(){return items.filter(function(item){return (!item.expires_at||Date.parse(item.expires_at)>now())&&(!Array.isArray(item.platforms)||!item.platforms.length||item.platforms.indexOf('all')>=0||item.platforms.indexOf(platform)>=0)&&before(version,item.before_version);}).slice(0,12);}
  if(fetched&&now()-fetched<300000)return Promise.resolve(filtered());
  if(!pending){
   var i=0;var next=function(){if(i>=ROUTES.length)return Promise.reject(new Error('Announcement unavailable'));return Promise.resolve().then(function(){return fetch(ROUTES[i++]+CHANNEL);}).then(function(data){return normalize(data,now());}).catch(next);};
   pending=next().then(function(value){items=value;fetched=now();pending=null;},function(){pending=null;});
  }
  return pending.then(filtered);
 }
 return {active:active};
};
module.exports.normalize=normalize;
