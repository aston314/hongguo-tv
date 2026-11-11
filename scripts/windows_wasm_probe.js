(async function () {
  'use strict';
  var results = [], video = document.getElementById('hero-video'), settings = window.HongguoWindowsDecoder;
  // Observe actual PCM submitted to Web Audio without changing its scheduling.
  var audioBuffers = 0, audioPeak = 0, createSource = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function () {
    var node = createSource.call(this), start = node.start;
    node.start = function () {
      if (node.buffer) {
        audioBuffers++;
        var pcm = node.buffer.getChannelData(0);
        for (var i = 0; i < pcm.length; i += 16) audioPeak = Math.max(audioPeak, Math.abs(pcm[i]));
      }
      return start.apply(node, arguments);
    };
    return node;
  };
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  async function until(check, label, timeout) {
    var end = Date.now() + (timeout || 20000);
    while (Date.now() < end) { if (video.error) throw Error(label + ': media error ' + video.error.code); if (check()) return; await wait(40); }
    throw Error('timeout: ' + label);
  }
  function load(name) { video.pause(); video.removeAttribute('src'); video.load(); video.src = window.HongguoDesktop.mediaBase + '/minireel-proxy/media/' + name + '.mp4'; video.classList.add('has-source'); video.load(); return video.play(); }
  async function run(name, width) {
    await load(name);
    await until(function () { return video.currentTime > 2 && video.readyState >= 2; }, name + ' first frames');
    if (video.videoWidth !== width) throw Error('dimensions: ' + name);
    var begin = performance.now(), initialPTS = video.currentTime, initial = settings.diagnostics();
    await until(function () { return video.currentTime > 6; }, name + ' continuous playback');
    var observed = settings.diagnostics(), elapsed = (performance.now() - begin) / 1000, played = video.currentTime - initialPTS;
    var continuous = { wallSeconds:elapsed, mediaSeconds:played, presented:observed.presented-initial.presented, dropped:observed.dropped-initial.dropped };
    if (elapsed > played * 1.25 || continuous.presented < played * 25 || continuous.dropped > played * 3) throw Error(name + ' cannot sustain realtime playback: ' + JSON.stringify(continuous));
    var before = settings.diagnostics(), at = video.currentTime;
    video.pause(); await wait(300); if (Math.abs(video.currentTime - at) > .15) throw Error('pause clock');
    await video.play(); await until(function () { return video.currentTime > at + .3; }, 'resume');
    video.currentTime = 5; await until(function () { return !video.seeking && video.currentTime > 5.3; }, 'seek');
    video.playbackRate = 1.5; await until(function () { return video.currentTime > 6.2 && video.readyState >= 2; }, 'speed');
    video.volume = .4; video.muted = true; if (video.volume !== .4 || !video.muted) throw Error('volume'); video.muted = false;
    video.playbackRate = 1; await until(function () { return video.currentTime > 7; }, 'speed restore');
    var canvas = document.querySelector('.windows-wasm-picture'), gl = canvas.getContext('webgl'), pixel = new Uint8Array(4);
    gl.readPixels(width >> 1, video.videoHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (!pixel[0] && !pixel[1] && !pixel[2]) throw Error('black frame');
    await until(function () { return video.ended; }, 'natural end');
    results.push({ name:name, before:before, continuous:continuous, after:settings.diagnostics(), pixel:Array.from(pixel), width:width, passed:true });
  }
  var report;
  try {
    if (!settings || settings.mode() !== 'default') throw Error('default changed');
    if (!settings.choose('wasm')) throw Error('preference');
    await run('hevc720',1280); await run('hevc1080',1920);
    await load('hevc720'); await wait(80); await load('hevc1080'); await wait(80); await load('hevc720');
    await until(function () { return video.currentTime > .5 && video.videoWidth === 1280; },'rapid replacement');
    video.pause(); video.removeAttribute('src'); video.load(); await wait(100);
    if (settings.diagnostics().workers !== 0 || document.querySelector('.windows-wasm-picture')) throw Error('cleanup');
    settings.choose('default'); await load('h264');
    await until(function () { return video.currentTime > 1 && video.readyState >= 2; },'original HTML5');
    if (settings.current() !== 'default' || settings.diagnostics().workers !== 0) throw Error('default isolation');
    if (!audioBuffers || audioPeak < .001) throw Error('missing decoded PCM');
    report={ok:true,results:results,defaultPreserved:true,rapidSwitch:true,cleanup:true,audio:{buffers:audioBuffers,peak:audioPeak,check:'Nonzero decoded PCM, running Web Audio clock; no subjective listening'},runtime:navigator.userAgent};
  } catch(error) { report={ok:false,error:error.message,results:results,diagnostics:settings&&settings.diagnostics(),runtime:navigator.userAgent}; }
  document.getElementById('results').textContent=JSON.stringify(report,null,2);
  await fetch('/__wasm_probe/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
}());
