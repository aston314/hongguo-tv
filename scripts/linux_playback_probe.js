(function () {
  'use strict';
  // Executed only by the opt-in native Linux test after each navigation.
  function send(kind, payload) {
    return window.go.main.linuxProbeBridge.Dispatch(JSON.stringify({ kind: kind, payload: payload })).then(JSON.parse);
  }
  if (!window.HongguoTV) {
    if (window.go && window.go.main && window.go.main.linuxProbeBridge) {
      send('heartbeat', { appReady: false, readyState: document.readyState, path: location.pathname,
        text: document.body ? document.body.innerText.slice(0, 800) : '' });
    }
    return;
  }
  if (window.__linuxPlaybackProbe) return;
  window.__linuxPlaybackProbe = true;
  var report = { ok: false, engine: 'Wails 2 / WebKitGTK', userAgent: navigator.userAgent,
    series_id: '7696023326375808024', steps: [], events: [], requests: [] };
  var video = document.getElementById('hero-video');
  var started = performance.now(), presented = 0, lastPTS = null, sourceNumber = 0, lastSource = '';
  var originalFetch = window.fetch, mediaPaths = Object.create(null);
  // Keep status/mode evidence without retaining signed URLs, response bodies,
  // keys, local media tokens, or account data in the test report.
  window.fetch = function (input, options) {
    var url = String(input && input.url || input);
    var relevant = /\/api\/v1\/(?:play\/info|series\/detail)(?:\?|$)/.test(url);
    return originalFetch.apply(this, arguments).then(function (response) {
      if (relevant) {
        var entry = { endpoint: url.indexOf('/play/info') >= 0 ? 'play/info' : 'series/detail', status: response.status };
        report.requests.push(entry);
        response.clone().json().then(function (body) {
          var data = body.data || body;
          entry.ok = body.ok;
          if (entry.endpoint === 'play/info') {
            entry.mode = data.mode || null;
            entry.vid = data.vid || null;
            if (data.vid && data.path) mediaPaths[data.vid] = new URL(data.path, location.href).pathname;
          }
        }).catch(function () {});
      }
      return response;
    });
  };
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function text(selector) { var node = document.querySelector(selector); return node ? node.textContent.trim() : ''; }
  function isEpisodeSource(vid) {
    try { return !!mediaPaths[vid] && new URL(video.currentSrc || video.src).pathname === mediaPaths[vid]; }
    catch (ignored) { return false; }
  }
  function sample() {
    var source = video.currentSrc || video.src;
    if (source !== lastSource) { lastSource = source; sourceNumber++; }
    var quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
    var rect = video.getBoundingClientRect();
    return { elapsed: Math.round(performance.now() - started), source: sourceNumber,
      title: text('.hero-title'), episode: text('#hero-top-episode'),
      time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
      paused: video.paused, muted: video.muted, volume: video.volume,
      error: video.error ? { code: video.error.code } : null,
      decodedFrames: quality.totalVideoFrames || video.webkitDecodedFrameCount || 0,
      droppedFrames: quality.droppedVideoFrames || video.webkitDroppedFrameCount || 0,
      presentedCallbacks: presented, lastPTS: lastPTS,
      viewport: { width: innerWidth, height: innerHeight },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      desktopBackground: !!(window.HongguoDesktop && window.HongguoDesktop.background), documentHidden: document.hidden,
      overlay: document.getElementById('hero').className,
      status: text('#player-status') || text('.hero-status') };
  }
  if (video.requestVideoFrameCallback) {
    var frame = function (now, metadata) {
      presented++; lastPTS = metadata.mediaTime;
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  }
  ['loadstart', 'loadedmetadata', 'loadeddata', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'error'].forEach(function (name) {
    video.addEventListener(name, function () {
      if (report.events.length < 120) report.events.push({ event: name, sample: sample() });
    });
  });
  async function waitFor(label, condition, timeout) {
    var deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      if (condition()) return;
      if (video.error) throw new Error(label + ': MediaError ' + video.error.code);
      await sleep(200);
    }
    throw new Error(label + ': timed out');
  }
  async function capture(stage) {
    var data = sample(); data.stage = stage;
    try { data.media_path = new URL(video.currentSrc || video.src).pathname; } catch (ignored) {}
    var captured = await send('capture', data);
    report.steps.push(captured);
    return data;
  }
  (async function () {
    try {
      // The normal shell/API/account startup must finish before card launch.
      await sleep(4000);
      if (!window.HongguoTV.openHomeProgram({ series_id: report.series_id, title: '神豪外挂第一季' })) throw new Error('card launch rejected');
      await waitFor('episode 1 metadata', function () {
        return isEpisodeSource('7696024766267804697') && text('.hero-title') === '神豪外挂第一季' && /第1集/.test(text('#hero-top-episode')) &&
          video.videoWidth > 0 && video.readyState >= 2;
      }, 100000);
      await sleep(700);
      report.pausedBeforeUserGesture = video.paused;
      var requirements = await send('heartbeat', {});
      report.requireAutoplay = requirements.requireAutoplay === true;
      report.nativeWindowState = JSON.parse(await window.go.main.desktopApp.GetWindowState());
      if (video.paused) {
        if (report.requireAutoplay) throw new Error('Linux package did not start playback automatically');
        document.getElementById('hero-feed-focus').focus();
        report.initialUserPlay = await send('activate', {});
      }
      await waitFor('episode 1 first decoded picture', function () {
        return isEpisodeSource('7696024766267804697') && text('.hero-title') === '神豪外挂第一季' && /第1集/.test(text('#hero-top-episode')) &&
          video.videoWidth > 0 && video.readyState >= 2 && video.currentTime > 2 && !video.paused;
      }, 40000);
      var first = await capture('first-a');
      await sleep(3500);
      var later = await capture('first-b');
      if (later.time - first.time < 2 || later.source !== first.source) throw new Error('episode 1 did not continue playing');
      var target = Math.min(later.time + 12, video.duration - 8);
      if (target - video.currentTime < 3) throw new Error('clip too short to verify a seek');
      var seekEvents = report.events.filter(function (e) { return e.event === 'seeked'; }).length;
      video.currentTime = target;
      await waitFor('seek and resume', function () {
        return video.currentTime > target + 1 && !video.seeking && !video.paused &&
          report.events.filter(function (e) { return e.event === 'seeked'; }).length > seekEvents;
      }, 45000);
      await capture('after-seek');
      // Exercise the real GTK window, shared video and existing episode command.
      var mini = window.HongguoDesktopMini;
      var originalWindow = JSON.parse(await window.go.main.desktopApp.GetWindowState());
      var originalViewport = [innerWidth, innerHeight];
      var miniSource = video.currentSrc, miniPosition = video.currentTime;
      if (!mini || !await mini.request(true)) throw new Error('mini player entry failed');
      await waitFor('compact mini player layout', function () { return innerWidth < 600 && innerHeight < 650; }, 10000);
      await sleep(1000);
      var miniWindow = JSON.parse(await window.go.main.desktopApp.GetWindowState());
      if (!mini.isActive() || miniWindow.fullscreen || video.currentSrc !== miniSource || video.paused || video.currentTime < miniPosition) {
        throw new Error('mini player changed playback or failed to leave fullscreen');
      }
      report.miniPlayer = { entered: true, originalFullscreen: originalWindow.fullscreen,
        viewport: [innerWidth, innerHeight], retainedVideo: video === document.getElementById('hero-video'),
        continuedPlaying: video.currentTime > miniPosition };
      var oldSource = video.currentSrc;
      document.getElementById('mini-player-nextEpisode').click();
      await waitFor('episode 2 decoded picture', function () {
        return isEpisodeSource('7696024585514257433') && /第2集/.test(text('#hero-top-episode')) && video.currentSrc !== oldSource &&
          video.videoWidth > 0 && video.currentTime > 2 && video.readyState >= 2 && !video.paused;
      }, 100000);
      report.miniPlayer.episodeSwitch = mini.isActive();
      var secondSource = video.currentSrc;
      if (!await mini.request(false)) throw new Error('mini player restore failed');
      await waitFor('restored full window layout', function () {
        return innerWidth === originalViewport[0] && innerHeight === originalViewport[1];
      }, 10000);
      await sleep(700);
      var restoredWindow = JSON.parse(await window.go.main.desktopApp.GetWindowState());
      report.miniPlayer.restored = !mini.isActive() && restoredWindow.fullscreen === originalWindow.fullscreen && video.currentSrc === secondSource && !video.paused;
      if (!report.miniPlayer.retainedVideo || !report.miniPlayer.continuedPlaying || !report.miniPlayer.episodeSwitch || !report.miniPlayer.restored) {
        throw new Error('mini player did not preserve video, switch episode or restore window');
      }
      var second = await capture('second-a');
      await sleep(3500);
      var secondLater = await capture('second-b');
      if (secondLater.time - second.time < 2 || secondLater.source !== second.source) throw new Error('episode 2 did not continue playing');
      if (presented < 20 && secondLater.decodedFrames < 20) throw new Error('no decoded/presented frame evidence');
      report.ok = true;
    } catch (error) {
      report.failure = String(error.message || error).replace(/https?:\/\/\S+/g, '[URL omitted]');
      report.last = sample();
      try { await capture('failure'); } catch (ignored) {}
    }
    await send('report', report);
  }());
}());
