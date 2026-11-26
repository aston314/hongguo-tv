'use strict';

// Numeric App IDs and a complete, ordered directory are required for playback.
// Web v1_ preview IDs belong to a different protocol and are never forwarded.
function id(value) { return typeof value === 'string' && /^[0-9]{1,32}$/.test(value) && value !== '0'; }
function integer(value) { return /^(0|[1-9][0-9]*)$/.test(String(value)) ? Number(value) : -1; }
function truth(value) { return value === true || value === 1 || value === '1' || value === 'true'; }
function complete(item) {
  var vids = item && item.vid_list, count = item && item.episode_count, seen = Object.create(null);
  if (!Array.isArray(vids) || count < 0 || count > 10000 || count !== vids.length) return false;
  for (var i = 0; i < vids.length; i++) {
    if (!id(vids[i]) || seen[vids[i]]) return false;
    seen[vids[i]] = true;
  }
  return true;
}
function parse(payload, seriesID) {
  function invalid() { throw new Error('分集目录不完整或身份不一致，请重试'); }
  var entry = payload && payload.data && payload.data[seriesID], video = entry && entry.video_data;
  if (!payload || String(payload.code) !== '0' || !video || String(video.content_type) === '1003') invalid();
  if (String(video.series_id_str || video.series_id || '') !== seriesID) invalid();
  ['series_id', 'series_id_str'].forEach(function (key) { if (video[key] != null && String(video[key]) !== seriesID) invalid(); });
  var rows = video.video_list, count = integer(video.episode_cnt);
  if (!Array.isArray(rows) || count < 0 || count > 10000 || count !== rows.length || truth(entry.has_more) || truth(video.has_more)) invalid();
  var directory = { episode_count: count, accessible_episode_cnt: count, vid_list: [], episodes: [] };
  rows.forEach(function (row, i) {
    if (!row || !id(String(row.vid || '')) || integer(row.vid_index) !== i + 1) invalid();
    ['series_id', 'series_id_str'].forEach(function (key) { if (row[key] != null && String(row[key]) !== seriesID) invalid(); });
    var vid = String(row.vid);
    directory.vid_list.push(vid);
    directory.episodes.push({ index: i + 1, video_id: vid, title: '第' + (i + 1) + '集', locked: truth(row.disable_play) });
  });
  if (!complete(directory)) invalid();
  directory.vid = directory.vid_list[0] || '';
  return { video: video, directory: directory };
}
module.exports = { complete: complete, parse: parse };
