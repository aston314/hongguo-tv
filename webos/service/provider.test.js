'use strict';

var assert = require('assert');
var crypto = require('crypto');
var EventEmitter = require('events');
var PassThrough = require('stream').PassThrough;
var http = require('http');
var https = require('https');
var fs = require('fs');
var os = require('os');
var path = require('path');
var rangeMedia = require('./range-media');
var originalDownloadFile = rangeMedia.downloadFile;
var originalRequest = https.request;
var dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-webos-provider-'));
process.env.HONGGUO_WEBOS_DATA_DIR = dataRoot;
process.env.HONGGUO_WEBOS_CACHE_DIR = dataRoot;
var seriesID = '1234567890123456789';
var categoryRequest = null;
var calendarRequest = null;
var engagementRequests = [];
var videoModelRequests = 0;
var playbackRequests = [];
var deviceRegisterRequests = 0;
var deviceRegisterFailures = 0;
var deviceRegistration = null;
var videoModelEmptyResponses = 0;
var videoModelFallback = '';
var fallbackRequests = [];
var fallbackStatus = 200;
var fallbackLocation = '';
var fallbackResponseBody = '';
var mediaDownloadRequests = 0;
var videoSpade = '';
var videoModelStatus = 200;
var html = '<script>window._ROUTER_DATA=' + JSON.stringify({ loaderData: { detail_page: {
  seriesDetail: {
    series_id: seriesID,
    series_name: '接口回归短剧',
    episode_cnt: 2,
    accessible_episode_cnt: 1,
    vid_list: ['2234567890123456789', '3234567890123456789'],
    celebrities: [
      { celebrity_id: '7377326001203713305', nickname: '测试演员', avatar: 'https://example.test/actor.jpg' },
      { celebrity_id: '7377326001203713305', nickname: '重复演员' },
      { user_info: { base_info: { actor_id_str: '7400000000000000001', user_name: '嵌套演员' } } }
    ]
  },
  social: {
    related_list: [
      { series_id: '4234567890123456789', series_title: '相关推荐', episode_cnt: 4 },
      { series_id: seriesID, series_title: '当前短剧' }
    ],
    reviews: [
      { review_id: '7', user_name: '观众', content: '真实剧评', rating: 9, digg_count: 5 }
    ]
  }
} } }) + ';</script>';

https.request = function (options) {
  var req = new EventEmitter();
  var requestChunks = [];
  req.write = function (chunk) { requestChunks.push(Buffer.from(chunk)); };
  req.destroy = function (error) { if (error) process.nextTick(function () { req.emit('error', error); }); };
  req.end = function () {
    var body = html;
    var responseStatus = 200;
    if (options.path.indexOf('/service/2/device_register/') >= 0) {
      deviceRegisterRequests++;
      deviceRegistration = { options: options, query: Object.fromEntries(new URL('https://fixture.test' + options.path).searchParams), body: Buffer.concat(requestChunks) };
      body = JSON.stringify({ device_id_str: '1234567890123456789', install_id_str: '2234567890123456789' });
      if (deviceRegisterFailures > 0) { deviceRegisterFailures--; responseStatus = 503; }
    }
    if (options.path.indexOf('/novel/player/multi_video_model/v1/') >= 0) {
      videoModelRequests++;
      var playbackQuery = Object.fromEntries(new URL('https://fixture.test' + options.path).searchParams);
      var playbackBody = JSON.parse(Buffer.concat(requestChunks).toString('utf8'));
      playbackRequests.push({ options: options, query: playbackQuery, body: playbackBody });
      var videoID = playbackBody.mixed_video_id_map['1004'][0], entry = {};
      if (videoModelFallback) entry[videoID] = { video_model: { fallback_api: videoModelFallback } };
      else entry[videoID] = { video_model: { video_list: [{ main_url: 'https://media.example.test/episode.mp4', video_meta: { vheight: 720, definition: '720P' }, encrypt_info: videoSpade ? { spade_a: videoSpade } : {} }] } };
      if (videoModelEmptyResponses > 0) { videoModelEmptyResponses--; body = ''; }
      else body = JSON.stringify({ code: 0, data: entry });
    }
    if (options.path.indexOf('/playback/fallback') >= 0) {
      fallbackRequests.push({ options: options, headers: options.headers, path: options.path });
      responseStatus = fallbackStatus;
      body = fallbackResponseBody;
    }
    if (options.path.indexOf('/reading/bookapi/plan/v') >= 0) body = '{"code":0,"data":[]}';
    if (options.path.indexOf('/reading/distribution/category/landpage/v/') >= 0) {
      categoryRequest = { options: options, query: Object.fromEntries(new URL('https://fixture.test' + options.path).searchParams), body: Buffer.concat(requestChunks).toString('utf8') };
      body = JSON.stringify({ code: 0, data: { has_more: true, next_offset: 15, session_id: 'category-session', video_data: [{ series_id: seriesID, series_title: '真实分类剧', episode_cnt: 12, vid: '2234567890123456789', tags: ['悬疑'] }], selector_rows: [] } });
    }
    if (options.path.indexOf('/reading/user/subscribe/list/v1/') >= 0) {
      calendarRequest = { options: options, query: Object.fromEntries(new URL('https://fixture.test' + options.path).searchParams) };
      body = JSON.stringify({ code: 0, data: { has_more: false, next_offset: 0, subscribe_items: [{ item_id: '4234567890123456789', name: '待上线剧', cover: 'https://example.test/cover.jpg', item_desc: '简介', categories: ['都市'] }] } });
    }
    if (options.path.indexOf('/novel/player/multi_video_detail/preload/v1') >= 0) {
      var parsedRequest = new URL('https://fixture.test' + options.path);
      engagementRequests.push({ options: options, query: Object.fromEntries(parsedRequest.searchParams), body: Buffer.concat(requestChunks).toString('utf8') });
      body = engagementRequests.length === 1 ? '' : JSON.stringify({ code: 0, data: {} });
      var engagementData = {};
      engagementData[seriesID] = { video_data: { series_id_str: seriesID, followed_cnt: 19, video_list: [{ vid: '2234567890123456789', digged_count: 7, comment_count: 4, episode_cover: 'https://example.test/episode.jpg' }] } };
      if (engagementRequests.length > 1) body = JSON.stringify({ code: 0, data: engagementData });
    }
    process.nextTick(function () {
      var response = new PassThrough();
      response.statusCode = options.path.indexOf('/novel/player/multi_video_model/v1/') >= 0 ? videoModelStatus : responseStatus;
      if (fallbackLocation && options.path.indexOf('/playback/fallback') >= 0) response.headers = { location: fallbackLocation };
      req.emit('response', response);
      response.end(body);
    });
  };
  return req;
};

var provider = require('./provider');
rangeMedia.downloadFile = function (_, destination) {
  mediaDownloadRequests++;
  fs.writeFileSync(destination, Buffer.from('full-media-fixture'));
  return Promise.resolve();
};

function requestMedia(server, method, range, ifRange) {
  return new Promise(function (resolve, reject) {
    var headers = {};
    if (range) headers.Range = range;
    if (ifRange) headers['If-Range'] = ifRange;
    var request = http.request({ host: '127.0.0.1', port: server.address().port, method: method, path: '/media', headers: headers }, function (response) {
      var chunks = [];
      response.on('data', function (chunk) { chunks.push(chunk); });
      response.on('end', function () { resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }); });
    });
    request.on('error', reject);
    request.end();
  });
}

async function testMediaRangeProxy() {
  var token = '0123456789abcdef01234567';
  var mediaDir = path.join(dataRoot, token);
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, token + '.mp4'), Buffer.from('abcdefghij'));
  var server = http.createServer(function (request, response) {
    provider.serveMedia(request, response, token);
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  try {
    var bounded = await requestMedia(server, 'GET', 'bytes=2-5');
    assert.strictEqual(bounded.status, 206);
    assert.strictEqual(bounded.headers['content-range'], 'bytes 2-5/10');
    assert.strictEqual(bounded.headers['content-length'], '4');
    assert.strictEqual(bounded.body.toString(), 'cdef');
    assert(bounded.headers.etag, 'the cached media has a validator for If-Range');

    var suffix = await requestMedia(server, 'GET', 'bytes=-3');
    assert.strictEqual(suffix.status, 206);
    assert.strictEqual(suffix.headers['content-range'], 'bytes 7-9/10');
    assert.strictEqual(suffix.body.toString(), 'hij');

    var matchingIfRange = await requestMedia(server, 'GET', 'bytes=0-1', bounded.headers.etag);
    assert.strictEqual(matchingIfRange.status, 206);
    assert.strictEqual(matchingIfRange.body.toString(), 'ab');

    var staleIfRange = await requestMedia(server, 'GET', 'bytes=0-1', '"stale"');
    assert.strictEqual(staleIfRange.status, 200);
    assert.strictEqual(staleIfRange.headers['content-range'], undefined);
    assert.strictEqual(staleIfRange.body.toString(), 'abcdefghij');

    var head = await requestMedia(server, 'HEAD', 'bytes=1-3');
    assert.strictEqual(head.status, 206);
    assert.strictEqual(head.headers['content-length'], '3');
    assert.strictEqual(head.body.length, 0);

    var invalid = await requestMedia(server, 'GET', 'bytes=0-1,4-5');
    assert.strictEqual(invalid.status, 416);
    assert.strictEqual(invalid.headers['content-range'], 'bytes */10');

    // No HTTP stream remains open while paused. Explicit playback still pins
    // this file when a later cleanup evicts other legacy media by size.
    var session = provider.cacheSession({ action: 'open' }).session;
    provider.cacheSession({ action: 'update', session: session, revision: 1, token: token });
    var old = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    fs.mkdirSync(path.join(dataRoot, old));
    fs.writeFileSync(path.join(dataRoot, old, old + '.mp4'), '');
    fs.truncateSync(path.join(dataRoot, old, old + '.mp4'), 512 * 1024 * 1024);
    provider.cacheSession({ action: 'update', session: session, revision: 2, token: token });
    assert(!fs.existsSync(path.join(dataRoot, old, old + '.mp4')), 'capacity cleanup removes the unoccupied legacy file');
    var resumed = await requestMedia(server, 'GET', 'bytes=4-7', bounded.headers.etag);
    assert.strictEqual(resumed.status, 206);
    assert.strictEqual(resumed.body.toString(), 'efgh', 'pause and seek retain the original cached bytes');
    assert.strictEqual(resumed.headers.etag, bounded.headers.etag, 'last-use updates never invalidate If-Range');
    provider.cacheSession({ action: 'close', session: session });
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
}

async function run() {
  try {
    assert.deepStrictEqual(provider.parseMediaByteRange('bytes=-2', 10), { start: 8, end: 9, partial: true });
    assert.strictEqual(provider.parseMediaByteRange('bytes=0-1,4-5', 10), null);
    await testMediaRangeProxy();

    var detail = await provider.detail(seriesID);
    assert.strictEqual(detail.episodes.length, 2);
    assert.strictEqual(detail.episodes[1].locked, true);
    assert.strictEqual(detail.episodes[1].locked_inferred, true, 'the UI lock is marked as inferred from the aggregate access count');
    assert.deepStrictEqual(detail.actors.map(function (actor) { return actor.id; }), ['7377326001203713305', '7400000000000000001']);
    assert.strictEqual(detail.actors[0].name, '测试演员');
    assert.strictEqual(detail.actors[0].avatar, 'https://example.test/actor.jpg');
    assert.strictEqual(detail.related.length, 1);
    assert.strictEqual(detail.related[0].series_id, '4234567890123456789');
    assert.strictEqual(detail.reviews[0].content, '真实剧评');
    assert.strictEqual(detail.reviews[0].rating, 9);

    var category = await provider.category('/category/real-drama', 0, {}, false);
    assert.strictEqual(category.items.length, 1);
    assert.strictEqual(category.items[0].title, '真实分类剧');
    assert.strictEqual(category.has_more, true);
    assert(categoryRequest, 'category endpoint was requested');
    assert.strictEqual(categoryRequest.options.method, 'POST');
    assert(categoryRequest.options.headers['X-Gorgon'], 'category request is signed');
    assert(categoryRequest.options.headers['X-Medusa'], 'category request includes Passport signature');
    assert(categoryRequest.query.device_id && categoryRequest.query.iid, 'category uses a fresh device identity');
    var categoryBody = JSON.parse(categoryRequest.body);
    assert.strictEqual(categoryBody.req_scene, 'default');
    assert.strictEqual(categoryBody.req_type, 'only_content');

    var calendar = await provider.calendar({ offset: 0 });
    assert.strictEqual(calendar.items.length, 1);
    assert.strictEqual(calendar.items[0].title, '待上线剧');
    assert.deepStrictEqual(calendar.items[0].tags, ['都市']);
    assert(calendarRequest, 'calendar endpoint was requested');
    assert(calendarRequest.options.headers['X-Gorgon'], 'calendar request is signed');
    assert(calendarRequest.query.device_id && calendarRequest.query.iid, 'calendar uses a fresh device identity');
    assert.notStrictEqual(categoryRequest.query.device_id, calendarRequest.query.device_id, 'each API request gets a one-shot device identity');

    var stats = await provider.engagement(seriesID, '2234567890123456789');
    assert.strictEqual(stats.likes, 7);
    assert.strictEqual(stats.favorites, 19);
    assert.strictEqual(stats.comments, 4);
    assert.strictEqual(stats.episode_cover, 'https://example.test/episode.jpg');
    assert.strictEqual(engagementRequests.length, 2, 'an empty upstream response is retried');
    assert(engagementRequests[0].options.headers['X-Gorgon'] && engagementRequests[1].options.headers['X-Gorgon'], 'both attempts are signed');
    assert.notStrictEqual(engagementRequests[0].query.device_id, engagementRequests[1].query.device_id, 'retry uses a fresh device identity');

    var fullToken = crypto.createHash('sha256').update(seriesID + ':4234567890123456789').digest('hex').slice(0, 24);
    var rangeToken = crypto.createHash('sha256').update(fullToken + ':range').digest('hex').slice(0, 24);
    assert.notStrictEqual(rangeToken, fullToken, 'Range and full playback use independent local media tokens');
    deviceRegisterFailures = 1;
    var registrationFailure = await provider.inspectVideoModel('1234567890123456788');
    assert.strictEqual(registrationFailure.ok, false, 'device registration failure is reported as a playback preparation error');
    assert.strictEqual(registrationFailure.error.code, 'ACCOUNT_DEVICE');
    assert.strictEqual(deviceRegisterRequests, 1);

    var downloadsBeforePrefetch = mediaDownloadRequests;
    var prefetchError = await provider.prepare(seriesID, '4234567890123456789', '', false, 'range', true).then(function () { return null; }, function (error) { return error; });
    assert(prefetchError && /CENC key/.test(prefetchError.message), 'Range prefetch without a key fails quietly');
    assert.strictEqual(mediaDownloadRequests, downloadsBeforePrefetch, 'failed Range prefetch never downloads the full episode');
    assert.strictEqual(videoModelRequests, 1, 'prefetch resolves the episode source before rejecting unsupported Range');
    var rangeFallback = await provider.prepare(seriesID, '5234567890123456789', '', false, 'range', false);
    assert.strictEqual(rangeFallback.mode, 'full');
    assert(rangeFallback.range_fallback, 'foreground Range preparation reports its full-file fallback');
    assert.strictEqual(mediaDownloadRequests, downloadsBeforePrefetch + 1, 'foreground Range failure falls back to one full download');
    var fallbackToken = crypto.createHash('sha256').update(seriesID + ':5234567890123456789').digest('hex').slice(0, 24);
    assert.strictEqual(rangeFallback.path, '/minireel-proxy/media/' + fallbackToken + '.mp4', 'foreground fallback uses the standard full-file URL');
    assert.strictEqual(videoModelRequests, 2, 'foreground preparation performs a fresh source resolution');
    assert.strictEqual(rangeFallback.preparation_timing.media_mode, 'full');
    ['media_resolve_ms', 'media_range_init_ms', 'media_download_ms', 'media_decrypt_ms'].forEach(function (name) {
      assert(Number.isFinite(rangeFallback.preparation_timing[name]), 'fallback measures ' + name);
    });

    // A foreground request joining a failed speculative Range task may fall
    // back, while the speculative caller must still fail without downloading.
    var modelsBeforeJoin = videoModelRequests, downloadsBeforeJoin = mediaDownloadRequests;
    var speculative = provider.prepare(seriesID, '7234567890123456789', '', false, 'range', true).then(function () { throw Error('prefetch should fail'); }, function (error) { return error; });
    var foreground = provider.prepare(seriesID, '7234567890123456789', '', false, 'range', false);
    var joined = await Promise.all([speculative, foreground]);
    assert(/CENC key/.test(joined[0].message));
    assert.strictEqual(joined[1].mode, 'full');
    assert.strictEqual(joined[1].preparation_shared, true);
    assert.strictEqual(videoModelRequests - modelsBeforeJoin, 1, 'foreground and prefetch share the source resolution');
    assert.strictEqual(mediaDownloadRequests - downloadsBeforeJoin, 1, 'only foreground fallback downloads the full episode');

    // Construct a non-secret test key in the supported spade envelope.
    var decodedKey = Buffer.from('0' + '29'.repeat(16)), rawKey = Buffer.alloc(38), previous = [250, 85];
    for (var keyIndex = 0; keyIndex < decodedKey.length; keyIndex++) {
      var bitCount = keyIndex.toString(2).replace(/0/g, '').length;
      rawKey[keyIndex + 1] = ((decodedKey[keyIndex] + 21 + bitCount) & 255) ^ previous[keyIndex % 2];
      previous[keyIndex % 2] = rawKey[keyIndex + 1];
    }
    rawKey[0] = 52 ^ rawKey[1] ^ rawKey[2];
    var tagSeed = rawKey[32] ^ rawKey[33];
    Buffer.from('test').forEach(function (value, index) { rawKey[34 + index] = value ^ tagSeed; });
    videoSpade = rawKey.toString('base64');
    var originalOpen = rangeMedia.open, realNow = Date.now, rangeOpens = 0, resolveRange;
    rangeMedia.open = function () {
      rangeOpens++;
      var source = { prefix: Buffer.alloc(16), samples: [], key: Buffer.alloc(16), length: 128, etag: '"fixture"' };
      return rangeOpens === 1 ? new Promise(function (resolve) { resolveRange = function () { resolve(source); }; }) : Promise.resolve(source);
    };
    try {
      var beforeRangeModels = videoModelRequests;
      var rangePrefetch = provider.prepare(seriesID, '8234567890123456789', '', false, 'range', true);
      await new Promise(function (resolve) { setImmediate(resolve); });
      var rangeForeground = provider.prepare(seriesID, '8234567890123456789', '', false, 'range', false);
      assert.strictEqual(provider.mediaDiagnostics('').media_preparation_stage, 'range_init', 'pending preparation is diagnosable before a media path exists');
      assert.strictEqual(videoModelRequests - beforeRangeModels, 1);
      videoModelStatus = 502;
      await assert.rejects(provider.prepare(seriesID, '1134567890123456789', '', false, 'range', false));
      videoModelStatus = 200;
      resolveRange();
      var preparedRange = await Promise.all([rangePrefetch, rangeForeground]);
      assert.strictEqual(rangeOpens, 1, 'handoff shares the pending Range initialization');
      assert.strictEqual(provider.mediaDiagnostics('').media_preparation_error_stage, 'resolve', 'a late previous source cannot overwrite the latest foreground failure');
      assert.strictEqual(preparedRange[0].mode, 'range');
      assert.strictEqual(preparedRange[1].path, preparedRange[0].path);
      assert.strictEqual(preparedRange[1].preparation_shared, true);
      var cachedRange = await provider.prepare(seriesID, '8234567890123456789', '', false, 'range', false);
      assert.strictEqual(cachedRange.preparation_cached, true);
      assert.strictEqual(rangeOpens, 1);
      var diag = provider.mediaDiagnostics(preparedRange[0].path);
      assert.strictEqual(diag.media_mode, 'range');
      assert.strictEqual(diag.media_prepared, true);
      assert(Number.isFinite(diag.media_resolve_ms) && Number.isFinite(diag.media_range_init_ms));
      assert(!/media\.example|spade|292929|823456789/.test(JSON.stringify(preparedRange[0].preparation_timing)), 'timings contain no media URL, key or ID');
      var otherRange = await provider.prepare(seriesID, '1034567890123456789', '', false, 'range', true);
      var activeSession = provider.cacheSession({ action: 'open' }).session;
      provider.cacheSession({ action: 'update', session: activeSession, revision: 1, token: otherRange.path.split('/').pop().replace('.mp4', '') });
      var expiredAt = Date.now() + 120001;
      Date.now = function () { return expiredAt; };
      await provider.prepare(seriesID, '8234567890123456789', '', false, 'range', false);
      assert.strictEqual(rangeOpens, 3, 'an expired source is replaced within the two-source limit without evicting the active source');
      assert.strictEqual(mediaDownloadRequests - downloadsBeforeJoin, 1, 'Range preparation and refresh never download an entire episode');
    } finally {
      rangeMedia.open = originalOpen; Date.now = realNow; videoSpade = ''; videoModelStatus = 200;
      if (activeSession) provider.cacheSession({ action: 'close', session: activeSession });
    }
    videoModelStatus = 502;
    var beforeFailedDownload = mediaDownloadRequests;
    try {
      await assert.rejects(provider.prepare(seriesID, '9234567890123456789', '', false, 'range', false));
      var failedReport = provider.mediaDiagnostics('');
      assert.strictEqual(failedReport.media_preparation_error_stage, 'resolve');
      assert(Number.isFinite(failedReport.media_resolve_ms));
      assert.strictEqual(failedReport.media_range_init_ms, undefined);
      assert.strictEqual(mediaDownloadRequests, beforeFailedDownload, 'a video-model failure cannot start a full-file fallback');
    } finally { videoModelStatus = 200; }
    var diskDownload = rangeMedia.downloadFile;
    rangeMedia.downloadFile = function (_, destination) {
      fs.writeFileSync(destination, 'partial');
      var error = new Error('disk full'); error.code = 'ENOSPC'; return Promise.reject(error);
    };
    try {
      await assert.rejects(provider.prepare(seriesID, '6234567890123456789', '', true, 'full', false), function (error) { return error.status === 507 && error.code === 'MEDIA_CACHE_FULL'; });
      var failedToken = crypto.createHash('sha256').update(seriesID + ':6234567890123456789').digest('hex').slice(0, 24);
      assert(!fs.existsSync(path.join(dataRoot, failedToken)), 'disk-full cleanup removes only the failed download');
      assert(fs.existsSync(path.join(dataRoot, fallbackToken, fallbackToken + '.mp4')), 'disk-full failure preserves ready media');
    } finally { rangeMedia.downloadFile = diskDownload; }

    var seasons = await provider.seasons(seriesID);
    assert.strictEqual(seasons.source, 'webos-detail-fallback');
    assert.strictEqual(seasons.items.length, 1);
    assert.strictEqual(seasons.items[0].series_id, seriesID);
    assert.strictEqual(seasons.items[0].playable, true);

    var drama = { series_id: seriesID, title: '接口回归短剧' };
    var liked = provider.changeLibrary({ action: 'like', drama: drama, video_id: '2234567890123456789', episode: 1, value: true });
    assert.strictEqual(liked.entries[0].liked_videos[0].video_id, '2234567890123456789');
    assert.strictEqual(liked.entries[0].liked_at, liked.entries[0].liked_videos[0].liked_at);
    var unliked = provider.changeLibrary({ action: 'like', drama: drama, video_id: '2234567890123456789', episode: 1, value: false });
    assert.strictEqual(unliked.entries.length, 0);
    var dramaLike = provider.changeLibrary({ action: 'like', drama: drama, value: true });
    assert(dramaLike.entries[0].liked_at > 0, 'guest series-like behavior is retained');

    var beforeRetry = videoModelRequests;
    videoModelEmptyResponses = 2;
    var playbackProbe = await provider.inspectVideoModel('1334567890123456789');
    assert.strictEqual(playbackProbe.ok, true, 'registered playback request resolves after bounded empty-response retries');
    assert.strictEqual(videoModelRequests - beforeRetry, 3, 'empty playback responses retry with the same registered identity');
    assert.strictEqual(deviceRegisterRequests, 2, 'failed registration is retried once on the next playback request');
    assert(deviceRegistration, 'anonymous playback identity was registered before the playback request');
    assert.strictEqual(deviceRegistration.options.headers.Cookie || '', '', 'anonymous playback registration has no account cookies');
    assert.strictEqual(deviceRegistration.options.headers['X-Tt-Token'] || '', '', 'anonymous playback registration has no account token');
    assert.strictEqual(deviceRegistration.query.device_id || '', '', 'registration does not send a fabricated device id');
    assert.strictEqual(deviceRegistration.query.iid || '', '', 'registration does not send a fabricated install id');
    var playbackIdentity = playbackRequests[0].query;
    assert(playbackIdentity.device_id && playbackIdentity.iid && playbackIdentity.cdid, 'playback uses the registered identity');
    playbackRequests.forEach(function (call) {
      assert.strictEqual(call.options.path.split('?')[0], '/novel/player/multi_video_model/v1/');
      assert.strictEqual(call.query.device_id, playbackIdentity.device_id, 'playback identity stays stable across source attempts');
      assert.strictEqual(call.query.iid, playbackIdentity.iid, 'install identity stays stable across source attempts');
      assert.strictEqual(call.options.headers['X-Medusa'], undefined, 'playback uses the registered-device endpoint without the Passport signature');
      assert.strictEqual(call.body.mixed_video_id_map['1004'].length, 1);
      assert(/^\d+$/.test(call.body.mixed_video_id_map['1004'][0]), 'playback request targets an exact video ID');
    });

    videoModelFallback = 'https://api5-normal-sinfonlineb.fqnovel.com/playback/fallback';
    fallbackResponseBody = JSON.stringify({ code: 0, video_info: { code: 0, data: { video_list: { '720': { backup_url_list: ['https://media.example.test/fallback.mp4'], codec_type: 'h264', vheight: 720, quality_desc: '720P' } }, video_duration: 91 } } });
    var fallbackProbe = await provider.inspectVideoModel('1434567890123456789');
    assert.strictEqual(fallbackProbe.ok, true, 'legacy model fallback_api returns a playable source');
    assert.strictEqual(fallbackProbe.diagnostic.quality_count, 1);
    assert.deepStrictEqual(fallbackProbe.diagnostic.qualities, ['720P']);
    assert.strictEqual(fallbackRequests.length, 1);
    assert.strictEqual(fallbackRequests[0].options.method, 'GET');
    assert.strictEqual(fallbackRequests[0].options.headers.Cookie || '', '', 'fallback request sends no account cookies');

    videoModelFallback = 'https://api.fqnovel.com/playback/fallback';
    fallbackStatus = 302;
    fallbackLocation = 'https://attacker.test/collect';
    var blockedFallback = await provider.inspectVideoModel('1534567890123456789');
    assert.strictEqual(blockedFallback.ok, false, 'fallback redirect outside the trusted domains is rejected');
    assert.strictEqual(blockedFallback.error.code, 'FALLBACK_API_BLOCKED');
    assert.strictEqual(fallbackRequests.length, 2, 'blocked fallback redirect is not followed');

    videoModelFallback = 'https://attacker.test/playback/fallback';
    fallbackStatus = 200;
    fallbackLocation = '';
    var blockedHost = await provider.inspectVideoModel('1634567890123456789');
    assert.strictEqual(blockedHost.ok, false, 'untrusted fallback host is rejected before a request');
    assert.strictEqual(blockedHost.error.code, 'FALLBACK_API_BLOCKED');
    assert.strictEqual(fallbackRequests.length, 2, 'untrusted fallback URL is never requested');
    videoModelFallback = '';
    console.log('webOS provider registered playback, map-shaped video lists, safe fallback_api and registration retry: PASS');
  } finally {
    provider.closeCache();
    https.request = originalRequest;
    rangeMedia.downloadFile = originalDownloadFile;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

run().catch(function (error) {
  https.request = originalRequest;
  rangeMedia.downloadFile = originalDownloadFile;
  console.error(error.stack || error);
  process.exitCode = 1;
});
