(function (root) {
  'use strict';
  // A single speculative episode. No media is attached to a second player.
  function create(options) {
    var entry = null;
    var now = options.now || Date.now;
    var maxRetries = options.maxRetries === 1 ? 1 : 0;
    var retryDelay = Math.max(0, Number(options.retryDelayMs) || 3000);
    var maxAge = Math.max(0, Number(options.maxAgeMs) || 0);
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
      cancelCache(candidate);
    }
    function key(info) {
      return [info.series_id, info.vid, info.episode, info.quality || '', info.mode || '', info.generation, info.owner].join(':');
    }
    function current(candidate) {
      return !candidate.cancelled && (entry === candidate || candidate.claimed) && !(candidate.request && candidate.request.signal.aborted);
    }
    function cancelCache(candidate) {
      var request = candidate && candidate.cacheRequest;
      if (request) { candidate.cacheRequest = null; request.abort(); }
    }
    function suspendCache() {
      if (entry) { entry.cacheReady = false; cancelCache(entry); }
    }
    function startCache(candidate) {
      if (!options.cache || typeof AbortController !== 'function' || !current(candidate) || candidate.claimed ||
          !candidate.cacheReady || candidate.cacheAttempted || !candidate.data || candidate.data.mode !== 'range') return;
      candidate.cacheAttempted = true;
      var request = new AbortController();
      candidate.cacheRequest = request;
      Promise.resolve().then(function () {
        if (!current(candidate) || candidate.claimed || candidate.cacheRequest !== request) return null;
        return options.cache(candidate.data, request.signal);
      }).then(function (data) {
        if (current(candidate) && !candidate.claimed && candidate.cacheRequest === request && data && data.path &&
            data.mode === 'full' && data.vid === candidate.target.vid && data.quality === candidate.data.quality) {
          candidate.data = data;
          candidate.timing.ready_at = now();
        }
      }).catch(function () {
        // Keep the prepared Range result; this attempt has no retry loop.
      }).then(function () {
        if (candidate.cacheRequest === request) candidate.cacheRequest = null;
      });
    }
    function maybe(info) {
      // A pause/buffer/seek may stop timeupdate events. The app also calls
      // suspendCache at those boundaries, without discarding Range metadata.
      if (entry) {
        entry.cacheReady = key(info) === entry.key && info.cache_ready === true && info.active && info.started &&
          !info.paused && !info.ended && isFinite(info.stable_seconds) && info.stable_seconds >= stableThreshold(info);
        if (!entry.cacheReady) cancelCache(entry);
      }
      if (!info.active || !info.started || info.paused || info.ended || !isFinite(info.duration) ||
          !(info.duration > 0) || !isFinite(info.position) || info.position < 0 ||
          !isFinite(info.stable_seconds) || info.stable_seconds < stableThreshold(info)) return;
      var identity = key(info);
      if (entry && entry.key === identity) {
        startCache(entry);
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
        cacheReady: info.cache_ready === true, cacheAttempted: false, cacheRequest: null, data: null,
        request: typeof AbortController === 'function' ? new AbortController() : null };
      entry = candidate;
      run(candidate);
    }
    function run(candidate) {
      candidate.state = 'pending';
      candidate.data = null;
      cancelCache(candidate);
      candidate.attempts++;
      candidate.target = null;
      candidate.timing.ready_at = 0;
      candidate.promise = Promise.resolve().then(function () {
        if (!current(candidate)) return null;
        return options.lookup(candidate.info, candidate.request && candidate.request.signal);
      }).then(function (target) {
        var info = candidate.info;
        if (!current(candidate) || !target || !/^[0-9]+$/.test(target.vid || '') || target.vid === info.vid || target.series_id !== info.series_id ||
            candidate.expectedVid && candidate.expectedVid !== target.vid) return null;
        candidate.target = target;
        return options.prepare(target, candidate.request && candidate.request.signal);
      }).then(function (data) {
        if (!current(candidate)) return null;
        candidate.state = data && data.path ? 'ready' : 'unavailable';
        if (candidate.state === 'ready') {
          candidate.data = data;
          candidate.timing.ready_at = now();
          startCache(candidate);
        }
        return data;
      }).catch(function () {
        // Retry only on a later eligible playback tick, never while paused,
        // hidden, cancelled or already handed to foreground playback.
        if (current(candidate)) {
          candidate.state = 'failed';
          candidate.retryAt = now() + retryDelay;
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
      cancelCache(previous);
      // Never wait for the optional download, or replace a source after it
      // has been handed to playback. Pending Range preparation still transfers.
      if (previous.data) previous.promise = Promise.resolve(previous.data);
      return { promise: previous.promise, timing: previous.timing, cancel: function () { invalidate(previous); } };
    }
    return { maybe: maybe, cancel: cancel, keepFor: keepFor, consume: consume, suspendCache: suspendCache };
  }
  function isCacheReady(info) {
    if (!info || info.paused || info.seeking || info.waiting) return false;
    if (info.mode === 'full') return true;
    var position = Number(info.position), duration = Number(info.duration), ranges = info.buffered;
    if (!isFinite(position) || position < 0 || !isFinite(duration) || duration <= 0 || position > duration || !ranges) return false;
    try {
      var length = Number(ranges.length);
      if (!isFinite(length) || length < 1) return false;
      for (var i = 0; i < length; i++) {
        var start = Number(ranges.start(i)), end = Number(ranges.end(i));
        if (isFinite(start) && isFinite(end) && start <= position && end >= duration - 0.25) return true;
      }
    } catch (ignored) {}
    return false;
  }
  function nextUnlockedEpisodes(detail, currentEpisode, maximum) {
    var videos = detail && detail.vid_list || [];
    var episodes = detail && detail.episodes || [];
    var accessible = Number(detail && detail.accessible_episode_cnt) || 0;
    var limit = Math.min(4, Math.max(0, Number(maximum) || 4));
    var result = [];
    for (var index = Math.max(0, Number(currentEpisode) || 0); index < videos.length && result.length < limit; index++) {
      var episode = episodes[index];
      if ((episode && episode.locked === true) || (!episode && accessible > 0 && index >= accessible)) continue;
      var vid = episode && episode.video_id || videos[index];
      if (!/^[0-9]{1,32}$/.test(String(vid || ''))) continue;
      result.push({ episode: index + 1, vid: String(vid) });
    }
    return result;
  }
  root.HongguoEpisodePrefetch = { create: create, nextUnlockedEpisodes: nextUnlockedEpisodes, isCacheReady: isCacheReady };
  if (typeof module === 'object' && module.exports) module.exports = root.HongguoEpisodePrefetch;
})(typeof window !== 'undefined' ? window : globalThis);
