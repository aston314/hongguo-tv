(function (root) {
  'use strict';
  var messages = {};
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    try { messages = require('./locales/zh-CN.js')['zh-CN'] || {}; } catch (ignoredLocale) {}
  }
  function lookup(key) {
    var i18n = root.HongguoI18n;
    if (i18n && typeof i18n.t === 'function') return i18n.t(key);
    return messages[key] === undefined ? key : messages[key];
  }
  function tr(key, params) {
    return String(lookup(key)).replace(/\{([a-zA-Z0-9_]+)\}/g, function (_, name) {
      return params && params[name] !== undefined && params[name] !== null ? String(params[name]) : '';
    });
  }
  var readyNames = ['diagnostic.mediaReady0', 'diagnostic.mediaReady1', 'diagnostic.mediaReady2', 'diagnostic.mediaReady3', 'diagnostic.mediaReady4'];
  var networkNames = ['diagnostic.network0', 'diagnostic.network1', 'diagnostic.network2', 'diagnostic.network3'];
  var errorNames = ['diagnostic.error0', 'diagnostic.error1', 'diagnostic.error2', 'diagnostic.error3', 'diagnostic.error4'];
  function text(value, limit) { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit || 90) : ''; }
  function fallbackReason(value) { return text(typeof value === 'string' ? value.replace(/https?:\/\/\S+/gi, '[redacted]') : '', 180); }
  function num(value) { return typeof value === 'number' && isFinite(value) ? Math.max(0, value) : 0; }
  function errorCode(value) { return typeof value === 'number' && isFinite(value) ? Math.round(value) : 0; }
  function metric(value) { return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.floor(value) : tr('diagnostic.notObtained'); }
  function millis(value) { return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.floor(value) + 'ms' : tr('diagnostic.notObtained'); }
  function clock(value) { var seconds = Math.floor(num(value)); return Math.floor(seconds / 60) + ':' + ('0' + seconds % 60).slice(-2); }
  function readVideo(video) {
    var result = { position: num(video.currentTime), duration: num(video.duration), width: num(video.videoWidth), height: num(video.videoHeight), ready: num(video.readyState), network: num(video.networkState), paused: !!video.paused, ended: !!video.ended, seeking: !!video.seeking, muted: !!video.muted, volume: num(video.volume), buffered: 0, error: video.error ? num(video.error.code) : 0, decoded: null };
    try {
      for (var i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= result.position && video.buffered.end(i) >= result.position) { result.buffered = video.buffered.end(i) - result.position; break; }
      }
    } catch (ignored) {}
    try {
      if (typeof video.getVideoPlaybackQuality === 'function') {
        var quality = video.getVideoPlaybackQuality();
        if (typeof quality.totalVideoFrames === 'number') result.decoded = num(quality.totalVideoFrames);
      } else if (typeof video.webkitDecodedFrameCount === 'number') result.decoded = num(video.webkitDecodedFrameCount);
    } catch (ignoredFrames) {}
    return result;
  }
  function report(snapshot) {
    snapshot = snapshot || {};
    var device = snapshot.device || {}, core = snapshot.core || {}, video = snapshot.video || { position: 0, duration: 0, width: 0, height: 0, ready: 0, network: 0, paused: true, ended: false, seeking: false, muted: true, volume: 0, buffered: 0, error: 0, decoded: null }, native = snapshot.native || {}, flags = snapshot.flags || {};
    // A Media3 attempt may already have returned control to HTML5. Its track
    // warning and decoder error must not override the current path's result.
    if (snapshot.playbackRoute && snapshot.playbackRoute.active_path === 'HTML5') native = {};
    var engine = /(?:Chrome|Chromium)\/([\d.]+)/.exec(snapshot.userAgent || '');
    var android = /HongguoTV-Android/.test(snapshot.userAgent || '');
    var bits = device.process_bits === 32 || device.process_bits === 64 ? device.process_bits + ' 位' : tr('diagnostic.androidBitsUnknown');
    var arch = text(core.arch, 16), app = text(device.app_version, 36) || tr('diagnostic.appVersion') + tr('diagnostic.notObtained');
    var version = text(core.version || device.core_version, 55).replace(/([a-f0-9]{7})[a-f0-9]{20,}/g, '$1');
    var provider = text(device.webview_version, 28), engineVersion = engine ? engine[1] : tr('diagnostic.unknown');
    var webview = provider ? provider + ' · Chromium ' + engineVersion : 'Chromium ' + engineVersion + tr('diagnostic.browserIdentity');
    var rows = [], summary;
    function add(label, value, wide) { rows.push({ label: label, value: value, wide: !!wide }); }
    var playerName = native.engine === 'mpv' ? 'MPV' : 'Media3';
    if (native.error_kind === 'decoder') summary = tr('diagnostic.decoderFailure', { player: playerName, codec: native.video_mime === 'video/hevc' ? ' HEVC ' : '' });
    else if (native.track_support === 'FORMAT_UNSUPPORTED_SUBTYPE' || native.track_support === 'FORMAT_UNSUPPORTED_TYPE') summary = tr('diagnostic.unsupportedTrack');
    else if (native.track_support === 'FORMAT_EXCEEDS_CAPABILITIES') summary = tr('diagnostic.exceedsCapabilities');
    else if (native.error_kind === 'network') summary = playerName + ' ' + tr('diagnostic.readVideoFailed');
    else if (video.error) summary = errorNames[video.error] ? tr(errorNames[video.error]) : tr('diagnostic.playerError');
    else if (flags.failed) summary = tr('diagnostic.prepareFailed');
    else if (flags.preparing && !video.width) summary = tr('diagnostic.loadingStill');
    else if (flags.preparing) summary = tr('diagnostic.loadingReleased');
    else if (flags.source) summary = tr('diagnostic.loadingDone');
    else summary = tr('diagnostic.sourceNotSet');
    add(tr('diagnostic.appVersion'), app + (device.version_code ? ' / ' + num(device.version_code) : ''));
    add(tr('diagnostic.builtInCore'), version || (core.unavailable ? tr('diagnostic.readFailed') : tr('content.reading')));
    add(tr('diagnostic.deviceModel'), text(device.manufacturer, 28) + ' ' + text(device.model, 52) || tr('diagnostic.browserPreview'));
    if (!device.model) rows[2].value = android ? tr('diagnostic.deviceUnavailable') : tr('diagnostic.browserPreview');
    add(tr('diagnostic.systemArch'), device.sdk ? 'Android ' + text(device.android_version, 20) + ' / API ' + num(device.sdk) + ' · ' + bits + (arch ? ' / ' + arch : '') : (android ? tr('diagnostic.androidBitsUnknown') : tr('diagnostic.desktopBrowser')) + (arch ? ' / ' + arch : ''));
    rows = rows.concat(snapshot.environmentRows || []);
    add('WebView', webview);
    var route = snapshot.playbackRoute;
    if (route) {
      var preferred = text(route.preferred_path, 16) || 'HTML5';
      var active = text(route.active_path, 16) || 'HTML5';
      var finalPath = text(route.final_path, 16) || tr('diagnostic.notObtained');
      add(tr('diagnostic.playerRoute'), tr('diagnostic.playerRouteValue', {
        preferred: preferred, active: active, final: finalPath,
        switched: tr(route.switched ? 'diagnostic.routeYes' : 'diagnostic.routeNo'),
        reason: text(route.switch_reason, 40) || tr('diagnostic.notObtained'),
        outcome: text(route.outcome, 48) || tr('diagnostic.notObtained'),
        frame: tr(route.final_first_frame ? 'diagnostic.firstFrame' : 'diagnostic.noFirstFrame')
      }), true);
      add(tr('diagnostic.playerRouteTiming'), tr('diagnostic.playerRouteTimingValue', {
        metadata: millis(route.metadata_ms), zero: millis(route.zero_progress_wait_ms !== null && route.zero_progress_wait_ms !== undefined ? route.zero_progress_wait_ms : route.zero_progress_ms),
        switch: millis(route.switch_ms), first: millis(route.first_frame_ms !== null && route.first_frame_ms !== undefined ? route.first_frame_ms : route.first_frame_wait_ms),
        media3: millis(route.media3_first_frame_ms !== null && route.media3_first_frame_ms !== undefined ? route.media3_first_frame_ms : route.media3_wait_ms)
      }), true);
    }
    add(tr('diagnostic.currentVideo'), snapshot.episode > 0 ? tr('diagnostic.episodeFormat', { episode: num(snapshot.episode), quality: text(snapshot.quality, 20) || tr('diagnostic.auto') }) : tr('diagnostic.episodeUnknown'));
    add(tr('diagnostic.videoPicture'), video.width + ' × ' + video.height + (video.decoded !== null ? ' · ' + tr('diagnostic.frameCount') + ' ' + video.decoded : ' · ' + tr('diagnostic.frameUnavailable')));
    add(tr('diagnostic.playbackClock'), clock(video.position) + ' / ' + (video.duration ? clock(video.duration) : tr('diagnostic.durationUnknown')) + ' · ' + tr('diagnostic.bufferedSeconds', { seconds: Math.floor(video.buffered) }));
    add(tr('diagnostic.mediaState'), 'R' + video.ready + ' ' + tr(readyNames[video.ready] || 'diagnostic.unknown') + ' / N' + video.network + ' ' + tr(networkNames[video.network] || 'diagnostic.unknown'));
    add(tr('diagnostic.playbackState'), (video.ended ? tr('diagnostic.ended') : video.paused ? tr('diagnostic.paused') : tr('diagnostic.playing')) + (video.seeking ? ' · ' + tr('diagnostic.seeking') : '') + (flags.background ? ' · ' + tr('diagnostic.background') : ''));
    var actualMode = flags.playbackMode || (core.media_prepared ? core.media_mode : '');
    if (flags.rangeRequested || actualMode) add(tr('diagnostic.readMode'), (flags.rangeRequested ? tr('diagnostic.rangeMode') : tr('diagnostic.standardPlayback')) + (actualMode ? ' · ' + tr('diagnostic.currentSource', { source: text(actualMode, 12) }) : ''));
    if (flags.rangeFallback || core.media_range_fallback) add(tr('diagnostic.playbackFallback'), fallbackReason(flags.rangeFallback || core.media_range_fallback));
    if (native.state || native.surface || native.error_kind) {
      var nativeState = text(native.state, 24) || tr('diagnostic.unknown');
      var nativeCodec = [text(native.video_decoder, 48), text(native.video_mime, 32)].filter(Boolean).join(' / ');
      var nativeError = native.error_kind ? ' · ' + text(native.error_kind, 24) + (errorCode(native.error_code) ? ' ' + errorCode(native.error_code) : '') : '';
      var frameState = native.engine === 'mpv' ? (native.output_ready ? ' · ' + tr('diagnostic.outputReady') : ' · ' + tr('diagnostic.outputPending')) : (native.first_frame ? ' · ' + tr('diagnostic.firstFrame') : ' · ' + tr('diagnostic.noFirstFrame'));
      add(playerName, nativeState + (native.surface ? ' · ' + text(native.surface, 20) : '') + (nativeCodec ? ' · ' + nativeCodec : '') + nativeError + frameState);
      if (native.engine === 'mpv') {
        var openState = typeof native.open_requested === 'boolean' ? tr(native.open_requested ? 'diagnostic.mpvOpenRequested' : 'diagnostic.mpvOpenNotRequested') : tr('diagnostic.notObtained');
        var loadedState = typeof native.file_loaded === 'boolean' ? tr(native.file_loaded ? 'diagnostic.mpvFileLoaded' : 'diagnostic.mpvFileNotLoaded') : tr('diagnostic.notObtained');
        var endFile = native.end_file_seen ? 'END_FILE reason=' + errorCode(native.end_file_reason) + ' error=' + errorCode(native.end_file_error) : tr('diagnostic.mpvNoEndFile');
        add(tr('diagnostic.mpvLoadState'), openState + ' · ' + loadedState + ' · ' + endFile);
        add(tr('diagnostic.mpvOutput'), (text(native.video_output, 20) || tr('diagnostic.outputUnavailable')) + ' · ' + (native.vo_configured ? tr('diagnostic.configured') : tr('diagnostic.notConfigured')) + ' · ' + tr('diagnostic.window', { value: num(native.surface_width) + ' × ' + num(native.surface_height) }) + ' · ' + (native.restart_seen ? tr('diagnostic.restartReceived') : tr('diagnostic.restartWaiting')));
        var audio = (text(native.audio_output, 20) || tr('diagnostic.outputUnavailable')) + (native.audio_codec ? ' · ' + text(native.audio_codec, 32) : '') + (native.audio_format ? ' · ' + text(native.audio_format, 16) : '') + (native.audio_rate ? ' · ' + num(native.audio_rate) + ' Hz' : '') + (native.audio_channels ? ' · ' + tr('diagnostic.channels', { count: num(native.audio_channels) }) : '');
        if (typeof native.audio_delay_ms === 'number' && isFinite(native.audio_delay_ms)) audio += ' · ' + tr('diagnostic.mpvAudioDelay', { value: (native.audio_delay_ms > 0 ? '+' : '') + Math.round(native.audio_delay_ms) });
        add(tr('diagnostic.mpvAudio'), audio);
        add(tr('diagnostic.mpvState'), (typeof native.actual_mute === 'boolean' ? (native.actual_mute ? tr('diagnostic.muted') : tr('diagnostic.unmuted')) : tr('diagnostic.muteUnknown')) + (typeof native.actual_volume === 'number' ? ' · ' + tr('diagnostic.volume', { value: Math.round(num(native.actual_volume)) + '%' }) : '') + (typeof native.actual_pause === 'boolean' ? (native.actual_pause ? ' · ' + tr('diagnostic.paused') : ' · ' + tr('diagnostic.running')) : ''));
        var requested = native.mode === 'mpv_auto' ? tr('settings.autoDecode') : native.mode === 'mpv_software' || native.mode === 'software' ? tr('settings.softwareDecode') : tr('diagnostic.modeUnknown');
        var actual = text(native.hwdec_current, 32);
        add(tr('diagnostic.mpvDecode'), requested + ' · ' + tr('diagnostic.actual', { value: actual === 'no' ? tr('settings.softwareDecode') : actual ? actual : tr('diagnostic.notObtained') }) + ' · ' + tr('diagnostic.outputNote'));
        add(tr('diagnostic.droppedFrames'), tr('diagnostic.decodeRender', { decode: metric(native.decoder_frame_drop_count), render: metric(native.frame_drop_count) }));
        if (typeof native.demuxer_cache_duration === 'number' && isFinite(native.demuxer_cache_duration) && native.demuxer_cache_duration >= 0) add(tr('diagnostic.cacheDuration'), clock(native.demuxer_cache_duration));
        if (typeof native.avsync === 'number' && isFinite(native.avsync)) add(tr('diagnostic.avOffset'), Math.round(native.avsync * 1000) + ' ms');
        if (native.output_messages) add(tr('diagnostic.outputHint'), text(native.output_messages, 90));
      }
    }
    if (native.video_track || native.track_support || native.track_selected) {
      var track = text(native.video_track, 120) || tr('diagnostic.notObtained');
      if (native.track_support) track += ' · ' + text(native.track_support, 42);
      if (native.track_selected) track += ' · ' + tr('diagnostic.selected') + (native.track_selected === '否' ? '：' + tr('diagnostic.no') : '');
      add(tr('diagnostic.track'), track);
      if (native.unselected_hevc) add(tr('diagnostic.noHevc'), text(native.unselected_hevc, 220));
    }
    var visibility = native.engine === 'mpv' ? ' · ' + tr('diagnostic.nativeLayer') + (typeof native.surface_visible === 'boolean' ? (native.surface_visible && native.surface_attached ? tr('diagnostic.visible') : tr('diagnostic.hidden')) : tr('diagnostic.pending')) : ' · ' + tr('diagnostic.video') + (flags.videoVisible ? tr('diagnostic.surfaceVisible') : tr('diagnostic.hidden'));
    add(tr('diagnostic.videoProtection'), (flags.loading || flags.preparing ? tr('diagnostic.loadingLayer') : tr('diagnostic.loadingRemoved')) + visibility + (flags.waiting ? ' · ' + tr('diagnostic.waitingData') : ''));
    add(tr('diagnostic.soundState'), (flags.audioHeld ? tr('diagnostic.temporaryMute') : video.muted || !video.volume ? tr('diagnostic.playerMute') : tr('diagnostic.unmute')) + ' · ' + tr('diagnostic.volume', { value: Math.round(video.volume * 100) + '%' }));
    if (native.webos_audio) {
      var audio = native.webos_audio;
      add('Web Audio / WSOLA', text(audio.phase, 20) + ' · ' + num(audio.requested_rate) + 'x / video ' + num(audio.actual_video_rate) +
        'x · PCM ' + Math.round(num(audio.pcm_bytes) / 1024 / 1024) + 'MiB · sync ' +
        (typeof audio.sync_error_ms === 'number' ? Math.round(audio.sync_error_ms) : 0) + 'ms' + (audio.error_code ? ' · ' + text(audio.error_code, 40) : ''));
    }
    if (snapshot.timing) {
      var timing = snapshot.timing;
      add(tr('diagnostic.transitionTiming'), tr('diagnostic.transitionTimingValue', {
        prefetch: millis(timing.prefetch_ms), wait: millis(timing.handoff_wait_ms), resolver: millis(timing.foreground_resolve_ms),
        source: millis(timing.source_ready_ms), total: millis(timing.total_ms)
      }));
    }
    if (core.media_mode && (core.media_prepared || core.media_preparation_stage)) {
      var mediaTiming = core.media_mode === 'range' ? tr('diagnostic.rangePreparationTiming', {
        resolve: millis(core.media_resolve_ms), range: millis(core.media_range_init_ms)
      }) : tr('diagnostic.fullPreparationTiming', {
        resolve: millis(core.media_resolve_ms), download: millis(core.media_download_ms), decrypt: millis(core.media_decrypt_ms)
      });
      if (core.media_mode === 'full' && core.media_range_fallback) mediaTiming = tr('diagnostic.rangePreparationTiming', {
        resolve: millis(core.media_resolve_ms), range: millis(core.media_range_init_ms)
      }) + ' · ' + mediaTiming;
      add(tr('diagnostic.mediaPreparationTiming'), mediaTiming);
    }
    if (native.engine === 'mpv' && (native.last_stop_fence_ms > 0 || typeof native.load_to_file_loaded_ms === 'number')) {
      add(tr('diagnostic.mpvTransitionTiming'), tr('diagnostic.mpvTransitionTimingValue', {
        stop: millis(native.last_stop_fence_ms), loaded: millis(native.load_to_file_loaded_ms), ready: millis(native.load_to_output_ready_ms)
      }));
    }
    var request = flags.failed ? tr('diagnostic.prepareError') : flags.source ? tr('diagnostic.sourceReturned') : flags.resolving ? tr('content.reading') : tr('diagnostic.notRequested');
    if (flags.source && core.media_prepared) request += core.media_mode === 'range' ? ' · ' + tr('diagnostic.rangeReady', { size: (num(core.media_bytes) / 1024).toFixed(0) + ' KB' }) : ' · ' + tr('diagnostic.mp4Ready', { size: (num(core.media_bytes) / 1048576).toFixed(1) + ' MB' });
    request += flags.source && core.media_http_status ? ' · HTTP ' + num(core.media_http_status) + '（' + num(core.media_age_seconds) + tr('diagnostic.secondsAgo') : core.unavailable ? ' · ' + tr('diagnostic.coreReadFailed') : ' · ' + tr('diagnostic.noMediaRequest');
    add(tr('diagnostic.request'), request);
    add(tr('diagnostic.recentError'), native.error_kind ? playerName + ' ' + text(native.error_kind, 24) + (errorCode(native.error_code) ? '（' + errorCode(native.error_code) + '）' : '') : video.error ? (errorNames[video.error] ? tr(errorNames[video.error]) : tr('diagnostic.unknownMediaError')) + '（' + video.error + '）' : flags.failed ? tr('diagnostic.retryVisible') : flags.source && core.media_http_status >= 400 ? tr('diagnostic.localHttp', { status: num(core.media_http_status) }) : tr('diagnostic.noPlaybackError'));
    return { summary: summary, rows: rows, capturedAt: snapshot.capturedAt };
  }
  var api = { readVideo: readVideo, report: report };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HongguoPlaybackDiagnostics = api;
}(typeof window !== 'undefined' ? window : this));
