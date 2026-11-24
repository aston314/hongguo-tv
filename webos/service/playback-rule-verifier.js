'use strict';
require('./runtime-compat');
var crypto = require('crypto'), url = require('url');
var nacl = require('./vendor/tweetnacl/nacl-fast');
var trust = require('./playback-rule-trust');
var ROOT = 'https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/resolver-js/';
function fault(code) { var e = new Error(code); e.code = code; e.stage = 'resolver_js'; return e; }
function keys(value, expected) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected.slice().sort().join(','); }
function integer(n) { return Number.isSafeInteger(n); }
function bytes(text, size) {
  if (typeof text !== 'string') throw fault('RULE_SIGNATURE_REJECTED');
  var b = Buffer.from(text, 'base64');
  if (b.toString('base64') !== text || size && b.length !== size) throw fault('RULE_SIGNATURE_REJECTED');
  return b;
}
function official(raw) {
  if (typeof raw !== 'string' || raw.indexOf(ROOT) !== 0 || raw.length > 1024) return false;
  var u = url.parse(raw);
  return u.protocol === 'https:' && u.host === 'raw.githubusercontent.com' && !u.auth && !u.search && !u.hash &&
    !/[\\%]/.test(raw) && u.pathname.indexOf('..') < 0;
}
function digest(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function verify(envelope, options) {
  options = options || {};
  if (!keys(envelope, ['payload','signature'])) throw fault('RULE_MANIFEST_REJECTED');
  var payload = bytes(envelope.payload), signature = bytes(envelope.signature,64);
  var key = options.publicKey || Buffer.from(trust.publicKey, 'hex');
  // TweetNaCl accepts an equivalent S+L scalar. Match Go's canonical-S policy.
  var order = [237,211,245,92,26,99,18,88,214,156,247,162,222,249,222,20,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,16], less = false;
  for (var i=31;i>=0;i--) { if (signature[i+32] !== order[i]) { less = signature[i+32] < order[i]; break; } }
  if (!less || key.length !== 32 || payload.length > 8192 || !nacl.sign.detached.verify(new Uint8Array(payload),new Uint8Array(signature),new Uint8Array(key))) throw fault('RULE_SIGNATURE_REJECTED');
  var m; try { m = JSON.parse(payload.toString('utf8')); } catch (ignored) { throw fault('RULE_MANIFEST_REJECTED'); }
  if (!keys(m,['schema','product','revision','enabled','issued_at','expires_at','module']) || m.schema !== 1 || m.product !== 'hongguo-playback-resolver' ||
      !integer(m.revision) || m.revision < 1 || typeof m.enabled !== 'boolean' || !integer(m.issued_at) || m.issued_at <= 0 || !integer(m.expires_at) ||
      m.expires_at <= m.issued_at || m.expires_at-m.issued_at > 2592000) throw fault('RULE_MANIFEST_REJECTED');
  var canonical = {schema:m.schema,product:m.product,revision:m.revision,enabled:m.enabled,issued_at:m.issued_at,expires_at:m.expires_at,module:null};
  if (m.enabled) {
    var a=m.module;
    if (!keys(a,['version','protocol','host_api','url','size','sha256']) || !/^[A-Za-z0-9._-]{1,64}$/.test(a.version) || a.protocol !== 1 || a.host_api !== 1 ||
        !integer(a.size) || a.size < 1 || a.size > 1048576 || !/^[a-f0-9]{64}$/.test(a.sha256) || a.url !== ROOT+'modules/'+a.sha256+'.js') throw fault('RULE_MODULE_REJECTED');
    canonical.module={version:a.version,protocol:a.protocol,host_api:a.host_api,url:a.url,size:a.size,sha256:a.sha256};
  } else if (m.module !== null) throw fault('RULE_MANIFEST_REJECTED');
  if (JSON.stringify(canonical) !== payload.toString('utf8')) throw fault('RULE_MANIFEST_REJECTED');
  var now=Math.floor((options.now === undefined ? Date.now() : options.now)/1000);
  if (!options.stored && (m.issued_at > now+300 || m.expires_at <= now)) throw fault('RULE_MANIFEST_EXPIRED');
  return m;
}
module.exports={verify:verify,digest:digest,official:official,root:ROOT,manifest:ROOT+'manifest.json',fault:fault};
