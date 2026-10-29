(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoEngagement = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function text(key, fallback) {
    var root = typeof window !== 'undefined' ? window : this;
    return root && root.HongguoI18n && typeof root.HongguoI18n.t === 'function' ? root.HongguoI18n.t(key, null, fallback) : fallback;
  }
  function countText(value) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0 || Math.floor(value) !== value) return '—';
    if (value < 10000) return String(value);
    var unit = value >= 100000000 ? 100000000 : 10000;
    return (Math.floor(value / unit * 10) / 10).toFixed(1).replace(/\.0$/, '') + (unit === 10000 ? text('ui.unitTenThousand', '万') : text('ui.unitBillion', '亿'));
  }
  function create(options) {
    var epoch = 0, target = null, data = null, request = null, cache = {};
    function key(item) { return item.series_id + ':' + item.vid; }
    var prewarmRequests = {};
    function cancel() {
      if (request && request.abort) request.abort(); request = null;
      Object.keys(prewarmRequests).forEach(function (id) {
        var pending = prewarmRequests[id];
        if (pending && pending.request && pending.request.abort) pending.request.abort();
      });
      prewarmRequests = {};
      ++epoch;
    }
    function clear() { cancel(); target = null; data = null; options.render(null, null); }
    function select(item, force) {
      if (!item || !item.series_id || !item.vid) { clear(); return; }
      if (!force && target && key(target) === key(item)) { options.render(target, data); return; }
      cancel(); target = { series_id: item.series_id, vid: item.vid }; data = null;
      var id = key(target), current = target, generation = epoch;
      var stored = cache[id];
      if (stored && Date.now() - stored.at < 45000) data = stored.data;
      options.render(target, data);
      if (data && !force) return;
      request = options.request(current);
      request.promise.then(function (result) {
        if (epoch !== generation || target !== current || !result || result.series_id !== current.series_id || result.vid !== current.vid) return;
        data = { likes: result.likes, favorites: result.favorites, comments: result.comments, episode_cover: result.episode_cover || '' };
        var keys = Object.keys(cache); if (keys.length >= 48) delete cache[keys[0]];
        cache[id] = { at: Date.now(), data: data }; request = null; options.render(target, data);
      }, function () { if (epoch === generation) { request = null; options.render(target, data); } });
    }
    function adjust(kind, amount, item) {
      if (!target || !item || key(target) !== key(item) || !data) return;
      var field = kind === 'like' ? 'likes' : 'favorites';
      if (typeof data[field] !== 'number') return;
      if (field === 'favorites') Object.keys(cache).forEach(function (id) {
        if (id.indexOf(target.series_id + ':') === 0 && typeof cache[id].data.favorites === 'number') cache[id].data.favorites = Math.max(0, cache[id].data.favorites + amount);
      });
      else data.likes = Math.max(0, data.likes + amount);
      options.render(target, data);
    }
    function commentTotal(item, total) {
      if (target && item && key(target) === key(item) && data && typeof total === 'number' && total >= 0) {
        data.comments = total; options.render(target, data);
      }
    }
    function prewarm(item) {
      if (!item || !item.series_id || !item.vid) return Promise.resolve(null);
      var id = key(item), stored = cache[id];
      if (stored && Date.now() - stored.at < 45000) return Promise.resolve(stored.data);
      if (prewarmRequests[id]) return prewarmRequests[id].promise;
      var current = { series_id: item.series_id, vid: item.vid };
      var pending = { request: options.request(current), promise: null };
      prewarmRequests[id] = pending;
      pending.promise = pending.request.promise.then(function (result) {
        if (prewarmRequests[id] !== pending || !result || result.series_id !== current.series_id || result.vid !== current.vid) return null;
        var value = { likes: result.likes, favorites: result.favorites, comments: result.comments, episode_cover: result.episode_cover || '' };
        var keys = Object.keys(cache); if (keys.length >= 48) delete cache[keys[0]];
        cache[id] = { at: Date.now(), data: value };
        return value;
      }, function () { return null; });
      pending.promise = pending.promise.then(function (value) {
        if (prewarmRequests[id] === pending) delete prewarmRequests[id];
        return value;
      }, function () {
        if (prewarmRequests[id] === pending) delete prewarmRequests[id];
        return null;
      });
      return pending.promise;
    }
    return { select: select, prewarm: prewarm, clear: clear, adjust: adjust, commentTotal: commentTotal,
      resetAccount: function () { clear(); cache = {}; } };
  }
  return { countText: countText, create: create };
}));
