(function (root) {
  'use strict';

  function itemsFor(rows, seriesID) {
    var seen = Object.create(null), items = [];
    (Array.isArray(rows) ? rows : []).forEach(function (item) {
      var id = item && String(item.series_id || '');
      if (!id || id === String(seriesID) || seen[id] || !item.title || item.upcoming || item.playable === false || items.length >= 20) return;
      seen[id] = true; items.push(item);
    });
    return items;
  }

  // The completed playback owns both the offer and its one-shot countdown.
  // A canceled/late timer must never start a different playback session.
  function create(options) {
    var entry = null, lastPlayback = null, open = false, timer = null, timerEpoch = 0;
    var now = options.now || function () { return Date.now(); };
    var schedule = options.schedule || function (callback, delay) { return setTimeout(callback, delay); };
    var unschedule = options.unschedule || function (handle) { clearTimeout(handle); };
    function cancelAutoplay() {
      ++timerEpoch;
      if (timer !== null) unschedule(timer);
      timer = null;
      if (entry) entry.canceled = true;
      if (options.countdown) options.countdown(null);
    }
    function reset() {
      cancelAutoplay();
      entry = null;
      open = false;
      options.hide(false, false);
    }
    function flush() {
      if (!entry) return false;
      if (!options.isCurrent(entry.playback)) { reset(); return false; }
      if (entry.shown || open || !options.canPresent()) return false;
      entry.shown = true; open = true;
      options.show(entry.items);
      return true;
    }
    function offer(playback, rows, policy) {
      if (!options.isCurrent(playback)) return false;
      if (entry && entry.playback === playback) return flush();
      // Background/reset can remove the view without changing playback.
      // A duplicate ended callback must not offer a fresh autoplay countdown.
      if (playback === lastPlayback) return false;
      var items = itemsFor(rows, playback.item.series_id);
      if (!items.length) return false;
      cancelAutoplay();
      lastPlayback = playback;
      entry = { playback: playback, items: items, shown: false, canceled: !!(policy && policy.manualOnly), started: false };
      return flush();
    }
    // The view calls ready only after opening and settling the first cover.
    function ready() {
      if (!open || !entry || entry.canceled || entry.started) return false;
      if (!options.isCurrent(entry.playback)) { reset(); return false; }
      if (!options.canAutoplay || !options.canAutoplay()) { cancelAutoplay(); return false; }
      entry.started = true;
      var owner = entry, epoch = ++timerEpoch, deadline = now() + 30000;
      function tick() {
        if (epoch !== timerEpoch || entry !== owner || !open) return;
        timer = null;
        if (!options.isCurrent(owner.playback)) { reset(); return; }
        if (!options.canAutoplay()) { cancelAutoplay(); return; }
        var remaining = Math.max(0, deadline - now());
        if (!remaining) { choose(0); return; }
        if (options.countdown) options.countdown(Math.ceil(remaining / 1000));
        timer = schedule(tick, Math.min(1000, remaining));
      }
      tick();
      return true;
    }
    function close(restoreFocus) {
      if (!open) return false;
      cancelAutoplay();
      open = false;
      options.hide(restoreFocus !== false, true);
      return true;
    }
    function choose(index) {
      if (!open || !entry || !options.isCurrent(entry.playback)) { reset(); return false; }
      var item = entry.items[index];
      if (!item) return false;
      reset();
      options.play(item);
      return true;
    }
    return { offer: offer, flush: flush, reset: reset, close: close, choose: choose, ready: ready,
      cancelAutoplay: cancelAutoplay, isOpen: function () { return open; } };
  }

  root.HongguoEndRecommendations = { create: create, itemsFor: itemsFor };
  if (typeof module === 'object' && module.exports) module.exports = root.HongguoEndRecommendations;
})(typeof window !== 'undefined' ? window : this);
