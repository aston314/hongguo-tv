'use strict';

// Optional public metadata only. Do not reuse playback jobs or account state.
var query = {
  user_is_login: '0', bookstore_tab: '16', bookstore_tab_type: '16', scene: '10', limit: '0', tab_name: 'feed',
  from: 'search_input_page', query_history_removed: 'false', offset: '0', search_middle_page_version: '4',
  search_source: '1', new_search_middle_page: 'true', hot_word_exchange: 'false'
};
function parse(payload, normalize, decode) {
  if (!payload || String(payload.code) !== '0') throw new Error('热门搜索暂不可用');
  var result = { guesses: [], boards: [] }, boards = {};
  function items(rows, board, limit) {
    var out = [], seen = {};
    (Array.isArray(rows) ? rows : []).some(function (row, index) {
      if (!row || typeof row !== 'object') return false;
      var title = String(row.title || '').replace(/\s+/g, ' ').trim();
      var kind = String(row.content_type == null ? '' : row.content_type);
      if (!title || title.length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(title) || ['', '1', '7', '1004'].indexOf(kind) < 0) return false;
      if (board === 'mixed' && !kind) return false;
      var id = String(row.series_id_str || row.series_id || '');
      var key = id, item;
      if (!/^[1-9][0-9]*$/.test(id)) {
        if (board) return false;
        key = 'query:' + title; item = { title: title, query: title };
      } else {
        item = normalize(row);
        if (!item) return false;
        item.series_id = id; item.title = title;
        item.content_type = kind || (board === 'comic' ? '1004' : '1');
        item.position = index + 1; item.search_score = String(row.card_tips || row.rec_text || '');
      }
      if (!Object.prototype.hasOwnProperty.call(seen, key)) { seen[key] = true; out.push(item); }
      return out.length >= limit;
    });
    return out;
  }
  function visit(value, depth) {
    if (depth > 8) return;
    if (typeof value === 'string') {
      if (value.length > 2 * 1024 * 1024) return;
      try { visit(decode(value), depth + 1); } catch (ignored) {}
    } else if (Array.isArray(value)) {
      value.slice(0, 128).forEach(function (cell) { visit(cell, depth + 1); });
    } else if (value && typeof value === 'object') {
      var name = value.cell_name;
      if (name === '猜你想搜' && !result.guesses.length) {
        result.guesses = items(value.video_data, '', 4);
        if (!result.guesses.length) result.guesses = items((Array.isArray(value.search_tag_data) ? value.search_tag_data : []).map(function (tag) { return { title: tag && tag.tag_title }; }), '', 4);
      }
      var id = name === '短剧热搜榜' ? 'short' : name === '漫剧热搜榜' ? 'comic' : '';
      if (id && !(boards[id] || []).length) boards[id] = items(value.video_data, id, 6);
      if (name === '热搜榜') items(value.video_data, 'mixed', 6).forEach(function (item) {
        var kind = item.content_type === '1004' ? 'comic' : 'short';
        if (!boards[kind]) boards[kind] = [];
        if (boards[kind].length < 6 && !boards[kind].some(function (row) { return row.series_id === item.series_id; })) boards[kind].push(item);
      });
      visit(value.lynx_data, depth + 1); visit(value.cell_data, depth + 1);
    }
  }
  visit(payload.data, 0);
  ['short', 'comic'].forEach(function (id) { if ((boards[id] || []).length) result.boards.push({ id: id, items: boards[id] }); });
  return result;
}
function create(options) {
  var pending = null, value, error, expires = 0, now = options.now || Date.now;
  return function () {
    if (now() < expires) return error ? Promise.reject(error) : Promise.resolve(value);
    if (pending) return pending;
    pending = Promise.resolve().then(function () { return options.request(query); }).then(function (payload) {
      return parse(payload, options.normalize, options.decode);
    }).then(function (result) {
      value = result; error = null;
      expires = now() + (value.guesses.length || value.boards.length ? 600000 : 60000);
      pending = null; return value;
    }, function (err) {
      pending = null; error = err; expires = now() + 60000; throw err;
    });
    return pending;
  };
}
module.exports = { create: create, parse: parse };
