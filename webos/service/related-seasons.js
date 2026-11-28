// Public related-work metadata only; "同IP" and synthesized season labels are
// never sufficient evidence for automatic season continuation.
'use strict';

function query(id) {
  return {
    scene: '10', from: 'detail_page_more_related', book_id: id, new_search_middle_page: 'false',
    bookstore_tab_type: '0', query_history_removed: 'false', user_is_login: '0', bookstore_tab: '0',
    search_middle_page_version: '0', pad_column_detail: '0', hot_word_exchange: 'false',
    device_level: '3', limit: '0', offset: '0', is_horizontal_screen: 'false',
    reader_single_col_from_ip_strategy: 'false', version_code: '72232',
    manifest_version_code: '72232', update_version_code: '72232', pv_player: '72232',
    version_name: '7.2.2.32', host_abi: 'arm64-v8a', dragon_device_type: 'phone',
    compliance_status: '0', need_personal_recommend: '1', player_so_load: '1', is_android_pad_screen: '0'
  };
}

function titleSeason(title) {
  var match = /第([0-9零〇一二两三四五六七八九十百]+)季\s*(?:完结篇|完結篇)?$/.exec(title || '');
  if (!match) return 0;
  if (/^[0-9]+$/.test(match[1])) return Number(match[1]);
  var total = 0, digit = 0, digits = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  for (var i = 0; i < match[1].length; i++) {
    var c = match[1][i];
    if (c === '十' || c === '百') { total += Math.max(digit, 1) * (c === '十' ? 10 : 100); digit = 0; }
    else { if (digits[c] === undefined) return -1; digit = digits[c]; }
  }
  return total + digit;
}

function parse(payload, id, normalize) {
  if (!payload || String(payload.code) !== '0' || !Array.isArray(payload.data)) throw Error('相关作品响应无效');
  var rows = [], ids = Object.create(null), seasons = Object.create(null);
  payload.data.forEach(function (block) {
    if (!block || typeof block !== 'object') throw Error('相关作品区块无效');
    if (Number(block.show_type) !== 547 && block.cell_name !== '相关作品') return;
    if (!Array.isArray(block.video_data)) throw Error('相关作品剧集列表无效');
    block.video_data.forEach(function (row) {
      if (!row || typeof row !== 'object') throw Error('相关作品条目无效');
      var label = row.tag_info && row.tag_info.text, match = /^第([1-9][0-9]*)季$/.exec(label || '');
      if (!match) return;
      var season = Number(match[1]), item = normalize(row);
      if (!item || !/^[1-9][0-9]{0,31}$/.test(item.series_id) || season > 999 ||
          [1004, 1007].indexOf(Number(row.content_type)) < 0) throw Error('相关作品季信息无效');
      if (item.series_id === id) return;
      var fromTitle = titleSeason(item.title);
      if (item.season_index > 0 && item.season_index !== season || fromTitle !== 0 && fromTitle !== season ||
          ids[item.series_id] || seasons[season]) throw Error('相关作品季关系存在冲突');
      ids[item.series_id] = true; seasons[season] = true;
      item.season_index = season; item.label = label; item.is_multi_season = true;
      item.upcoming = Number(row.content_type) === 1007 || !!row.subscribe_item;
      item.playable = !item.upcoming && !row.disable_play && item.episode_count > 0 && /^[1-9][0-9]{0,31}$/.test(item.vid || '');
      item.reservation_id = ''; item.reserved = false;
      if (item.upcoming) {
        item.vid = '';
        if (row.subscribe_item && /^[1-9][0-9]{0,31}$/.test(String(row.subscribe_item.item_id || ''))) {
          item.reservation_id = item.series_id;
          item.reserved = row.subscribe_item.is_subscribed === true || row.subscribe_item.is_subscribed === 1;
        }
      }
      rows.push(item);
    });
  });
  return rows.sort(function (a, b) { return a.season_index - b.season_index; });
}

function create(options) {
  function read(id) { return options.request(query(id)).then(function (p) { return parse(p, id, options.normalize); }); }
  function load(id) {
    return read(id).then(function (rows) {
      if (!rows.length) return { items: [], source: 'related-no-seasons' };
      return read(rows[0].series_id).then(function (back) {
        var current = back.filter(function (item) { return item.series_id === id; })[0];
        if (!current) throw Error('相关作品未双向确认当前季');
        if (rows.some(function (item) { return item.season_index === current.season_index; })) throw Error('相关作品季关系存在冲突');
        var next = rows.filter(function (item) { return item.season_index === current.season_index + 1; })[0];
        var check = !next || !next.playable || next.series_id === rows[0].series_id ? Promise.resolve() :
          read(next.series_id).then(function (reverse) {
            if (!reverse.some(function (item) { return item.series_id === id && item.season_index === current.season_index; })) throw Error('相关作品未双向确认下一季');
          });
        return check.then(function () {
          return { items: rows.concat([current]).sort(function (a, b) { return a.season_index - b.season_index; }), source: 'related-seasons' };
        });
      });
    });
  }
  return { load: load };
}

module.exports = { query: query, parse: parse, create: create };
