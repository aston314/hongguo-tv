'use strict';

var assert = require('assert');
var fs = require('fs');
var http = require('http');
var path = require('path');
var createService = require('./service');
var createNumberInput = require('./number-input');

var handlers = {};
var activityCalls = [];
var libraryChanges = [];
var prepareRequests = [];
var cacheSessionRequests = [];
var updateChecks = 0;
var luna = {
  activityManager: {
    create: function (name, callback) { activityCalls.push('create:' + name); callback({ id: 'activity-1' }); },
    complete: function (activity, callback) { activityCalls.push('complete:' + activity.id); callback(); }
  },
  register: function (name, handler) { handlers[name] = handler; }
};
var provider = {
  recommend: function () { return Promise.resolve({ items: [{ series_id: '1' }] }); },
  newSeries: function () { return Promise.resolve({ items: [], has_more: false }); },
  category: function () { return Promise.resolve({ items: [], has_more: false }); },
  rank: function () { return Promise.resolve({ items: [] }); },
  search: function () { return Promise.resolve({ items: [] }); },
  calendar: function () { return Promise.resolve({ items: [], calendar: {} }); },
  detail: function (seriesID) { return Promise.resolve({ series_id: seriesID, title: 'fixture' }); },
  seasons: function (seriesID) { return Promise.resolve({ items: [{ series_id: seriesID, season_index: 1, playable: true }] }); },
  nextSeason: function (seriesID) { return Promise.resolve({ current_season: 1, next: null, series_id: seriesID }); },
  suggestions: function () { return Promise.resolve({ items: [] }); },
  actorWorks: function () { return Promise.resolve({ actor: {}, items: [] }); },
  radar: function () { return Promise.resolve({ ranks: {}, growth: {} }); },
  engagement: function () { return Promise.resolve({ series_id: '1', vid: '2' }); },
  prepare: function (seriesID, vid, quality, fallback, mode, prefetch) { prepareRequests.push({ mode: mode || '', prefetch: !!prefetch }); return Promise.resolve({ series_id: seriesID, vid: vid, path: '/media/test.mp4', mode: mode || 'full' }); },
  serveMedia: function (_, res) { res.statusCode = 206; res.end(JSON.stringify({ ok: true })); },
  discussion: function () { return Promise.resolve({ items: [], has_more: false, total: 0 }); },
  replies: function () { return Promise.resolve({ items: [], has_more: false, total: 0 }); },
  mediaDiagnostics: function () { return { media_prepared: false, media_state: 'none' }; },
  cacheSession: function (body) { cacheSessionRequests.push(body); return { session: 'cache-session', accepted: true }; },
  videoModelDiagnostics: function () { return { stage: 'idle', code: 'NOT_RUN' }; },
  foregroundVideoModelDiagnostics: function () { return { stage: 'multi_video_model', code: 'VIDEO_MODEL_EMPTY', response_bytes: 0 }; },
  library: function () { return { version: 1, entries: [], owner_id: '' }; },
  changeLibrary: function (change) { libraryChanges.push(change); return { version: 1, entries: [], owner_id: '' }; },
  searchHistory: function () { return { items: [], limit: 10 }; }
};
var accountStatus = { logged_in: false, profile: null, app_code_available: false };
var account = {
  status: function () { return accountStatus; },
  librarySnapshot: function () { return { version: 1, entries: [], owner_id: accountStatus.logged_in ? '123' : '' }; },
  changeLibrary: function () { return { version: 1, entries: [], owner_id: '123' }; },
  setFollow: function () { return Promise.resolve({ accepted: true }); },
  playerAction: function () { return Promise.resolve({ accepted: true }); },
  sendCode: function () { accountStatus.app_code_available = true; var error = new Error('设备注册连接失败，请稍后重试'); error.status = 400; error.code = 'ACCOUNT_DEVICE'; throw error; },
  loginSMS: function () { return Promise.resolve(accountStatus); },
  verify: function () { return Promise.resolve(accountStatus); },
  cancel: function () { return accountStatus; },
  logout: function () { return accountStatus; },
  sync: function () { return Promise.resolve(accountStatus); },
  importHistory: function () { return Promise.resolve({ status: accountStatus, import_history: { imported: 2, remaining: 1 } }); },
  reservations: function () { var error = new Error('请先登录'); error.status = 401; error.code = 'ACCOUNT_REQUIRED'; return Promise.reject(error); },
  follow: function () { var error = new Error('请先登录'); error.status = 401; error.code = 'ACCOUNT_REQUIRED'; return Promise.reject(error); },
  recommend: function () { return Promise.resolve({ items: [{ series_id: '1' }] }); },
  reserve: function () { return Promise.resolve({ accepted: true, confirmed: false }); },
  notifications: function () { var error = new Error('请先登录'); error.status = 401; error.code = 'ACCOUNT_REQUIRED'; return Promise.reject(error); },
  markNotifications: function () { var error = new Error('请先登录'); error.status = 401; error.code = 'ACCOUNT_REQUIRED'; throw error; }
};
account.recommend = function (query) {
  if (!accountStatus.logged_in) { var error = new Error('请先登录'); error.status = 401; error.code = 'ACCOUNT_REQUIRED'; return Promise.reject(error); }
  return Promise.resolve({ items: [{ series_id: '45', title: '追更剧' }], channel: query.channel });
};
var numberInput = createNumberInput({ selectIP: function () { return '127.0.0.1'; }, ttl: 30000 });
var service = createService({ service: luna, provider: provider, account: account, numberInput: numberInput, port: 0,
  updates: { check: function () { updateChecks++; return Promise.resolve({ schema: 1, platform: 'webos', version_name: '0.2.118' }); } } });
var registry = require('./services.json');

function invoke(name) {
  return new Promise(function (resolve) {
    handlers[name]({ respond: resolve });
  });
}

function request(method, pathName, headers, body) {
  return new Promise(function (resolve, reject) {
    var options = { host: '127.0.0.1', port: service.address().port, method: method, path: pathName, headers: Object.assign({}, headers || {}) };
    if (body) { options.headers['Content-Type'] = 'application/json'; options.headers['Content-Length'] = Buffer.byteLength(body); }
    var req = http.request(options, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  var registeredCommands = registry.services[0].commands;
  ['ping', 'getDiagnostics', 'shutdown'].forEach(function (name) {
    var command = registeredCommands.filter(function (entry) { return entry.name === name; })[0];
    assert(command, name + ' is declared in services.json');
    assert.strictEqual(command.public, true, name + ' is public to the app');
  });

  var ping = await invoke('ping');
  assert.strictEqual(ping.returnValue, true);
  assert.strictEqual(ping.ok, true);
  assert.strictEqual(ping.ready, true);
  assert.deepStrictEqual(activityCalls, ['create:hongguo-webos-http']);
  provider.startCache = function () { var error = new Error('storage unavailable'); error.code = 'EACCES'; throw error; };
  assert.strictEqual((await invoke('ping')).ready, true, 'storage failure does not disable unrelated APIs');
  delete provider.startCache;

  var status = await request('GET', '/api/v1/status', { Origin: 'null' });
  assert.strictEqual(status.status, 200);
  assert.strictEqual(JSON.parse(status.body).ok, true);
  assert.strictEqual(JSON.parse(status.body).ready, true);
  assert.strictEqual(status.headers['access-control-allow-origin'], 'null');
  var update = await request('GET', '/api/v1/webos/update');
  assert.strictEqual(JSON.parse(update.body).data.version_name, '0.2.118');
  assert.strictEqual(updateChecks, 1);
  assert.strictEqual((await request('POST', '/api/v1/webos/update')).status, 405);

  var preflight = await request('OPTIONS', '/api/v1/library', {
    Origin: 'null',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type'
  });
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers['access-control-allow-origin'], 'null');
  assert(preflight.headers['access-control-allow-methods'].indexOf('POST') >= 0);
  assert(preflight.headers['access-control-allow-methods'].indexOf('DELETE') >= 0);
  assert.strictEqual(preflight.headers['access-control-allow-private-network'], 'true');

  var blockedOrigin = await request('GET', '/api/v1/status', { Origin: 'https://example.test' });
  assert.strictEqual(blockedOrigin.headers['access-control-allow-origin'], undefined, 'remote origins cannot read the local service');

  var rangePrepare = await request('GET', '/api/v1/play/info?series_id=1&vid=2&mode=range');
  var cacheOpen = await request('POST', '/api/v1/player/cache-session', { Origin: 'null' }, JSON.stringify({ action: 'open' }));
  assert.strictEqual(cacheOpen.status, 200);
  assert.strictEqual(JSON.parse(cacheOpen.body).data.session, 'cache-session');
  assert.strictEqual(cacheSessionRequests[0].action, 'open');
  assert.strictEqual((await request('GET', '/api/v1/player/cache-session')).status, 405);
  assert.strictEqual((await request('POST', '/api/v1/player/cache-session', {}, '{broken')).status, 400);
  assert.strictEqual(JSON.parse(rangePrepare.body).data.mode, 'range');
  assert.deepStrictEqual(prepareRequests[0], { mode: 'range', prefetch: false }, 'playback mode is forwarded to the provider');
  await request('GET', '/api/v1/play/info?series_id=1&vid=3&mode=range&prefetch=1');
  assert.deepStrictEqual(prepareRequests[1], { mode: 'range', prefetch: true }, 'speculative Range preparation is marked so it cannot download the full episode');

  var recommendations = await request('GET', '/api/v1/lists/recommend?offset=0');
  assert.strictEqual(JSON.parse(recommendations.body).data.items[0].series_id, '1');
  var loggedOutFollowRecommendations = await request('GET', '/api/v1/lists/recommend?channel=45');
  assert.strictEqual(loggedOutFollowRecommendations.status, 401, 'channel 45 requires the same account state as the main app');
  accountStatus.logged_in = true;
  var followRecommendations = await request('GET', '/api/v1/lists/recommend?channel=45');
  assert.strictEqual(JSON.parse(followRecommendations.body).data.items[0].title, '追更剧');
  accountStatus.logged_in = false;

  var uiAPIPaths = [
    ['/api/v1/category', 'GET'], ['/api/v1/lists/new', 'GET'], ['/api/v1/lists/rank', 'GET'],
    ['/api/v1/lists/search?q=x', 'GET'], ['/api/v1/lists/calendar', 'GET'],
    ['/api/v1/series/detail?series_id=1', 'GET'], ['/api/v1/series/seasons?series_id=1', 'GET'],
    ['/api/v1/series/next-season?series_id=1', 'GET'], ['/api/v1/search/suggestions?q=x', 'GET'],
    ['/api/v1/actors/works?actor_id=1', 'GET'], ['/api/v1/radar', 'GET'],
    ['/api/v1/player/stats?series_id=1&vid=2', 'GET'], ['/api/v1/play/info?series_id=1&vid=2', 'GET'],
    ['/api/v1/comments?series_id=1&vid=2', 'GET'], ['/api/v1/danmaku?series_id=1&vid=2', 'GET'],
    ['/api/v1/replies?series_id=1&vid=2&comment_id=3', 'GET'], ['/api/v1/player/diagnostics', 'GET'],
    ['/api/v1/library', 'GET'], ['/api/v1/account', 'GET'], ['/api/v1/search-history', 'GET'],
    ['/api/v1/notifications', 'GET'], ['/api/v1/follow', 'GET'], ['/api/v1/lists/reservations', 'GET']
  ];
  for (var uiIndex = 0; uiIndex < uiAPIPaths.length; uiIndex++) {
    var uiResponse = await request(uiAPIPaths[uiIndex][1], uiAPIPaths[uiIndex][0]);
    assert.notStrictEqual(uiResponse.status, 404, 'shared UI endpoint route exists: ' + uiAPIPaths[uiIndex][0]);
    if (uiResponse.status < 400) assert.strictEqual(JSON.parse(uiResponse.body).ok, true, uiAPIPaths[uiIndex][0]);
  }

  var legacyAPIPaths = [
    '/api/v1/Category', '/api/v1/rank', '/api/v1/Rank', '/api/v1/search?q=x',
    '/api/v1/Search?q=x', '/api/v1/SeriesDetail?series_id=1', '/api/v1/PlayInfo?series_id=1&vid=2'
  ];
  for (var legacyIndex = 0; legacyIndex < legacyAPIPaths.length; legacyIndex++) {
    var legacy = await request('GET', legacyAPIPaths[legacyIndex]);
    assert.strictEqual(legacy.status, 200, 'Go compatibility route: ' + legacyAPIPaths[legacyIndex]);
  }

  var goMain = fs.readFileSync(path.join(__dirname, '../../core/cmd/hongguotv/main.go'), 'utf8');
  var goRoutes = [];
  goMain.replace(/mux\.HandleFunc\("([^"]+)"/g, function (_, route) { if (route.indexOf('/api/') === 0 || route.indexOf('/minireel-proxy/') === 0) goRoutes.push(route); return _; });
  assert(goRoutes.length >= 25, 'Go core route inventory should not unexpectedly shrink');
  for (var goIndex = 0; goIndex < goRoutes.length; goIndex++) {
    var goRoute = goRoutes[goIndex];
    var probePath = goRoute;
    if (goRoute === '/api/v1/lists/') probePath = '/api/v1/lists/new';
    if (goRoute === '/api/v1/account/') probePath = '/api/v1/account';
    if (goRoute === '/minireel-proxy/media/') probePath = '/minireel-proxy/media/' + 'a'.repeat(24) + '.mp4';
    var goResponse = await request('GET', probePath);
    assert.notStrictEqual(goResponse.status, 404, 'Go API route remains reachable in webOS: ' + goRoute);
    assert.notStrictEqual(goResponse.status, 501, 'Go API route is implemented in webOS: ' + goRoute);
    assert.notStrictEqual(JSON.parse(goResponse.body).error, 'WEBOS_PROVIDER_NOT_IMPLEMENTED', 'Go API route is not a placeholder in webOS: ' + goRoute);
  }

  var comments = await request('GET', '/api/v1/comments?series_id=1&vid=2');
  assert.strictEqual(comments.status, 200);
  assert.strictEqual(JSON.parse(comments.body).data.total, 0);
  var replies = await request('GET', '/api/v1/replies?series_id=1&vid=2&comment_id=3');
  assert.strictEqual(replies.status, 200);
  var playerDiagnostics = await request('GET', '/api/v1/player/diagnostics?media=%2Fminireel-proxy%2Fmedia%2Faaaaaaaaaaaaaaaaaaaaaaaa.mp4');
  assert.strictEqual(playerDiagnostics.status, 200);
  assert.strictEqual(JSON.parse(playerDiagnostics.body).data.media_state, 'none');

  var library = await request('GET', '/api/v1/library');
  assert.strictEqual(JSON.parse(library.body).data.owner_id, '');
  var staleLibrary = await request('POST', '/api/v1/library', {}, JSON.stringify({ owner_id: 'stale-user', action: 'clear', kind: 'history' }));
  assert.strictEqual(staleLibrary.status, 409);
  var sendCode = await request('POST', '/api/v1/account/send-code', {}, JSON.stringify({ country_code: '+86', phone: '13800138000' }));
  var sendCodePayload = JSON.parse(sendCode.body);
  assert.strictEqual(sendCode.status, 400);
  assert.strictEqual(sendCodePayload.data.app_code_available, true);
  assert.strictEqual(sendCodePayload.message, '设备注册连接失败，请稍后重试');
  var importHistory = await request('POST', '/api/v1/account/import-history', {}, JSON.stringify({ owner_id: '123' }));
  assert.deepStrictEqual(JSON.parse(importHistory.body).import_history, { imported: 2, remaining: 1 });
  for (var accountAction of ['login', 'verify', 'cancel', 'logout', 'sync']) {
    var accountResponse = await request('POST', '/api/v1/account/' + accountAction, {}, JSON.stringify({ country_code: '+86', phone: '13800138000', code: '012345' }));
    assert.strictEqual(accountResponse.status, 200, 'account route ' + accountAction);
  }
  var followWrite = await request('POST', '/api/v1/follow', {}, JSON.stringify({ series_id: '1', enabled: true }));
  assert.strictEqual(followWrite.status, 200);
  var playerWrite = await request('POST', '/api/v1/player/action', {}, JSON.stringify({ action: 'comment', series_id: '1', vid: '2', text: 'fixture' }));
  assert.strictEqual(playerWrite.status, 200);
  var markNotifications = await request('POST', '/api/v1/notifications', {}, JSON.stringify({ id: '1' }));
  assert.strictEqual(markNotifications.status, 401);
  var libraryWrite = await request('POST', '/api/v1/library', {}, JSON.stringify({ action: 'favorite', drama: { series_id: '1', title: 'fixture' }, value: true }));
  assert.strictEqual(libraryWrite.status, 200);
  var guestLike = await request('POST', '/api/v1/library', {}, JSON.stringify({ action: 'like', drama: { series_id: '1', title: 'fixture' }, video_id: '2', episode: 1, value: true }));
  assert.strictEqual(guestLike.status, 200);
  assert.strictEqual(libraryChanges[libraryChanges.length - 1].action, 'like', 'guest video-like uses the local library adapter');
  var guestUnlike = await request('POST', '/api/v1/library', {}, JSON.stringify({ action: 'like', drama: { series_id: '1', title: 'fixture' }, video_id: '2', episode: 1, value: false }));
  assert.strictEqual(guestUnlike.status, 200);
  var historyWrite = await request('POST', '/api/v1/search-history', {}, JSON.stringify({ query: 'fixture' }));
  assert.strictEqual(historyWrite.status, 200);
  var historyClear = await request('DELETE', '/api/v1/search-history');
  assert.strictEqual(historyClear.status, 200);
  var reservation = await request('POST', '/api/v1/reservation', {}, JSON.stringify({ item_id: '1234567890123456789', reserved: true }));
  assert.deepStrictEqual(JSON.parse(reservation.body).data, { accepted: true, confirmed: false });
  var numberInput = await request('POST', '/api/v1/number-input', {}, JSON.stringify({ kind: 'search' }));
  assert.strictEqual(numberInput.status, 200);
  var numberPayload = JSON.parse(numberInput.body).data;
  assert.strictEqual(numberPayload.state, 'waiting');
  assert(/^data:image\/svg\+xml;base64,/.test(numberPayload.qr));
  var numberPoll = await request('GET', '/api/v1/number-input?session=' + numberPayload.session);
  assert.strictEqual(JSON.parse(numberPoll.body).data.state, 'waiting');
  var numberCancel = await request('DELETE', '/api/v1/number-input?session=' + numberPayload.session);
  assert.strictEqual(JSON.parse(numberCancel.body).data.state, 'expired');
  var loggedOutReservations = await request('GET', '/api/v1/lists/reservations');
  assert.strictEqual(loggedOutReservations.status, 401);

  var diagnostics = await request('GET', '/api/v1/diagnostics');
  assert.strictEqual(JSON.parse(diagnostics.body).ready, true);
  assert.strictEqual(JSON.parse(diagnostics.body).lastStartupError, null);
  assert.deepStrictEqual(JSON.parse(diagnostics.body).video_model, { stage: 'multi_video_model', code: 'VIDEO_MODEL_EMPTY', response_bytes: 0 }, 'support diagnostics select the foreground report instead of the last speculative request');

  var stopped = await invoke('shutdown');
  assert.strictEqual(stopped.returnValue, true);
  assert(activityCalls.indexOf('complete:activity-1') >= 0);

  var occupied = require('net').createServer();
  await new Promise(function (resolve) { occupied.listen(0, '127.0.0.1', resolve); });
  var blockedHandlers = {};
  var blockedService = createService({
    service: {
      activityManager: { create: function (_, callback) { callback(null); }, complete: function (_, callback) { callback(); } },
      register: function (name, handler) { blockedHandlers[name] = handler; }
    },
    provider: provider,
    account: account,
    port: occupied.address().port
  });
  var blocked = await new Promise(function (resolve) { blockedHandlers.ping({ respond: resolve }); });
  assert.strictEqual(blocked.returnValue, false);
  assert.strictEqual(blocked.ready, false);
  assert.strictEqual(blocked.stage, 'http_bind');
  assert.strictEqual(blocked.code, 'EADDRINUSE');
  await blockedService.shutdown();
  await new Promise(function (resolve) { occupied.close(resolve); });
  console.log('webOS service lifecycle and CORS: PASS');
}

run().catch(function (error) {
  service.shutdown().then(function () { console.error(error.stack || error); process.exitCode = 1; });
});
