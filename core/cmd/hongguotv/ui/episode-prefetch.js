(function (root) {
  'use strict';
  // A single speculative episode. No media is attached to a second player.
  function create(options) {
    var entry = null;
    var now = options.now || Date.now;
    var maxRetries = options.maxRetries === 1 ? 1 : 0;
    var retryDelay = Math.max(0, Number(options.retryDelayMs) || 3000);
    var maxAge = Math.max(0, Number(options.maxAgeMs) || 0);
    var isRetryableError = options.isRetryableError || retryableError;
    function stableThreshold(info) {
      var value = Number(info && info.prefetch_after_seconds);
      return isFinite(value) && value >= 0 ? value : 5;
    }
    function cancel() {
      var previous = entry; entry = null;
      invalidate(previous);
    }
    function invalidate(candidate) {
      if (!candidate) return;
      candidate.cancelled = true;
      if (candidate.request) candidate.request.abort();
    }
    function key(info) {
      return [info.series_id, info.vid, info.episode, info.quality || '', info.mode || '', info.generation, info.owner].join(':');
    }
    function current(candidate) {
      return !candidate.cancelled && (entry === candidate || candidate.claimed) && !(candidate.request && candidate.request.signal.aborted);
    }
    function maybe(info) {
      if (!info.active || !info.started || info.paused || info.ended || !isFinite(info.duration) ||
          !(info.duration > 0) || !isFinite(info.position) || info.position < 0 ||
          !isFinite(info.stable_seconds) || info.stable_seconds < stableThreshold(info)) return;
      var identity = key(info);
      if (entry && entry.key === identity) {
        if (entry.state === 'failed' && entry.attempts <= maxRetries && now() >= entry.retryAt) run(entry);
        // A long episode may outlive the early prepared URL. Use the same
        // single extra-attempt budget to refresh near the end, while there is
        // still time to prepare it, rather than polling throughout playback.
        else if (entry.state === 'ready' && maxAge && now() - entry.timing.ready_at >= maxAge &&
            entry.attempts <= maxRetries && info.duration - info.position <= 30) {
          entry.timing.started_at = now();
          run(entry);
        }
        return;
      }
      cancel();
      var candidate = { key: identity, info: info, target: null, attempts: 0, timing: { started_at: now(), ready_at: 0 },
        request: typeof AbortController === 'function' ? new AbortController() : null };
      entry = candidate;
      run(candidate);
    }
    function run(candidate) {
      candidate.state = 'pending';
      candidate.attempts++;
      candidate.target = null;
      candidate.timing.ready_at = 0;
      candidate.promise = Promise.resolve().then(function () {
        if (!current(candidate)) return null;
        return options.lookup(candidate.info, candidate.request && candidate.request.signal);
      }).then(function (target) {
        var info = candidate.info;
        if (!current(candidate) || !target || !validVid(target.vid) || target.vid === info.vid || target.series_id !== info.series_id ||
            Number(target.episode) !== Number(info.episode) + 1 || (target.quality || '') !== (info.quality || '') ||
            (target.mode || '') !== (info.mode || '') || !sameValue(target.owner, info.owner) ||
            candidate.expectedVid && candidate.expectedVid !== target.vid) return null;
        candidate.target = target;
        return options.prepare(target, candidate.request && candidate.request.signal);
      }).then(function (data) {
        if (!current(candidate)) return null;
        candidate.state = data && data.path ? 'ready' : 'unavailable';
        if (candidate.state === 'ready') candidate.timing.ready_at = now();
        return data;
      }).catch(function (error) {
        // Retry only on a later eligible playback tick, never while paused,
        // hidden, cancelled or already handed to foreground playback.
        if (current(candidate)) {
          if (isRetryableError(error) && candidate.attempts <= maxRetries) {
            candidate.state = 'failed';
            candidate.retryAt = now() + retryDelay;
          } else {
            candidate.state = 'unavailable';
          }
        }
        return null;
      });
    }
    function keepFor(seriesID, episode, quality, owner, mode) {
      if (entry && (entry.info.series_id !== seriesID || entry.info.episode + 1 !== episode ||
          (entry.info.quality || '') !== (quality || '') || entry.info.owner !== owner || (entry.info.mode || '') !== (mode || ''))) cancel();
    }
    function consume(target) {
      var previous = entry;
      if (!previous || previous.info.series_id !== target.series_id || previous.info.episode + 1 !== target.episode ||
          (previous.info.quality || '') !== (target.quality || '') || previous.info.owner !== target.owner || (previous.info.mode || '') !== (target.mode || '') ||
          (maxAge && previous.state === 'ready' && now() - previous.timing.ready_at >= maxAge) ||
          previous.target && previous.target.vid !== target.vid) { cancel(); return null; }
      // Keep an in-flight request alive across the natural episode switch. Its
      // only owner is now the foreground player, which can still cancel it.
      entry = null;
      previous.claimed = true;
      previous.expectedVid = target.vid;
      return { promise: previous.promise, timing: previous.timing, cancel: function () { invalidate(previous); } };
    }
    return { maybe: maybe, cancel: cancel, keepFor: keepFor, consume: consume };
  }
  function retryableError(error) {
    if (!error) return false;
    if (error.name === 'AbortError') return false;
    if (error.retryable === false) return false;
    if (error.retryable === true) return true;
    var code = String(error.code || '').toUpperCase();
    var status = Number(error.upstreamStatus || error.status);
    var message = String(error.message || error);
    if (/AUTH|LOGIN|PERMISSION|FORBIDDEN|UNAUTHORIZED|LOCKED|ACCESS|REJECTED|INVALID|MISSING|NO[_ -]?QUALITY|PARAMETER|EPISODE[_ -]?LIMIT/.test(code) ||
        /权限|无权|未授权|未登录|登录后|会员|付费|锁定|已锁|不可访问|暂不可播|暂不支持|超出可观看|试看结束|unauthorized|forbidden|locked|permission|access denied|login required|member only|paid episode|拒绝了播放请求|没有可播放清晰度|未返回.*(?:视频|片源)/i.test(message)) return false;
    if (status >= 400 && status < 500) return status === 408 || status === 425 || status === 429;
    if (code === 'VIDEO_MODEL_HTTP') return [408, 425, 429, 500, 502, 503, 504].indexOf(status) >= 0;
    if (/^(?:RANGE_UNAVAILABLE|RANGE_TIMEOUT|VIDEO_MODEL_EMPTY|UPSTREAM_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN)$/.test(code)) return true;
    return !status && (error.name === 'TypeError' || /timed? ?out|network|temporar|offline|failed to fetch/i.test(message));
  }
  function validVid(value) {
    return /^[0-9]{1,32}$/.test(String(value || ''));
  }
  function sameValue(left, right) {
    if (left == null || right == null) return left == null && right == null;
    return String(left) === String(right);
  }
  function nextPrefetchEpisode(detail, currentEpisode) {
    var videos = detail && detail.vid_list || [];
    var episodes = detail && detail.episodes || [];
    var current = Number(currentEpisode);
    if (!isFinite(current) || current < 1 || Math.floor(current) !== current) return null;
    var index = current;
    if (index >= videos.length) return null;
    var episode = episodes[index];
    // `locked_inferred` is produced from accessible_episode_cnt. That field
    // is useful for the episode picker but is not a reliable playability
    // decision, so let play/info make the final decision for prefetching.
    if (episode && episode.locked === true && episode.locked_inferred !== true) return null;
    var vid = episode && episode.video_id || videos[index];
    if (!validVid(vid)) return null;
    return { episode: index + 1, vid: String(vid) };
  }
  root.HongguoEpisodePrefetch = { create: create, nextPrefetchEpisode: nextPrefetchEpisode, retryableError: retryableError };
  if (typeof module === 'object' && module.exports) module.exports = root.HongguoEpisodePrefetch;
})(typeof window !== 'undefined' ? window : globalThis);
