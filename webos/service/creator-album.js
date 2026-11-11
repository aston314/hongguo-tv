'use strict';

function text(value) { return value == null ? '' : String(value).trim(); }
function first() { for (var i = 0; i < arguments.length; i++) { if (text(arguments[i])) return text(arguments[i]); } return ''; }
function validID(value) { return /^[0-9]{1,32}$/.test(value); }
function hasMore(value) { return value === true || value === 1 || value === '1' || value === 'true'; }
function normalize(album, card) {
  album = album || {}; card = card || {};
  var id = first(album.album_id_str, album.album_id), cardID = first(card.series_id_str, card.series_id);
  if (!validID(id) || cardID && cardID !== id) return null;
  return { series_id: id, content_type: '1003', title: first(album.title, card.series_title, card.title, '未命名合集'),
    cover: first(album.cover, card.series_cover, card.cover), intro: first(album.intro, card.series_intro),
    episode_count: Number(album.episode_cnt) || 0, series_status: text(album.series_status) };
}
function parse(payload, albumID) {
  if (!payload || text(payload.code) !== '0') throw new Error('云端未确认合集请求成功');
  var data = payload.data || {}, album = data.album_data || {}, item = normalize(album);
  if (!item || item.series_id !== albumID) throw new Error('合集详情与请求不一致');
  var rows = album.video_detail_list, seen = Object.create(null);
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000 || hasMore(data.has_more) || hasMore(album.has_more) ||
      item.episode_count > 0 && item.episode_count !== rows.length) throw new Error('合集目录不完整，请重试');
  item.episodes = rows.map(function (row, index) {
    row = row || {};
    var id = first(row.series_id_str, row.series_id);
    if (!validID(id) || seen[id] || text(row.content_type) !== '1001') throw new Error('合集视频数据无效，请重试');
    seen[id] = true;
    return { index: index + 1, video_id: id, title: first(row.series_title, '第' + (index + 1) + '集'), locked: false };
  });
  item.vid_list = item.episodes.map(function (row) { return row.video_id; });
  item.vid = item.vid_list[0];
  item.episode_count = item.accessible_episode_cnt = rows.length;
  return item;
}
module.exports = { normalize: normalize, parse: parse };
