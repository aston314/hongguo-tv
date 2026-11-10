(function (root) {
  'use strict';

  function seasonIndex(item) {
    var value = Number(item && item.season_index);
    return isFinite(value) && value > 0 && Math.floor(value) === value ? value : 0;
  }

  // Use the same strict adjacent-season rule as automatic continuation.
  // A catalog can omit earlier seasons: its row count is not always a total.
  function describe(items, seriesID) {
    if (!Array.isArray(items)) return null;
    var current = items.filter(function (item) { return item && item.series_id === seriesID; });
    if (current.length !== 1) return null;
    var index = seasonIndex(current[0]);
    if (!index || items.filter(function (item) { return seasonIndex(item) === index; }).length !== 1) return null;
    var successors = items.filter(function (item) { return seasonIndex(item) === index + 1; });
    if (successors.length !== 1) return null;
    var next = successors[0];
    if (!next.playable || next.upcoming || !next.series_id || next.series_id === seriesID || !next.vid || !(next.episode_count > 0)) return null;
    var seen = {}, complete = true;
    items.forEach(function (item) {
      var number = seasonIndex(item);
      if (!number || number > items.length || seen[number]) complete = false;
      seen[number] = true;
    });
    return { next: next, current: index, season: index + 1, total: complete ? items.length : 0 };
  }

  function create(options) {
    var shown = null;
    function reset() {
      if (shown) options.hide();
      shown = null;
    }
    function update(playback, video, items, allowed) {
      var item = playback && playback.item;
      var count = item ? Math.max(Number(item.episode_count) || 0, Array.isArray(item.vid_list) ? item.vid_list.length : 0) : 0;
      var remaining = video ? Number(video.duration) - Number(video.currentTime) : NaN;
      if (!allowed || !playback || !playback.started || !count || playback.episode !== count ||
          !video || video.paused || video.ended || video.seeking || !isFinite(video.duration) || !(video.duration > 0) || !(video.currentTime >= 0) ||
          !isFinite(remaining) || remaining <= 0 || remaining > 3) { reset(); return false; }
      var model = describe(items, item.series_id);
      if (!model) { reset(); return false; }
      if (!shown || shown.playback !== playback || shown.next !== model.next || shown.total !== model.total) {
        shown = { playback: playback, next: model.next, total: model.total };
        options.show(model);
      }
      return true;
    }
    // Display only: no requests, timers, focus changes, seeks or playback calls.
    return { update: update, reset: reset };
  }

  root.HongguoNextSeasonHint = { describe: describe, create: create };
  if (typeof module === 'object' && module.exports) module.exports = root.HongguoNextSeasonHint;
})(typeof window !== 'undefined' ? window : this);
