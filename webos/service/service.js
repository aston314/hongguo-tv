(function () {
  'use strict';

  var SERVICE_ID = 'com.aston314.hongguo.webos.service';
  var DEFAULT_PORT = 7655;

  function createService(options) {
    options = options || {};
    var http = options.http || require('http');
    var url = options.url || require('url');
    var serviceID = String(options.serviceID || SERVICE_ID);
    // Keep staged simulator data/cache isolated when the test package uses a
    // suffixed Service ID. Production still resolves to the normal webOS
    // service directory.
    if (!process.env.HONGGUO_WEBOS_SERVICE_ID) process.env.HONGGUO_WEBOS_SERVICE_ID = serviceID;
    var provider = options.provider || require('./provider');
    var account = options.account || require('./account')({ dataDir: provider.dataDirectory ? provider.dataDirectory() : process.env.HONGGUO_WEBOS_DATA_DIR });
    var numberInput = options.numberInput || require('./number-input')();
    var updates = options.updates || require('./updates')();
    var port = options.port === undefined ? Number(process.env.HONGGUO_WEBOS_PORT) || DEFAULT_PORT : options.port;
    var bindHost = options.bindHost || process.env.HONGGUO_WEBOS_BIND_HOST || '127.0.0.1';
    var server = null;
    var serverStart = null;
    var activity = null;
    var activityStart = null;
    var lastStartupError = null;
    var luna = options.service;
    if (!luna) {
      var Service = options.Service || require('webos-service');
      luna = new Service(serviceID);
    }

    function cors(res, origin) {
      if (origin === 'null' || origin === 'http://127.0.0.1:' + port) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
    }

    function json(res, status, payload, req) {
      var body = JSON.stringify(payload);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      cors(res, req && req.headers && req.headers.origin);
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
    }

    function notImplemented(req, res, path) {
      json(res, 501, {
        ok: false,
        error: 'WEBOS_PROVIDER_NOT_IMPLEMENTED',
        message: 'webOS 当前未接入此功能的数据服务',
        path: path,
        experimental: true,
        playback_verified: false
      }, req);
    }

    function statusPayload() {
      return {
        ok: true,
        ready: !!(server && server.listening),
        service: 'hongguo-webos-service',
        implementation: 'experimental-js-service',
        platform: 'webos',
        port: port,
        capabilities: ['web-ui', 'luna-service', 'html5-video', 'real-video-model-signing', 'cenc-aes-ctr', 'local-media-cache', 'range-media-proxy', 'category', 'rank', 'search', 'search-suggestions', 'series-detail', 'series-seasons', 'actor-works', 'player-stats', 'radar', 'local-library', 'search-history', 'number-input', 'account-login', 'account-mfa', 'follow', 'reservations', 'notifications', 'player-actions', 'cloud-library'],
        experimental: true,
        playback_verified: false,
        protocol_verified: true,
        verification_note: '主应用共享 UI 所需接口均已接入；LG 真机播放尚未验证；登录和云端写入需使用真实账号验收'
      };
    }

    function errorPayload(error, stage) {
      var code = error && error.code ? String(error.code) : 'SERVICE_START_FAILED';
      var message = String(error && error.message || error || '本机服务启动失败');
      var details = {
        ok: false,
        ready: false,
        error: code,
        code: code,
        stage: stage || error && error.stage || 'service_start',
        message: message,
        port: port,
        service: 'hongguo-webos-service'
      };
      lastStartupError = details;
      return details;
    }

    function query(req) { return url.parse(String(req.url || '/'), true).query || {}; }
    function data(req, res, payload) { json(res, 200, { ok: true, data: payload }, req); }
    function failure(req, res, error) {
      if (!error || Number(error.status) >= 500 || !error.status) console.error('[hongguo-webos] provider error:', error && error.stack || error);
      var details = { ok: false, error: String(error && error.code || 'UPSTREAM_ERROR'), message: String(error && error.message || error || '上游请求失败'), playback_verified: false };
      if (error && error.stage) details.stage = String(error.stage);
      if (error && Number(error.status)) details.upstream_status = Number(error.status);
      if (provider.videoModelDiagnostics) details.video_model = provider.videoModelDiagnostics();
      json(res, Number(error && error.status) || 502, details, req);
    }
    function supportedMethod(req) { return req.method === 'GET' || req.method === 'HEAD' || req.method === 'POST' || req.method === 'DELETE'; }

    function bodyJSON(req, limit) {
      return new Promise(function (resolve, reject) {
        var chunks = [], total = 0, max = limit || 32768, rejected = false;
        req.on('data', function (chunk) {
          if (rejected) return;
          total += chunk.length;
          if (total > max) { rejected = true; chunks = []; var tooLarge = new Error('请求体过大'); tooLarge.status = 413; tooLarge.code = 'REQUEST_TOO_LARGE'; reject(tooLarge); return; }
          chunks.push(chunk);
        });
        req.on('error', function (error) { if (!rejected) reject(error); });
        req.on('end', function () {
          if (rejected) return;
          if (!chunks.length) { resolve({}); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (error) { var invalid = new Error('请求参数不是有效 JSON'); invalid.status = 400; invalid.code = 'INVALID_JSON'; reject(invalid); }
        });
      });
    }

    function accountRequired() { var error = new Error('请先登录红果账号'); error.status = 401; error.code = 'ACCOUNT_REQUIRED'; return error; }
    function accountFailure(req, res, error) {
      if (!error || Number(error.status) >= 500 || !error.status) console.error('[hongguo-webos] account error:', error && error.stack || error);
      json(res, Number(error && error.status) || 502, { ok: false, error: String(error && error.code || 'ACCOUNT_ERROR'), message: String(error && error.message || error || '账号请求失败'), data: account.status() }, req);
    }

    function handleProvider(req, res, pathName) {
      var q = query(req);
      if (!supportedMethod(req)) return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, req);
      if (pathName === '/api/v1/webos/update') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, req);
        return updates.check().then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/player/cache-session') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, req);
        return bodyJSON(req, 1024).then(function (body) { return provider.cacheSession(body); }).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/player/audio') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, req);
        var audioAbort = require('./audio-cancel').create();
        function stopAudio() { audioAbort.abort(); }
        function detachAudio() { req.removeListener('aborted', stopAudio); res.removeListener('close', stopAudio); }
        req.once('aborted', stopAudio); res.once('close', stopAudio);
        return provider.prepareAudio(String(q.media || ''), audioAbort.signal).then(function (audio) {
          detachAudio(); if (res.destroyed || audioAbort.signal.aborted) return;
          res.statusCode = 200; cors(res, req.headers.origin);
          res.setHeader('Content-Type', 'audio/mp4');
          res.setHeader('Content-Length', audio.body.length);
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Access-Control-Expose-Headers', 'Content-Length, X-Hongguo-Audio-Duration, X-Hongguo-Audio-Channels');
          res.setHeader('X-Hongguo-Audio-Duration', String(audio.duration));
          res.setHeader('X-Hongguo-Audio-Channels', String(audio.channels));
          res.end(audio.body);
        }, function (error) { detachAudio(); if (!res.destroyed && !audioAbort.signal.aborted) failure(req, res, error); });
      }
      if (pathName.indexOf('/minireel-proxy/media/') === 0) {
        return provider.serveMedia(req, res, pathName.slice('/minireel-proxy/media/'.length).replace(/\.mp4$/, ''));
      }
      if (pathName === '/minireel-proxy/resolve' || pathName === '/api/v1/play/info' || pathName === '/api/v1/PlayInfo') {
        var seriesID = String(q.series_id || ''), vid = String(q.vid || '');
        var preparationAbort = require('./audio-cancel').create();
        function stopPreparation() { preparationAbort.abort('PLAYBACK_PREPARATION_CANCELLED'); }
        function detachPreparation() { req.removeListener('aborted', stopPreparation); res.removeListener('close', stopPreparation); }
        req.once('aborted', stopPreparation); res.once('close', stopPreparation);
        return provider.prepare(seriesID, vid, String(q.quality || ''), String(q.fallback || '') === '1', String(q.mode || ''), String(q.prefetch || '') === '1', preparationAbort.signal).then(function (result) {
          detachPreparation(); if (!res.destroyed && !preparationAbort.signal.aborted) data(req, res, result);
        }, function (error) {
          detachPreparation(); if (!res.destroyed && !preparationAbort.signal.aborted) failure(req, res, error);
        });
      }
      if (pathName === '/api/v1/category' || pathName === '/api/v1/Category') {
        return provider.category(String(q.path || '/category/real-drama'), Number(q.offset || 0), q, String(q.selectors || '') === '1').then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/lists/recommend') {
        if (String(q.channel || '16') === '45') return account.recommend(q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
        return provider.recommend(q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/lists/new') {
        return provider.newSeries(q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/lists/rank' || pathName === '/api/v1/rank' || pathName === '/api/v1/Rank') {
        return provider.rank(q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/lists/search' || pathName === '/api/v1/search' || pathName === '/api/v1/Search') {
        return provider.search(q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/lists/reservations') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return failure(req, res, new Error('method not allowed'));
        return account.reservations(q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/follow') {
        if (req.method === 'GET' || req.method === 'HEAD') return account.follow(q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
        return bodyJSON(req, 4096).then(function (body) { return account.setFollow(String(body.series_id || ''), body.enabled === true); }).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/reservation') {
        if (req.method !== 'POST') return failure(req, res, new Error('method not allowed'));
        return bodyJSON(req, 4096).then(function (body) { if (typeof body.reserved !== 'boolean') { var error = new Error('预约参数无效'); error.status = 400; error.code = 'ACCOUNT_RESERVATION'; throw error; } return account.reserve(String(body.item_id || body.series_id || ''), body.reserved); }).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/player/action') {
        if (req.method !== 'POST') return failure(req, res, new Error('method not allowed'));
        return bodyJSON(req, 32768).then(function (body) { return account.playerAction(body); }).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/notifications') {
        if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve().then(function () { return account.notifications(q); }).then(function (result) { data(req, res, result); }, function (error) { accountFailure(req, res, error); });
        if (req.method !== 'POST') return failure(req, res, new Error('method not allowed'));
        return bodyJSON(req, 4096).then(function (body) { return account.markNotifications(body); }).then(function (result) { data(req, res, result); }, function (error) { accountFailure(req, res, error); });
      }
      if (pathName === '/api/v1/comments' || pathName === '/api/v1/danmaku') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return failure(req, res, accountRequired());
        return provider.discussion(String(q.series_id || ''), String(q.vid || ''), q, pathName === '/api/v1/danmaku').then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/replies') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return failure(req, res, accountRequired());
        return provider.replies(String(q.series_id || ''), String(q.vid || ''), String(q.comment_id || ''), q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/lists/calendar') {
        return provider.calendar(q).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/series/detail' || pathName === '/api/v1/SeriesDetail') {
        return provider.detail(String(q.series_id || '')).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/series/seasons') {
        return provider.seasons(String(q.series_id || '')).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/series/next-season') {
        if (typeof provider.nextSeason !== 'function') return failure(req, res, new Error('系列剧季关系服务未接入'));
        return provider.nextSeason(String(q.series_id || '')).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/search/suggestions') {
        return provider.suggestions(String(q.q || '')).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/actors/works') {
        return provider.actorWorks(String(q.actor_id || '')).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/radar') {
        return provider.radar().then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/player/stats') {
        return provider.engagement(String(q.series_id || ''), String(q.vid || '')).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/library') {
        if (req.method === 'GET' || req.method === 'HEAD') return data(req, res, account.librarySnapshot());
        if (req.method !== 'POST') return failure(req, res, new Error('method not allowed'));
        return bodyJSON(req).then(function (body) {
          var status = account.status();
          if (status.logged_in) return account.changeLibrary(body);
          if (String(body.owner_id || '') !== '') { var changed = new Error('账号已切换，请重新打开页面'); changed.status = 409; changed.code = 'ACCOUNT_CHANGED'; throw changed; }
          return provider.changeLibrary(body);
        }).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/number-input') {
        if (req.method === 'POST') {
          return bodyJSON(req, 1024).then(function (body) { return numberInput.start(String(body.kind || ''), String(body.country_code || '+86')); }).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
        }
        if (req.method === 'GET' || req.method === 'HEAD') return data(req, res, numberInput.poll(String(q.session || ''), false));
        if (req.method === 'DELETE') return data(req, res, numberInput.poll(String(q.session || ''), true));
        return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, req);
      }
      if (pathName === '/api/v1/search-history') {
        if (req.method === 'GET' || req.method === 'HEAD') return data(req, res, provider.searchHistory('GET', ''));
        if (req.method === 'DELETE') return data(req, res, provider.searchHistory('DELETE', ''));
        return bodyJSON(req, 2048).then(function (body) { return provider.searchHistory('POST', body.query); }).then(function (result) { data(req, res, result); }, function (error) { failure(req, res, error); });
      }
      if (pathName === '/api/v1/player/diagnostics') {
        return data(req, res, provider.mediaDiagnostics(String(q.media || '')));
      }
      if (pathName === '/api/v1/account' || pathName.indexOf('/api/v1/account/') === 0) {
        if (pathName.indexOf('/api/v1/account/qr/') === 0) {
          if (pathName === '/api/v1/account/qr/status' && req.method === 'GET') return data(req, res, account.qrStatus(String(q.id || '')));
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, req);
          return bodyJSON(req, 2048).then(function (body) {
            if (!body || Array.isArray(body) || Object.keys(body).some(function (key) { return key !== 'id'; })) { var invalid = new Error('扫码请求无效'); invalid.status = 400; throw invalid; }
            if (pathName === '/api/v1/account/qr/start') return account.startQR();
            if (pathName === '/api/v1/account/qr/cancel') return account.cancelQR(String(body.id || ''));
            var missingQR = new Error('扫码操作不存在'); missingQR.status = 404; throw missingQR;
          }).then(function (result) { data(req, res, result); }, function (error) { accountFailure(req, res, error); });
        }
        if (req.method === 'GET' || req.method === 'HEAD') return data(req, res, account.status());
        if (req.method !== 'POST') return failure(req, res, new Error('method not allowed'));
        var accountAction = pathName.slice('/api/v1/account/'.length);
        return bodyJSON(req, 4096).then(function (body) {
          if (accountAction === 'send-code') return account.sendCode(String(body.country_code || '+86'), String(body.phone || ''));
          if (accountAction === 'login') return account.loginSMS(String(body.country_code || '+86'), String(body.phone || ''), String(body.code || ''));
          if (accountAction === 'verify') return account.verify();
          if (accountAction === 'cancel') return account.cancel();
          if (accountAction === 'logout') return account.logout();
          if (accountAction === 'sync') return account.sync();
          if (accountAction === 'import-history') return account.importHistory(body);
          var missing = new Error('账号操作不存在'); missing.status = 404; missing.code = 'ACCOUNT_ACTION'; throw missing;
        }).then(function (result) {
          if (accountAction === 'import-history') return json(res, 200, { ok: true, data: result.status, import_history: result.import_history }, req);
          return data(req, res, result);
        }, function (error) { accountFailure(req, res, error); });
      }
      return notImplemented(req, res, pathName);
    }

    function handle(req, res) {
      if (req.method === 'OPTIONS') {
        cors(res, req.headers && req.headers.origin);
        res.statusCode = 204;
        return res.end();
      }
      var pathName = String(req.url || '/').split('?')[0];
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST' && req.method !== 'DELETE') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, req);
      if (pathName === '/api/v1/health') return json(res, 200, { ok: true, ready: !!(server && server.listening), service: 'hongguo-webos-service', port: port }, req);
      if (pathName === '/api/v1/diagnostics') return json(res, 200, { ok: true, ready: !!(server && server.listening), port: port, lastStartupError: lastStartupError, video_model: provider.videoModelDiagnostics ? provider.videoModelDiagnostics() : { stage: 'unavailable', code: 'NOT_SUPPORTED' } }, req);
      if (pathName === '/api/v1/status') return json(res, 200, statusPayload(), req);
      if (pathName.indexOf('/api/') === 0 || pathName.indexOf('/minireel-proxy/media/') === 0 || pathName === '/minireel-proxy/resolve') {
        try { return handleProvider(req, res, pathName); } catch (error) { return failure(req, res, error); }
      }
      return json(res, 404, { ok: false, error: 'NOT_FOUND' }, req);
    }

    function ensureActivity() {
      var manager = luna.activityManager;
      if (activity) return Promise.resolve(activity);
      if (activityStart) return activityStart;
      if (!manager || typeof manager.create !== 'function') {
        if (manager) manager.idleTimeout = 12 * 60 * 60;
        return Promise.resolve(null);
      }
      activityStart = new Promise(function (resolve) {
        var finished = false;
        var timer = setTimeout(function () {
          if (finished) return;
          finished = true;
          activityStart = null;
          manager.idleTimeout = 12 * 60 * 60;
          resolve(null);
        }, 5000);
        try {
          manager.create('hongguo-webos-http', function (value) {
            if (finished) { activity = value || activity; return; }
            finished = true;
            clearTimeout(timer);
            activity = value || null;
            resolve(activity);
          });
        } catch (error) {
          clearTimeout(timer);
          finished = true;
          activityStart = null;
          manager.idleTimeout = 12 * 60 * 60;
          console.error('[hongguo-webos] activity create failed:', error && error.stack || error);
          resolve(null);
        }
      }).then(function (value) {
        if (value) activityStart = null;
        return value;
      });
      return activityStart;
    }

    function ensureServer() {
      if (server && server.listening) return Promise.resolve(server);
      if (serverStart) return serverStart;
      server = http.createServer(handle);
      serverStart = new Promise(function (resolve, reject) {
        function onError(error) {
          error.stage = 'http_bind';
          server.removeListener('listening', onListening);
          server = null;
          serverStart = null;
          reject(error);
        }
        function onListening() {
          server.removeListener('error', onError);
          if (server.address() && server.address().port) port = server.address().port;
          console.log('[hongguo-webos] HTTP service listening on ' + bindHost + ':' + port);
          resolve(server);
        }
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, bindHost);
      }).then(function (value) {
        serverStart = null;
        return value;
      }, function (error) {
        serverStart = null;
        if (server && !server.listening) server = null;
        console.error('[hongguo-webos] HTTP server error', error && error.stack || error);
        throw error;
      });
      return serverStart;
    }

    function ensureReady() {
      // Storage failure should be reported by playback, without taking down
      // search, account, and other non-media APIs.
      try { if (provider.startCache) provider.startCache(); }
      catch (error) { console.warn('[hongguo-webos] media cache unavailable:', error && error.code || 'CACHE_INIT'); }
      return Promise.all([ensureActivity(), ensureServer()]);
    }

    function completeActivity() {
      var manager = luna.activityManager;
      var previous = activity;
      activity = null;
      activityStart = null;
      if (!previous || !manager || typeof manager.complete !== 'function') return Promise.resolve();
      return new Promise(function (resolve) {
        var finished = false;
        var timer = setTimeout(function () { if (!finished) { finished = true; resolve(); } }, 3000);
        try {
          manager.complete(previous, function () {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve();
          });
        } catch (error) {
          clearTimeout(timer);
          console.error('[hongguo-webos] activity complete failed:', error && error.stack || error);
          resolve();
        }
      });
    }

    function stopServer() {
      if (account.close) account.close();
      if (provider.closeCache) provider.closeCache();
      if (!server || !server.listening) { server = null; return Promise.resolve(); }
      var previous = server;
      server = null;
      return new Promise(function (resolve) {
        previous.close(function (error) {
          if (error) console.error('[hongguo-webos] HTTP server close failed:', error.message || error);
          resolve();
        });
      });
    }

    function respondWhenReady(message, includeStatus) {
      ensureReady().then(function () {
        var status = statusPayload();
        message.respond(Object.assign({ returnValue: true }, includeStatus ? { status: status } : status));
      }, function (error) {
        console.error('[hongguo-webos] service startup failed:', error && error.stack || error);
        var details = errorPayload(error, error && error.stage);
        message.respond(Object.assign({ returnValue: false }, details));
      });
    }

    luna.register('ping', function (message) { respondWhenReady(message, false); });
    luna.register('getDiagnostics', function (message) { respondWhenReady(message, true); });
    luna.register('shutdown', function (message) {
      numberInput.close();
      stopServer().then(completeActivity).then(function () { message.respond({ returnValue: true }); });
    });

    return { ensureReady: ensureReady, status: statusPayload, address: function () { return server && server.address(); }, shutdown: function () { numberInput.close(); return stopServer().then(completeActivity); } };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createService;
  if (typeof require !== 'undefined' && require.main === module) {
    process.on('uncaughtException', function (error) { console.error('[hongguo-webos] uncaughtException', error && error.stack || error); });
    process.on('unhandledRejection', function (error) { console.error('[hongguo-webos] unhandledRejection', error && error.stack || error); });
    createService();
  }
}());
