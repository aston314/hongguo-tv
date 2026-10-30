(function () {
  'use strict';

  var crypto = require('crypto');
  var SBOX = Buffer.from('fa7d086b9c59b34b045f39d0384a91990067a6209ff54d827326eedf18668333800319fbd9feaeaaa9b052c60bf379254e78b436ac5d1a279e88dbbd3c63ec4915c1301fdcb856d46ccdca0943c835a3ef1ef496d2fc0e727b9484d1ea455a62023fd31281342bdd7ee628f2a54613013b21f66137292a0ded8cafbf9d5cbb24760f75e45389e1988db19a65704f544c58ab6e6f8b23c407110cbacfa0a48ed8053d14b2da74c3d7e7bed67fde48163e8590a155b7774222c986502e17f964312c9bf16d1c4468e3e9a89397cb3257ebe5716aadc0ccc7c5fd601da22d47a7e251695e7ace0a41b6958ff7b987e03a06108ab5f85bd5f0bc92ff7c2fc2e81b40ec1bdabdba98910cb22b83413467fb0ad876b546055961237590872ae350154cacb179ebaee595470468f0863d518b0fca8ee4b94ef21282bc0ed5f7ef2825cf5b5de96a5502e133be93e7f5ad9d3e3924a8e2fa1757d07a0d0830d6b8a38dfd079ac41e6e226497d21db0bf45663f6cdddb2780a711dca6c552f8c0b6c85c0073607ba01913aac935484bd3a4cd9f99f3104440547e29f4061fa2aba12f3cf6af856236217f5edf201ab3b4e6ff72848f6526945a77ea4378c74acc2c146bc6e87453fcd41cce317003188c96383289f13a5fd7f9a969b7633758c23bc371cb9e92018a0b4d889bbb4f6d6fe0fea549de561609ed9cc12dee817dd97cd12e425b4dc1a65dea44fd454e1ba13fd189e17d2faadbabad59cbb1ce9a28c9e0f670394ad7ff30f5ddbc573b118db2ee00b6e61a5a7cf9dec4cd2e80bbb94ca59f8408c66f426cf027e78b3a9c51fb6721754131a7ca20432ab7bfd97af2b5f88c2c23834f8f60a004133714e301c563665c7481df58bd68903dd2b334f419933229d649ae0d4bd8079eac1e2d0b40b872ba761071a8e4561d48fee5c24791da87269d1f886bc098be25099733a385165e7fdc6e54e9f7a9c8e8c377d0822bec02628a920e3eb00f05f3f19678388636183c24cf0ab453cc6165a4c794d5157e6def792235126a8e5206557b46645095e20cedd31703a29b99eb1cfcafd47369fa5ff72c1ebfc8e1f39f76807148aa94ad64fb89c660c332b34dd2e044dd5fa8b1c7682334c96d127fb7eb15bea9d17893a00c92a4d747e38ac270ab26419a79a7d814858fc06f56d08c11b92e3ce29dcf0ede035d463ecd38430f335ad91a656c223bfc30a688ea37a2b48d8e519cd640eef9f884f4ae97e9ca0a456757042f835cd5c5c482b6a391981f4aac96816ecb1b0908af1895497d54edfa16313adab866f5a5f1fe10010674cc63df7c2825f6ceb24f8be5bc8769bb8621070036e70b50599b1ce862581961f2bd275eba1de699423d0d2ab5dc5b29f02d4c537b6a734e3f75ff4ba1351755723920d3b0fdef02ec777ee42bdb90c1059e7ad4526b2413', 'hex');
  var ORDERS = Buffer.from('0f0704000908030a060b050d0e010c020f05080c0009020103070e060b0a0d04060500070c000a04080f010b0d09020e060b02050403080101070a000d0c090e0d070e0f0b0208030c0509010004060a0d0902060f0b0a040807000c0503010e0c090f07060f030e020d0405010b0a000c050a090e0802040407030f01060b000b0f0408020a0700090d06010e03050c0b060a0508020c03070f0e090d0001040906080f050800040a0b030d01020c0e090d0c0604070a03030f00080105020e01000d0f090a0b0e0402080703060c0501080a0c0f0905060b000304020e070d04080f000c0f0e0d0a01060207090503040205080d0b0a0606000e0f070c09030a08040f000b01060d0c0709030e05020a070b050f00020e0108030d0c0609040d070f08050f06040b0a0e0c090002030d0c020704010b0e0e08060f09050003', 'hex');
  var MD5C = [0xa7aefe20,0x7149f1d6,0x47e4ca07,0xe9b58f67,0x93b924de,0xc614d0f5,0x38afe0ef,0xb2bbad73,0xe24444c3,0x9d3aec9b,0xdf7b37e4,0xd8b16d40,0xf8ac31b8,0x76b9a90b,0x31d833ee,0x953fce64,0x353595a4,0x4609c13b,0x36925008,0x8c6d0925,0x5df5c177,0x1cfbf52b,0x8a4fa7f0,0x114ca35e,0x8193f984,0x7a7a8733,0x316ab4d5,0x3c20cfc9,0xa6d84453,0x3a18500c,0x798ec47a,0x97a76b28,0x66c4ff96,0x51716443,0x0dd2fc3b,0xb5696da7,0xbbeb3ac5,0x5c53d204,0xd32608ce,0x7279b9ec,0xf4188ecf,0xf7d793db,0x332cc491,0xab76ae15,0x9bebe727,0x18a01384,0x5be9f8a7,0x5f90a754,0x39b663c0,0x36673c83,0x7c92f514,0x9d7d94d7,0xe2e8d9aa,0x5f7e9ea9,0x7abd4551,0x569e05da,0x40a25632,0x3df5a9a5,0xbab37d80,0x454286dc,0x3f5d4e78,0x03d7b75d,0xb1fe4af7,0xa5ab26a3];

  function u32(n) { return n >>> 0; }
  function rol32(x, n) { n &= 31; return n ? ((x << n) | (x >>> (32 - n))) >>> 0 : x >>> 0; }
  function rol8(x, n) { n &= 7; return n ? ((x << n) | (x >>> (8 - n))) & 255 : x & 255; }
  function reverse8(x) { x = x & 255; var y = 0; for (var i = 0; i < 8; i++) y |= ((x >>> i) & 1) << (7 - i); return y; }
  function le32(n) { var b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
  function md5(data) { return crypto.createHash('md5').update(data).digest(); }
  function sm3(data) {
    var bitLength = data.length * 8, padded = Buffer.concat([data, Buffer.from([0x80])]);
    while (padded.length % 64 !== 56) padded = Buffer.concat([padded, Buffer.from([0])]);
    var tail = Buffer.alloc(8); tail.writeUInt32BE(Math.floor(bitLength / 4294967296), 0); tail.writeUInt32BE(bitLength >>> 0, 4); padded = Buffer.concat([padded, tail]);
    var v = [0x7380166f,0x4914b2b9,0x172442d7,0xda8a0600,0xa96f30bc,0x163138aa,0xe38dee4d,0xb0fb0e4e];
    function p0(x) { return (x ^ rol32(x, 9) ^ rol32(x, 17)) >>> 0; }
    function p1(x) { return (x ^ rol32(x, 15) ^ rol32(x, 23)) >>> 0; }
    for (var offset = 0; offset < padded.length; offset += 64) {
      var w = new Array(68), wp = new Array(64);
      for (var j = 0; j < 16; j++) w[j] = padded.readUInt32BE(offset + j * 4);
      for (j = 16; j < 68; j++) w[j] = (p1(w[j-16] ^ w[j-9] ^ rol32(w[j-3],15)) ^ rol32(w[j-13],7) ^ w[j-6]) >>> 0;
      for (j = 0; j < 64; j++) wp[j] = (w[j] ^ w[j+4]) >>> 0;
      var a=v[0], b=v[1], c=v[2], d=v[3], e=v[4], f=v[5], g=v[6], h=v[7];
      for (j = 0; j < 64; j++) {
        var t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
        var ff = j < 16 ? (a ^ b ^ c) : ((a & b) | (a & c) | (b & c));
        var gg = j < 16 ? (e ^ f ^ g) : ((e & f) | (~e & g));
        var ss1 = rol32((rol32(a,12) + e + rol32(t,j)) >>> 0, 7);
        var ss2 = (ss1 ^ rol32(a,12)) >>> 0;
        var tt1 = (ff + d + ss2 + wp[j]) >>> 0;
        var tt2 = (gg + h + ss1 + w[j]) >>> 0;
        d=c; c=rol32(b,9); b=a; a=tt1; h=g; g=rol32(f,19); f=e; e=p0(tt2);
      }
      v = [(v[0]^a)>>>0,(v[1]^b)>>>0,(v[2]^c)>>>0,(v[3]^d)>>>0,(v[4]^e)>>>0,(v[5]^f)>>>0,(v[6]^g)>>>0,(v[7]^h)>>>0];
    }
    var out = Buffer.alloc(32); for (var k=0;k<8;k++) out.writeUInt32BE(v[k],k*4); return out;
  }
  function passportIV(data, iv) {
    for (var i=0;i<data.length;i++) { var x=data[i]; if ((i&1)===0) iv=(iv>>>4)^iv^(iv<<6)^x; else iv=~((iv>>>7)^iv^(x|(iv<<12))); iv >>>= 0; }
    return iv >>> 0;
  }
  function branch(query, body, ts) {
    var q=sm3(Buffer.from(query)), m=body.length?md5(body):Buffer.alloc(16);
    var iv=passportIV(le32(ts),passportIV(m,passportIV(q,0x20230928)));
    return {iv:iv,q:q,m:m};
  }
  function queryEscape(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g,function(c){return '%'+c.charCodeAt(0).toString(16).toUpperCase();}).replace(/%20/g,'+'); }
  function sortedQuery(values) { return Object.keys(values).sort().map(function(k){return queryEscape(k)+'='+queryEscape(values[k]);}).join('&'); }
  function appendVarint(out, value) { var n=Math.floor(value); while(n>127){out.push((n&127)|128); n=Math.floor(n/128);} out.push(n&127); }
  function protoSint(out, field, n) { appendVarint(out,field<<3); appendVarint(out,n<0?(-n*2-1):(n*2)); }
  function protoBlob(out, field, data) { if(!data.length)return; appendVarint(out,(field<<3)|2); appendVarint(out,data.length); Array.prototype.push.apply(out,data); }
  function protoText(out, field, text) { protoBlob(out,field,Buffer.from(text)); }
  function protoFloat(out,field,n) { appendVarint(out,(field<<3)|5); var b=Buffer.alloc(4); b.writeFloatLE(n,0); Array.prototype.push.apply(out,b); }
  function protoDevice(deviceID) {
    var d=[]; protoSint(d,1,1);protoSint(d,2,2);protoText(d,3,'8662');protoText(d,4,deviceID);protoText(d,5,'Ai6svO3PyrwDOUSmO6ZcResxu');protoText(d,6,'!noperm!');protoSint(d,7,-888888);protoSint(d,8,-888888);protoSint(d,9,3);protoSint(d,10,-888888);protoText(d,11,'!notset!');protoText(d,12,'Asia/Shanghai,8');protoText(d,13,'zh_CN');protoSint(d,14,4);
    [255.24993896484375,35.58599090576172,3.467449188232422,3.467449188232422,255.1754913330078,42.17544174194336].forEach(function(x,i){protoFloat(d,16+i,x);});
    protoText(d,22,'16');protoSint(d,23,41);protoSint(d,24,36);for(var f=25;f<=28;f++)protoSint(d,f,1728388016635+(f===28?2:0));protoSint(d,29,-1);
    ['25053RT47C','Redmi','25053RT47C','25053RT47C','Redmi','Redmi','Redmi'].forEach(function(x,i){protoText(d,30+i,x);});protoSint(d,38,31);return Buffer.from(d);
  }
  function passportProto(query,ts,nonce,deviceID,q,m,f13) {
    var device=protoDevice(deviceID), report=[], env=[], count=[], p=[];
    protoSint(report,1,ts);protoSint(report,2,-2);protoSint(report,4,200);
    protoSint(env,1,110);protoSint(env,2,146331399);protoSint(env,3,146331396);protoSint(env,5,7);protoText(env,6,'v04.06.04.03-bugfix');protoSint(env,7,11001);protoBlob(env,12,device);protoBlob(env,13,report);protoText(env,14,'7.3.5.32');
    protoSint(count,1,111);protoSint(count,2,10);protoSint(count,3,694367);protoSint(count,5,586952199);
    protoBlob(p,1,Buffer.from('f7e85ffad7d7dc3bd62ac87057cf6118','hex'));protoSint(p,2,3);protoSint(p,3,nonce);protoText(p,4,'8662');protoText(p,5,deviceID);protoText(p,6,'1588093228');protoText(p,7,'7.3.5.32');protoText(p,8,'v04.06.04-ml-android');protoSint(p,9,67503104);protoBlob(p,10,Buffer.from('4001000000000000','hex'));protoSint(p,12,ts);protoBlob(p,13,f13);protoBlob(p,14,q.slice(0,6));protoBlob(p,15,Buffer.from(count));protoText(p,16,'AXYQOS6n2m60x1fVZHIrH3iol');protoSint(p,17,ts);protoBlob(p,19,sm3(Buffer.concat([Buffer.from(query),m,Buffer.from('none')])));protoText(p,20,'none');protoSint(p,21,312);protoBlob(p,23,Buffer.from(env));protoText(p,24,'{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}');return Buffer.from(p);
  }
  function passportF13(iv,ts,q,m) {
    var group=Math.floor(((iv&15)-2)/3), seeds=[0x8980f29b,0xeb549c7f,0xb08726db,0xd40cb5e6,0xe8f559e4], count=(seeds[group]+ts)>>>0, shift=(count+5)&7;
    var msg=Buffer.concat([q,m,le32(ts),Buffer.from('8496779dd4150bf8','hex').map(function(x){return (x*257>>>shift)&255;}),Buffer.from([0xa0,1,0,0])]);
    var start=[0x79e0f2fb,0xc8b52570,0xebc2f8cd,0x7c104d93], end=[0x19be4866,0xe85986b4,0xe19b326e,0x71d1d7d4], shifts=[[7,12,17,22],[5,9,14,20],[4,11,16,23],[6,10,15,21]];
    // The fourth round uses the exact protocol rotation values below.
    shifts[2]=[4,11,16,23]; shifts[3]=[6,10,15,21];
    start=start.map(function(x){return rol32(x,-(count&31));});end=end.map(function(x){return rol32(x,-((count+6)&31));});
    var a=start[0],b=start[1],c=start[2],d=start[3];
    for(var i=0;i<64;i++){var round=Math.floor(i/16), f=round===0?((b&c)|(~b&d)):round===1?((b&d)|(c&~d)):round===2?(b^c^d):(c^(b|~d));var idx=ORDERS[group*64+i];var word=msg.readUInt32LE(idx*4);var x=(b+rol32((a+f+word+rol32(MD5C[i],-((count+1)&31)))>>>0,shifts[round][i%4]))>>>0;a=d;d=c;c=b;b=x;}
    var result=Buffer.alloc(20);[a,b,c,d].forEach(function(x,i){result.writeUInt32LE(((start[i]+x)^end[i])>>>0,i*4);});var check=0x20220420;for(i=0;i<12;i++){var v=result[i];check=i&1?((check>>>5)^check^(~(v|(check<<11))))>>>0:((check>>>3)^check^v^(check<<7))>>>0;}result.writeUInt32LE(((check|4)^0x1000000)>>>0,16);return result;
  }
  function pair(lo,hi){return {lo:lo>>>0,hi:hi>>>0};}
  function pairReadLE(b,o){return pair(b.readUInt32LE(o),b.readUInt32LE(o+4));}
  function pairWriteLE(b,o,x){b.writeUInt32LE(x.lo>>>0,o);b.writeUInt32LE(x.hi>>>0,o+4);}
  function pairXor(a,b){return pair(a.lo^b.lo,a.hi^b.hi);}
  function pairAdd(a,b){var lo=(a.lo+b.lo)>>>0;return pair(lo,(a.hi+b.hi+(lo<a.lo?1:0))>>>0);}
  function pairRotl(a,n){n&=63;if(!n)return pair(a.lo,a.hi);if(n===32)return pair(a.hi,a.lo);if(n<32)return pair((a.lo<<n)|(a.hi>>>(32-n)),(a.hi<<n)|(a.lo>>>(32-n)));n-=32;return pair((a.hi<<n)|(a.lo>>>(32-n)),(a.lo<<n)|(a.hi>>>(32-n)));}
  function pairRotr(a,n){return pairRotl(a,64-(n&63));}
  function helios(ts,nonce){var key=md5(Buffer.concat([le32(nonce),Buffer.from('8662')]));var raw=Buffer.from(key.toString('hex'));var k=pairReadLE(raw,0), pending=[pairReadLE(raw,8),pairReadLE(raw,16),pairReadLE(raw,24)], rounds=[k];for(var i=0;i<33;i++){var x=pairXor(pairAdd(pairRotr(pending[0],8),k),pair( i,0));pending=[pending[1],pending[2],x];k=pairXor(x,pairRotl(k,3));rounds.push(k);}var text=Buffer.from(String(ts)+'-1588093228-8662'),pad=16-text.length%16,plain=Buffer.concat([text,Buffer.alloc(pad,pad)]),out=Buffer.concat([le32(nonce),Buffer.alloc(plain.length)]);for(var at=0;at<plain.length;at+=16){var a=pairReadLE(plain,at),b=pairReadLE(plain,at+8);for(i=0;i<rounds.length;i++){b=pairXor(rounds[i],pairAdd(a,pairRotr(b,8)));a=pairXor(b,pairRotl(a,3));}pairWriteLE(out,4+at,a);pairWriteLE(out,12+at,b);}return out.toString('base64');}
  function gorgon(query,body,ts,nonce){var q=md5(Buffer.from(query)),m=body.length?md5(body):Buffer.alloc(16),data=Buffer.alloc(20);q.copy(data,0,0,4);m.copy(data,4,0,4);data.writeUInt32LE(67503104,12);data.writeUInt32BE(ts>>>0,16);var key=[0x4a,0x40,0x16,(nonce>>>8)&255,0x47,0x6c,1,nonce&255],s=new Array(256);for(var i=0;i<256;i++)s[i]=i;var j=0;for(i=0;i<256;i++){j=(j+s[i]+key[i%8])&255;s[i]=s[j];}j=0;for(i=0;i<20;i++){j+=s[i+1];var y=s[j&255];s[i+1]=y;data[i]^=s[(y*2)&255];}for(i=0;i<20;i++){data[i]=rol8(data[i],4);var next=i<19?data[i+1]:data[0];data[i]=~(reverse8(data[i]^next)^20)&255;}var head=Buffer.from([0x84,4,nonce&255,(nonce>>>8)&255,0x40,1]);return Buffer.concat([head,data]).toString('hex');}
  function xmxor(data,key){var out=Buffer.alloc(data.length);for(var i=0;i<data.length;i++){var k=(i*4)&28,a=key[k],b=key[k+1],v=(~(rol8(data[i],4)+a)^b)&255;v=(rol8(v,3)+b)&255;out[out.length-1-i]=~(v^a)&255;}var flag=out[out.length-1]^out[out.length-2],old=out[0];out[0]=(out[0]+(~flag))&255;out[1]=(out[1]+(out[0]^out[out.length-1]^254))&255;out[2]=(out[2]+((flag-old)^rol8(out[1],3)^2))&255;for(i=0;i<out.length-4;i++)out[i+3]=(out[i+3]+(~(rol8(out[i+2],3)^out[i+1]^(i+3))))&255;out[out.length-1]^=out[out.length-2];var sum=0;for(i=1;i<out.length;i++)sum=(sum+out[i])&255;out[0]=((out[0]^out[1])+sum)&255;return out;}
  function aesV3(data,ts){if(data.length<248)throw new Error('signature payload is too short');var branch=ts&3,box=SBOX.slice(branch*256,(branch+1)*256),con=[[1,0,2,3],[2,0,3,1],[0,1,3,2],[1,0,2,3]][branch],orders=[[0,9,14,11,4,13,2,7,8,1,6,15,12,5,10,3],[0,9,14,15,4,13,2,7,8,1,6,3,12,5,10,11],[0,9,14,7,4,13,2,11,8,1,6,3,12,5,10,15],[0,9,14,11,4,13,2,7,8,1,6,15,12,5,10,3]][branch],init=[0xca025ddc,0x823dc546,0xc9420583,0xc298225f][branch],key=Buffer.from('f1593376766ea98d34f31b057a9d5be4','hex'),mk=Buffer.alloc(48),r=8;for(var j=0;j<16;j++)mk[j]=key[j]^((init>>>((j%4)*8))&255);for(j=4;j<12;j++){var prev=Buffer.from(mk.slice(j*4-4,j*4));if(j%4===0)prev=Buffer.from([((init>>> (r&24))&255)^box[prev[1]],box[prev[2]],box[prev[3]],box[prev[0]]]);r+=2;for(var k=0;k<4;k++)mk[j*4+k]=prev[k]^mk[j*4+k-16];}
    function block(src){var b=Buffer.from(src),prev,z,index,col,aa,cc,dd,ee,t;function add(base){for(z=0;z<b.length;z++)b[z]^=mk[base+Math.floor(z/4)*4+con[z%4]];}add(0);for(var round=1;round<=2;round++){prev=Buffer.from(b);for(z=0;z<b.length;z++){index=orders[z];b[z]=box[prev[con[Math.floor(index/4)]*4+index%4]];}if(round===1){prev=Buffer.from(b);for(z=0;z<b.length;z++)b[z]=prev[Math.floor(z/4)*4+con[z%4]];function xt(x){return x&128?((x<<1)^0x1b)&255:(x<<1)&255;}for(col=0;col<4;col++){aa=b[col];cc=b[4+col];dd=b[8+col];ee=b[12+col];t=aa^cc^dd^ee;b[col]^=t^xt(aa^cc);b[4+col]^=t^xt(cc^dd);b[8+col]^=t^xt(dd^ee);b[12+col]^=t^xt(ee^aa);}}add(round*16);}for(z=0;z<b.length;z++)b[z]^=mk[16+z];return b;}
    var plain=Buffer.alloc(32);for(j=0;j<31;j++){var d=data.slice(j*8),v=d[0];plain[j]=((v>>>4)&2)|(d[1]&64)|((d[2]>>>2)&1)|((d[3]<<3)&128)|((d[4]>>>1)&4)|((d[5]<<3)&16)|((d[6]<<5)&32)|((d[7]>>>4)&8);}plain[31]=1;var previous=Buffer.from('1fe109a4125283f418de9e051a969e12','hex'),encrypted=Buffer.alloc(32);for(j=0;j<32;j+=16){for(k=0;k<16;k++)plain[j+k]^=previous[k];previous=block(plain.slice(j,j+16));previous.copy(encrypted,j);}var out=Buffer.concat([Buffer.from([encrypted[31]]),data]);for(j=0;j<31;j++){d=out.slice(1+j*8);v=encrypted[j];d[0]=(d[0]&~32)|(v<<4&32);d[1]=(d[1]&~64)|(v&64);d[2]=(d[2]&~4)|(v<<2&4);d[3]=(d[3]&~16)|(v>>>3&16);d[4]=(d[4]&~8)|(v<<1&8);d[5]=(d[5]&~2)|(v>>>3&2);d[6]=(d[6]&~1)|(v>>>5&1);d[7]=(d[7]&127)|(v<<4&128);}return out;}
  function medusa(query,ts,nonce,hashRand,xmRand,deviceID,iv,q,m){var f13=passportF13(iv,ts,q,m),p=passportProto(query,ts,nonce,deviceID,q,m,f13),signKey=Buffer.from('8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5','hex'),key=sm3(Buffer.concat([signKey,le32(hashRand),signKey])),d1=(hashRand>>>16)&255,seed=le32(~((((d1<<11)|(hashRand>>>24))^(d1>>>5)^d1)>>>0));p=Buffer.concat([Buffer.from('4001000000000000','hex'),xmxor(p,key)]);p=Buffer.from(p).reverse();for(var i=0;i<p.length;i++)p[i]^=seed[(~i)&3];var check=(0x18000001|((q[0]&63)<<14)|((f13[0]&63)<<8))>>>0;var body=Buffer.concat([Buffer.from([0x35]),le32(xmRand),le32(check),p,le32(hashRand).slice(2)]);var encrypted=aesV3(body,ts),header=Buffer.from('03000000f7e85ffad7d7dc3bd62ac87057cf6118','hex');for(i=0;i<20;i+=4)header.writeUInt32LE((header.readUInt32LE(i)^ts)>>>0,i);return Buffer.concat([header,le32(hashRand).slice(0,2),Buffer.from([0,1]),encrypted]);}
  function tune(values,body,stamp){for(var i=0;i<256;i++){values._rticket=String(stamp+i);var query=sortedQuery(values),b=branch(query,body,Math.floor(stamp/1000));if(((b.iv&15)%3)===2)return {query:query,branch:b,stamp:stamp+i};}throw new Error('unable to select signature branch');}
  function random32(){return crypto.randomBytes(4).readUInt32LE(0);}
  function sign(values,bodyBytes,stamp,deviceID){var tuned=tune(values,bodyBytes,stamp),query=tuned.query,b=tuned.branch,ts=Math.floor(stamp/1000)>>>0,n=[random32(),random32(),random32(),random32()],med=medusa(query,ts,n[0],n[1],n[2],deviceID,b.iv,b.q,b.m),h={
    'X-Khronos':String(ts),'X-SS-Req-Ticket':String(values._rticket),'X-Helios':helios(ts,n[3]),'X-Medusa':med.toString('base64'),'X-Gorgon':gorgon(query,bodyBytes,ts,n[0]&65535)
  };if(bodyBytes.length)h['X-SS-STUB']=b.m.toString('hex').toUpperCase();return {query:query,headers:h};}
  function internationalGorgon(query,body,ts,nonce){var q=md5(Buffer.from(query)),m=body.length?md5(body):Buffer.alloc(16),data=Buffer.alloc(20);q.copy(data,0,0,4);m.copy(data,4,0,4);data.writeUInt32LE(67503104,12);data.writeUInt32BE(ts>>>0,16);var key=[0x4a,0x40,0x16,(nonce>>>8)&255,0x47,0x6c,1,nonce&255],s=new Array(256);for(var i=0;i<256;i++)s[i]=i;var j=0;for(i=0;i<256;i++){j=(j+s[i]+key[i%8])&255;var swap=s[i];s[i]=s[j];s[j]=swap;}var ii=0; j=0;for(i=0;i<data.length;i++){ii=(ii+1)&255;j=(j+s[ii])&255;swap=s[ii];s[ii]=s[j];s[j]=swap;data[i]^=s[(s[ii]+s[j])&255];}for(i=0;i<data.length;i++){data[i]=rol8(data[i],4);var next=i<19?data[i+1]:data[0];data[i]=~(reverse8(data[i]^next)^20)&255;}return Buffer.concat([Buffer.from([0x84,4,nonce&255,(nonce>>>8)&255,0x40,1]),data]).toString('hex');}
  function signInternational(values,bodyBytes,stamp){var tuned=tune(values,bodyBytes,stamp),query=tuned.query,ts=Math.floor(tuned.stamp/1000)>>>0,raw=crypto.randomBytes(14),be=Buffer.alloc(4);be.writeUInt32BE(ts,0);var trace=(tun32(tuned.stamp).toString(16).padStart(8,'0')+'10'+raw.slice(6).toString('hex'));var h={'X-Khronos':String(ts),'X-SS-Req-Ticket':String(values._rticket),'X-Argus':le32(ts).toString('base64'),'X-Ladon':be.toString('base64'),'X-Helios':helios(ts,raw.readUInt32LE(2)),'X-Gorgon':internationalGorgon(query,bodyBytes,ts,raw.readUInt16LE(0)),'X-TT-Trace-Id':'00-'+trace+'-'+trace.slice(0,16)+'-01'};if(bodyBytes.length)h['X-SS-STUB']=md5(bodyBytes).toString('hex').toUpperCase();return {query:query,headers:h};}
  function tun32(value){return value>>>0;}
  function le32(value){var b=Buffer.alloc(4);b.writeUInt32LE(value>>>0,0);return b;}
  module.exports={sign:sign,signInternational:signInternational,sm3:sm3,branch:branch,passportF13:passportF13,passportProto:passportProto,helios:helios,gorgon:gorgon,medusa:medusa,aesV3:aesV3,internationalGorgon:internationalGorgon};
}());
