'use strict';
// This probe also runs under actual Node 0.12/8; keep ES5 syntax.
var assert=require('assert'),fs=require('fs'),path=require('path');
var root=path.resolve(__dirname,'../..');require(path.join(root,'webos/service/runtime-compat'));
var profile=require(path.join(root,'webos/service/playback-profile'));
var baseline=fs.readFileSync(path.join(root,'webos/service/playback-profile.json'));
var p=profile.parse(baseline),rows=JSON.parse(fs.readFileSync(path.join(root,'core/internal/jsresolver/testdata/signing-v5-official.json')));
rows.forEach(function(row){
 var stamp=row.stamp||row.ts*1000,values={};
 row.query.split('&_rticket=')[0].split('&').forEach(function(part){var k=part.split('=')[0];values[k]=row.values[k];});
 var got=p.sign(values,Buffer.alloc(0),stamp,[2147483648,2147483648,2147483648,2147483648],{nonce:'synthetic',started:1800000000000,now:1800000000000,launch:110,pid:11001});
 assert.strictEqual(got.query,row.query);assert.strictEqual(got.headers['X-Medusa'],row.medusa);assert.strictEqual(got.headers['X-Helios'],row.helios);
});
function rejected(edit){var value=JSON.parse(baseline);edit(value);assert.throws(function(){profile.parse(JSON.stringify(value));});}
rejected(function(v){v.v5.medusa.message[0].value='${ts}';});
rejected(function(v){v.v5.medusa.device[0].value='${env}';});
rejected(function(v){v.v5.gates.model.host='evil.example';});
rejected(function(v){var f=[];for(var i=1;i<=96;i++)f.push({tag:i,type:'string',value:new Array(2049).join('a')});v.v5.medusa.device=f;});
rejected(function(v){v.v5.medusa.message[0]={tag:1,type:'sint',value:9007199254740991};});
assert.throws(function(){profile.parse('{"schema":1,'+baseline.toString().slice(1));});
var body=JSON.parse(p.body('7704857946630409240','1003'));assert.strictEqual(body.mixed_video_id_map['1003'][0],'7704857946630409240');
console.log('Native JSON profile '+process.version+': independent Kotlin vectors, precise ID, strict types and hosts PASS');
