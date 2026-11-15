'use strict';
var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), url = require('url');
var helpers = require('./number-input').searchHelpers;
function nonce() { return crypto.randomBytes(32).toString('hex'); }
function fail() { var e = new Error('手机搜索暂不可用，请使用扫码输入'); e.status = 503; e.code = 'PHONE_SEARCH_UNAVAILABLE'; return e; }
module.exports = function (options) {
  options = options || {};
  var dir = options.dataDir, selectIP = options.selectIP || helpers.selectIP, now = options.now || Date.now;
  var token = '', port = 0, host = '', server = null, starting = null, closed = false, lease = '', key = '', value = '', id = 0, ready = false, expires = 0;
  var assets = options.assetsDir || (fs.existsSync(path.join(__dirname,'phone-search.html')) ? __dirname : path.join(__dirname,'../../core/cmd/hongguotv/ui'));
  function startServer() {
    if (closed || !dir) return Promise.reject(fail());
    var ip;
    try {
      ip = selectIP();
      if (!token) {
        var saved = {}; try { var bytes = fs.readFileSync(path.join(dir,'phone-search.json')); if (bytes.length < 1024) saved = JSON.parse(bytes.toString('utf8')); } catch (ignored) {}
        token = /^[a-f0-9]{64}$/.test(saved.token) ? saved.token : nonce();
        port = Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535 ? saved.port : 0;
      }
      if (server && host.split(':')[0] === ip) return Promise.resolve();
      if (server) { server.close(); server = null; }
    } catch (ignored) { return Promise.reject(fail()); }
    return new Promise(function (resolve,reject) {
      function listen(preferred) {
        var candidate = http.createServer(mobile);
        candidate.timeout = 10000; candidate.keepAliveTimeout = 15000; candidate.headersTimeout = 5000;
        candidate.once('error',function () { if (preferred) listen(0); else reject(fail()); });
        candidate.listen(preferred,ip,function () {
          if (closed) { candidate.close(); reject(fail()); return; }
          port = candidate.address().port; host = ip+':'+port;
          try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true,mode:448});
            fs.writeFileSync(path.join(dir,'phone-search.json.tmp'),JSON.stringify({token:token,port:port}),{mode:384});
            fs.renameSync(path.join(dir,'phone-search.json.tmp'),path.join(dir,'phone-search.json'));
          } catch (ignored) { candidate.close(); reject(fail()); return; }
          server = candidate; resolve();
        });
      }
      listen(port);
    });
  }
  function start() {
    // Serialize starts: a late old activation must not replace a newer page.
    var task = (starting || Promise.resolve()).catch(function () {}).then(startServer).then(function () {
      if (closed) throw fail();
      var qr = helpers.makeQR('http://'+host+'/search/'+token+'/');
      lease = nonce(); key = nonce(); value = ''; id = 0; ready = true; expires = now()+10000;
      return {session:lease,state:'waiting',qr:qr};
    });
    starting = task; return task;
  }
  function poll(session,ack,active,stop) {
    if (!session || session !== lease || now() >= expires) return {state:'expired'};
    if (stop) { ready = false; lease = key = value = ''; return {state:'closed'}; }
    ready = active; expires = now()+10000;
    if (!active || Number(ack) === id) value = '';
    return value ? {state:'completed',id:id,value:value} : {state:'waiting'};
  }
  function json(res,status,data) { res.statusCode = status; res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify(data)); }
  function mobile(req,res) {
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    var remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/,''), base = '/search/'+token, route = url.parse(req.url).pathname;
    if (closed || !token || !helpers.privateIPv4(remote) && remote !== '127.0.0.1' || req.headers.host !== host) { res.statusCode = 404; res.end(); return; }
    if (req.headers.origin && req.headers.origin !== 'http://'+host || req.headers['sec-fetch-site'] === 'cross-site') { res.statusCode = 403; res.end(); return; }
    if (req.method === 'GET' && route === base) { res.statusCode = 307; res.setHeader('Location',base+'/'); res.end(); return; }
    if (req.method === 'GET' && (route === base+'/' || route === base+'/mobile.js')) {
      try {
        res.setHeader('Content-Type',route === base+'/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
        res.end(fs.readFileSync(path.join(assets,route === base+'/' ? 'phone-search.html' : 'phone-search-page.js')));
      } catch (ignored) { res.statusCode = 500; res.end(); } return;
    }
    if (route !== base+'/state') { res.statusCode = 404; res.end(); return; }
    var active = ready && lease !== '' && now() < expires;
    if (!active) value = '';
    if (req.method === 'GET') return json(res,200,active ? {ready:true,pending:!!value,nonce:key} : {ready:false,pending:false});
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    if (!active) return json(res,409,{error:'TV_NOT_READY'});
    var chunks = [], length = 0, done = false, observed = lease;
    req.on('data',function (chunk) { if (done) return; length += chunk.length; if (length > 4096) { done = true; chunks = []; json(res,413,{error:'INVALID_INPUT'}); } else chunks.push(chunk); });
    req.on('error',function () { done = true; chunks = []; });
    req.on('end',function () {
      if (done) return;
      if (!ready || lease !== observed || now() >= expires) return json(res,409,{error:'TV_NOT_READY'});
      var body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (ignored) { return json(res,400,{error:'INVALID_INPUT'}); }
      if (!body || typeof body.query !== 'string' || Object.keys(body).some(function (k) { return k !== 'nonce' && k !== 'query'; })) return json(res,400,{error:'INVALID_INPUT'});
      var query = body.query.trim().replace(/\s+/g,' ');
      if (!query || query.length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(query)) return json(res,400,{error:'INVALID_INPUT'});
      if (!body.nonce || body.nonce !== key) return json(res,409,{error:'STALE_FORM'});
      if (value) return json(res,409,{error:'PENDING_INPUT'});
      key = nonce(); value = query; id++; json(res,200,{accepted:true});
    });
  }
  return {start:start,poll:poll,close:function () { closed = true; ready = false; lease = key = value = ''; if (server) { server.close(); server = null; } },
    address:function () { return server && server.address(); }};
};
