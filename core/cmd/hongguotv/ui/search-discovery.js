(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoSearchDiscovery = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function normalize(data) {
    data = data || {};
    function items(rows, limit, playable) {
      var seen = Object.create(null);
      return (Array.isArray(rows) ? rows : []).filter(function (item) {
        if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100) return false;
        var id = String(item.series_id || '');
        if (playable && !/^[1-9][0-9]*$/.test(id)) return false;
        var key = id || item.query || item.title;
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      }).slice(0, limit);
    }
    var boards = [], seen = {};
    (Array.isArray(data.boards) ? data.boards : []).forEach(function (board) {
      if (!board || (board.id !== 'short' && board.id !== 'comic') || seen[board.id]) return;
      seen[board.id] = true;
      var rows = items(board.items, 6, true);
      if (rows.length) boards.push({ id: board.id, items: rows });
    });
    return { guesses: items(data.guesses, 4, false), boards: boards };
  }
  function create(options) {
    var active = false, pending = null, data = normalize(), expires = 0;
    var now = options.now || Date.now;
    function show() {
      active = true;
      options.render(data);
      if (now() < expires) return Promise.resolve(data);
      if (pending) return pending;
      pending = Promise.resolve().then(options.request).then(function (result) {
        data = normalize(result); expires = now() + (data.guesses.length || data.boards.length ? 600000 : 60000);
        return data;
      }, function () {
        data = normalize(); expires = now() + 60000;
        return data;
      }).then(function () {
        pending = null;
        // Late optional data must never reopen a submitted search/another page.
        if (active) options.render(data);
        return data;
      });
      return pending;
    }
    return { show: show, hide: function (preserveView) { active = false; if (!preserveView) options.render(normalize()); } };
  }
  return { create: create, normalize: normalize };
}));
