(function (window, document) {
  'use strict';

  var endpoint = window.HongguoWebOSSimulatorConfig && window.HongguoWebOSSimulatorConfig.reportURL || 'http://127.0.0.1:17656/report';
  var seriesID = '7696023326375808024';
  var episodes = ['7696024766267804697', '7696024585514257433'];
  var video = document.getElementById('hero-video');
  var mediaPaths = Object.create(null);
  var started = Date.now();
  var lastSource = '';
  var presented = 0;
  var report = {
    platform: 'webOS TV 26 Simulator',
    appVersion: window.HongguoWebOS && window.HongguoWebOS.appVersion || 'unknown',
    seriesID: seriesID,
    title: '神豪外挂第一季',
    player: 'HTML5 video through webOS JS Service',
    redacted: true,
    accountStubbed: true,
    ok: false,
    stage: 'starting',
    requests: [],
    events: [],
    steps: []
  };

  if (!video || window.__webosSimulatorProbe) return;
  window.__webosSimulatorProbe = true;

  function safeText(selector) {
    var node = document.querySelector(selector);
    return node ? String(node.textContent || '').trim().slice(0, 100) : '';
  }

  function matchesEpisode(vid) {
    try {
      var expected = mediaPaths[vid];
      return !!expected && new URL(video.currentSrc || video.src, location.href).pathname === expected;
    } catch (ignored) { return false; }
  }

  function sample(stage) {
    var quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
    var style = window.getComputedStyle(video);
    var hero = document.getElementById('hero');
    var source = video.currentSrc || video.src || '';
    if (source && source !== lastSource) lastSource = source;
    return {
      stage: stage,
      elapsedMs: Date.now() - started,
      title: safeText('#hero-series-title'),
      episode: safeText('#hero-top-episode'),
      episode1Source: matchesEpisode(episodes[0]),
      episode2Source: matchesEpisode(episodes[1]),
      currentTime: isFinite(video.currentTime) ? video.currentTime : null,
      duration: isFinite(video.duration) ? video.duration : null,
      videoWidth: video.videoWidth || 0,
      videoHeight: video.videoHeight || 0,
      readyState: video.readyState,
      paused: !!video.paused,
      muted: !!video.muted,
      visible: style.visibility === 'visible' && Number(style.opacity) > 0,
      loading: !!(hero && hero.classList.contains('is-preparing-video')),
      audioDecodedBytes: video.webkitAudioDecodedByteCount || 0,
      seeking: !!video.seeking,
      ended: !!video.ended,
      mediaError: video.error ? video.error.code : 0,
      decodedFrames: quality.totalVideoFrames || video.webkitDecodedFrameCount || 0,
      droppedFrames: quality.droppedVideoFrames || video.webkitDroppedFrameCount || 0,
      presentedFrames: presented
    };
  }

  function sendReport() {
    return window.fetch(endpoint, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(report)
    }).catch(function (error) {
      if (window.console && console.warn) console.warn('[webOS simulator probe] report failed: ' + String(error && error.message || error));
    });
  }

  function sleep(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }

  function waitFor(label, condition, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve, reject) {
      function poll() {
        if (condition()) { resolve(); return; }
        if (video.error) { reject(new Error(label + ': MediaError ' + video.error.code)); return; }
        if (Date.now() >= deadline) { reject(new Error(label + ': timed out')); return; }
        window.setTimeout(poll, 250);
      }
      poll();
    });
  }

  function record(stage) {
    var value = sample(stage);
    report.steps.push(value);
    return value;
  }

  var originalFetch = window.fetch;
  window.fetch = function (input, options) {
    var url = String(input && input.url || input || '');
    var pathname = '';
    try { pathname = new URL(url, location.href).pathname; } catch (ignored) {}
    if (pathname === '/api/v1/account' && (!options || String(options.method || 'GET').toUpperCase() === 'GET')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve({ ok: true, data: { logged_in: false, phase: 'phone', sync: { state: 'idle' } } }); }
      });
    }
    var pathname = '';
    var search = null;
    try { var parsed = new URL(url, location.href); pathname = parsed.pathname; search = parsed.searchParams; } catch (ignored) {}
    var endpoint = pathname === '/api/v1/play/info' ? 'play/info' : pathname === '/api/v1/series/detail' ? 'series/detail' : '';
    var entry = null;
    if (endpoint && report.requests.length < 30) {
      entry = { endpoint: endpoint, status: null, elapsedMs: Date.now() - started };
      if (endpoint === 'play/info' && search) {
        entry.episode1 = search.get('vid') === episodes[0];
        entry.episode2 = search.get('vid') === episodes[1];
      }
      report.requests.push(entry);
    }
    var request;
    try { request = originalFetch.apply(this, arguments); } catch (error) {
      if (entry) entry.networkError = String(error && error.message || error).slice(0, 160);
      throw error;
    }
    return request.then(function (response) {
      if (entry) {
        entry.status = response.status;
        entry.elapsedMs = Date.now() - started;
        response.clone().json().then(function (payload) {
          entry.ok = payload && payload.ok === true;
          var data = payload && (payload.data || payload) || {};
          if (endpoint === 'play/info') {
            entry.episode1 = String(data.vid || '') === episodes[0];
            entry.episode2 = String(data.vid || '') === episodes[1];
            entry.hasPath = !!data.path;
            entry.quality = String(data.quality || '').slice(0, 12);
            if ((entry.episode1 || entry.episode2) && data.path) {
              try { mediaPaths[String(data.vid)] = new URL(data.path, location.href).pathname; } catch (ignored) {}
            }
          }
        }).catch(function () {});
      }
      return response;
    }, function (error) {
      if (entry) {
        entry.elapsedMs = Date.now() - started;
        entry.networkError = String(error && error.message || error).slice(0, 160);
      }
      throw error;
    });
  };

  ['loadedmetadata', 'loadeddata', 'playing', 'waiting', 'seeking', 'seeked', 'ended', 'error'].forEach(function (name) {
    video.addEventListener(name, function () {
      if (report.events.length < 80) report.events.push({ event: name, sample: sample(name) });
    });
  });

  if (video.requestVideoFrameCallback) {
    var onFrame = function () {
      presented += 1;
      if (presented < 100000) video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  (async function run() {
    try {
      await waitFor('application ready', function () { return !!(window.HongguoTV && window.HongguoTV.openHomeProgram); }, 30000);
      await sleep(3000);
      if (!window.HongguoTV.openHomeProgram({ series_id: seriesID, title: report.title })) throw new Error('card launch rejected');
      await waitFor('episode 1 metadata', function () {
        return matchesEpisode(episodes[0]) && /第\s*1\s*集/.test(safeText('#hero-top-episode')) && video.videoWidth > 0 && video.readyState >= 2;
      }, 300000);
      report.metadataReady = true;
      report.stage = video.paused ? 'awaiting-remote-play' : 'episode-1-playing';
      record('episode-1-metadata');
      await sendReport();

      await waitFor('episode 1 playback', function () {
        return matchesEpisode(episodes[0]) && !video.paused && video.currentTime > 2 && video.videoWidth > 0;
      }, 120000);
      var first = record('episode-1-a');
      await sleep(4000);
      var later = record('episode-1-b');
      if (later.currentTime - first.currentTime < 2) throw new Error('episode 1 playback clock did not advance');
      if (later.presentedFrames < 20 && later.decodedFrames < 20) throw new Error('no frame-count evidence');

      var target = Math.min(later.currentTime + 10, video.duration - 8);
      if (!(target > video.currentTime + 2)) throw new Error('episode is too short to verify seek');
      video.currentTime = target;
      await waitFor('episode 1 seek', function () { return !video.seeking && video.currentTime >= target; }, 45000);
      await sleep(1000);
      record('episode-1-seek');

      // Exercise the production D-pad handler with the same webOS keyCode used by RCU.
      var feedFocus = document.getElementById('hero-feed-focus');
      if (feedFocus) feedFocus.focus();
      window.HongguoTV.remoteKey(20, false);
      await waitFor('episode 2 metadata', function () {
        return matchesEpisode(episodes[1]) && /第\s*2\s*集/.test(safeText('#hero-top-episode')) && video.videoWidth > 0;
      }, 300000);
      await waitFor('episode 2 playback', function () { return !video.paused && video.currentTime > 2; }, 120000);
      var second = record('episode-2-a');
      await sleep(4000);
      var secondLater = record('episode-2-b');
      if (secondLater.currentTime - second.currentTime < 2) throw new Error('episode 2 playback clock did not advance');
      if (!secondLater.videoWidth || !secondLater.videoHeight) throw new Error('episode 2 has no video dimensions');

      report.ok = true;
      report.stage = 'passed';
    } catch (error) {
      report.ok = false;
      report.stage = 'failed';
      report.failure = String(error && error.message || error).replace(/https?:\/\/\S+/g, '[URL omitted]');
      report.last = sample('failure');
    }
    await sendReport();
  }());
}(window, document));
