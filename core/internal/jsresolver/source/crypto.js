'use strict';
// Only generic byte primitives cross into Go. No native registration/signer/model API.
function createHash(name) {
  var chunks=[];
  return {update:function(data){chunks.push(Buffer.from(data));return this;},digest:function(enc){var b=__resolverHost.hash(name,Buffer.concat(chunks));chunks=[];return enc?b.toString(enc):b;}};
}
function cipher(name,key,iv,decrypt) {
  var chunks=[],padding=true;
  return {setAutoPadding:function(value){padding=!!value;return this;},update:function(data){chunks.push(Buffer.from(data));return Buffer.alloc(0);},final:function(){var out=__resolverHost.cipher(name,key,iv,Buffer.concat(chunks),decrypt,padding);chunks=[];return out;}};
}
module.exports={createHash:createHash,randomBytes:function(n){return __resolverHost.random(n);},createCipheriv:function(n,k,i){return cipher(n,k,i,false);},createDecipheriv:function(n,k,i){return cipher(n,k,i,true);}};
