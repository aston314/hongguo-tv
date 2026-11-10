(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoWatchStatistics = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function dayKey(value) {
    var d = new Date(value), pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function localDate(key) { var p = key.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function genreFor(tags) {
    for (var i = 0; i < (tags || []).length; i++) {
      if (typeof tags[i] !== 'string') continue;
      var tag = tags[i].trim();
      if (['__proto__', 'constructor', 'prototype', 'unknown'].indexOf(tag) >= 0) continue;
      if (!tag || /[\x00-\x1f\x7f/\\<>:]/.test(tag) || /^(真人剧?|短剧|漫剧|AI剧|AI短剧|real|comic|ai)$/i.test(tag)) continue;
      return tag.slice(0, 40);
    }
    return '';
  }
  function createCollector(options) {
    var anchor = null, pending = [], queued = [], inFlight = null, scheduled = null, retry = null;
    var serial = 0, seed = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    var mono = options.monotonic || function () { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); };
    var clock = options.clock || Date.now;
    var later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    function capture() {
      var s = options.snapshot();
      if (!s || !s.key) return null;
      s.at = mono(); s.wall = clock();
      s.position = Number(s.position) || 0; s.rate = Number(s.rate) || 1;
      return s;
    }
    function append(a, start, end, amount) {
      if (amount < 1 || end <= start) return;
      var midnight = new Date(start); midnight.setHours(24, 0, 0, 0);
      var split = Math.min(end, midnight.getTime());
      var first = Math.round(amount * (split - start) / (end - start));
      var pieces = [{ day: dayKey(start), ms: first }];
      if (split < end) pieces.push({ day: dayKey(split), ms: amount - first });
      pieces.forEach(function (piece) {
        if (piece.ms < 1) return;
        var found = null, type = /^(real|comic|ai)$/.test(a.type) ? a.type : 'unknown', genre = genreFor(a.tags);
        pending.some(function (row) { if (row.owner === a.owner && row.day === piece.day && row.type === type && row.genre === genre && row.series_id === a.series_id) { found = row; return true; } return false; });
        if (found) found.ms += piece.ms;
        else pending.push({ owner: a.owner, day: piece.day, ms: piece.ms, type: type, genre: genre, series_id: a.series_id || '' });
      });
    }
    function measure(next) {
      if (!anchor || !next || anchor.key !== next.key || anchor.owner !== next.owner) return;
      var elapsed = next.at - anchor.at, advance = next.position - anchor.position;
      // A frozen clock, suspension or seek is not watching. Keep the anchor
      // while native progress is rounded to whole seconds, then count the
      // elapsed real time once advancing playback confirms it.
      if (elapsed > 0 && elapsed <= 5000 && advance > 0 && advance <= elapsed / 1000 * anchor.rate + 1) {
        var ms = Math.round(Math.min(elapsed, advance / anchor.rate * 1000));
        append(anchor, anchor.wall, next.wall, ms);
      }
    }
    function drain() {
      if (inFlight) return inFlight;
      if (!queued.length) return Promise.resolve(true);
      var batch = queued[0];
      inFlight = Promise.resolve().then(function () { return options.request(batch); }).then(function () {
        if (queued[0] === batch) queued.shift();
        return true;
      }, function (error) {
        if (error && (error.status === 400 || error.status === 409)) { if (queued[0] === batch) queued.shift(); }
        if (!retry) retry = later(function () { retry = null; drain(); }, 30000);
        return false;
      }).then(function (ok) {
        inFlight = null;
        if (ok && queued.length) return drain();
        return ok;
      });
      return inFlight;
    }
    function flush() {
      if (scheduled) { cancel(scheduled); scheduled = null; }
      if (pending.length) {
        var groups = Object.create(null);
        pending.forEach(function (row) {
          var key = JSON.stringify(row.owner);
          if (!groups[key]) groups[key] = { owner_id: row.owner, id: seed + '-' + (++serial), items: [] };
          var left = row.ms;
          while (left > 0) { var chunk = Math.min(60000, left); groups[key].items.push({ day: row.day, ms: chunk, type: row.type, genre: row.genre, series_id: row.series_id }); left -= chunk; }
        });
        Object.keys(groups).forEach(function (key) { queued.push(groups[key]); });
        pending = [];
        // At most six minutes of unsent batches. An unavailable statistics
        // store must not grow memory indefinitely or affect playback.
        while (queued.length > 12) queued.splice(inFlight ? 1 : 0, 1);
      }
      return drain();
    }
    function scheduleFlush() { if (!scheduled) scheduled = later(function () { scheduled = null; flush(); }, 0); }
    function observe() {
      var next = capture();
      if (!next || !next.eligible) { stop(true); return; }
      measure(next);
      if (!anchor || next.key !== anchor.key || next.owner !== anchor.owner || next.position !== anchor.position || next.at - anchor.at > 5000) anchor = next;
      var total = pending.reduce(function (sum, row) { return sum + row.ms; }, 0);
      if (total >= 30000 || pending.length >= 64) scheduleFlush();
    }
    function stop(countTail) {
      if (countTail) measure(capture());
      anchor = null;
      if (pending.length) scheduleFlush();
    }
    function bind(media, host) {
      media.addEventListener('timeupdate', observe);
      ['playing', 'canplay'].forEach(function (name) { media.addEventListener(name, observe); });
      ['pause', 'waiting', 'stalled', 'ended', 'error'].forEach(function (name) { media.addEventListener(name, function () { stop(true); }); });
      ['seeking', 'emptied', 'loadstart'].forEach(function (name) { media.addEventListener(name, function () { stop(false); }); });
      media.addEventListener('seeked', observe);
      media.addEventListener('ratechange', function () { stop(true); observe(); });
      if (host) host.addEventListener('pagehide', function () { stop(true); flush(); });
    }
    return { observe: observe, stop: stop, flush: flush, bind: bind };
  }
  function summary(data, today) {
    var days = data.days || {}, date = localDate(today), week = new Date(date.getTime());
    week.setDate(week.getDate() - (week.getDay() + 6) % 7);
    var weekStart = dayKey(week), monthStart = today.slice(0, 8) + '01';
    var out = { today: 0, week: 0, month: 0, recent: [], types: Object.create(null), genres: Object.create(null) };
    Object.keys(days).forEach(function (key) {
      if (key > today) return;
      var row = days[key] || {}, ms = Math.max(0, Number(row.ms) || 0);
      if (key === today) out.today += ms;
      if (key >= weekStart) out.week += ms;
      if (key >= monthStart) {
        out.month += ms;
        ['types', 'genres'].forEach(function (kind) { Object.keys(row[kind] || {}).forEach(function (name) { out[kind][name] = (out[kind][name] || 0) + Math.max(0, Number(row[kind][name]) || 0); }); });
      }
    });
    for (var i = 6; i >= 0; i--) {
      var d = new Date(date.getTime()); d.setDate(d.getDate() - i); var key = dayKey(d);
      out.recent.push({ day: key, weekday: d.getDay(), ms: Math.max(0, Number(days[key] && days[key].ms) || 0) });
    }
    return out;
  }
  function createView(options) {
    var root = options.root, t = options.text, generation = 0, open = false, data = null, current = null, kind = 'types', selected = 6;
    var buttons = root.querySelectorAll('[data-stat-kind]');
    function q(selector) { return root.querySelector(selector); }
    function visible(el, value) { el.classList.toggle('is-hidden', !value); }
    function duration(ms) {
      var minutes = Math.floor(ms / 60000);
      if (!minutes && ms > 0) return t('stats.lessMinute', '不足 1 分钟');
      return minutes < 60 ? t('stats.minutes', '{n} 分钟', { n: minutes }) : t('stats.hoursMinutes', '{h} 小时 {m} 分', { h: Math.floor(minutes / 60), m: minutes % 60 });
    }
    function shortDate(key) { var d = localDate(key); return t('stats.shortDate', '{month}/{day}', { month: d.getMonth() + 1, day: d.getDate() }); }
    function dateLabel(row) { return row.day === dayKey(Date.now()) ? t('stats.today', '今天') : t('stats.weekday' + row.weekday, ['周日','周一','周二','周三','周四','周五','周六'][row.weekday]); }
    function selectDay(index) {
      selected = index;
      if (!current) return;
      var row = current.recent[index];
      q('[data-stat-selected]').textContent = shortDate(row.day) + ' · ' + duration(row.ms);
      root.querySelectorAll('[data-stat-day]').forEach(function (button, i) { button.setAttribute('aria-pressed', String(i === index)); });
    }
    function renderPreferences() {
      if (!current) return;
      buttons.forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.statKind === kind)); });
      var rows = Object.keys(current[kind]).map(function (key) { return { key: key, ms: current[kind][key] }; }).sort(function (a, b) { return b.ms - a.ms || a.key.localeCompare(b.key); });
      var list = q('[data-stat-preferences]'); list.innerHTML = '';
      rows.forEach(function (row, i) {
        var line = document.createElement('div'); line.className = 'watch-stat-preference watch-stat-action';
        line.tabIndex = 0; line.setAttribute('role', 'listitem'); line.dataset.statPreference = String(i); line.dataset.focus = 'stat-preference-' + i;
        var label = document.createElement('div'); label.className = 'watch-stat-preference-label';
        var name = document.createElement('span');
        name.textContent = kind === 'types' ? ({ real: t('channel.real', '真人剧'), comic: t('channel.comic', '漫剧'), ai: t('rank.ai', 'AI剧'), unknown: t('stats.unknown', '未分类') })[row.key] || t('stats.unknown', '未分类') : row.key === 'unknown' ? t('stats.unknown', '未分类') : row.key;
        var percent = document.createElement('span'); var value = current.month ? Math.round(row.ms / current.month * 100) : 0;
        percent.textContent = value < 1 && row.ms > 0 ? '<1%' : value + '%'; label.appendChild(name); label.appendChild(percent);
        var track = document.createElement('div'); track.className = 'watch-stat-track';
        var fill = document.createElement('div'); fill.className = 'watch-stat-fill'; fill.style.width = Math.max(.5, value) + '%'; fill.style.opacity = String(i === 0 ? 1 : .65); track.appendChild(fill);
        line.appendChild(label); line.appendChild(track); list.appendChild(line);
      });
      visible(q('[data-stat-preference-empty]'), !rows.length);
      q('[data-stat-preference-note]').textContent = kind === 'types' ? t('stats.preferenceNote', '按实际观看时长统计') : t('stats.genreNote', '按观看时长 · 每部剧取主要题材');
    }
    function render() {
      if (!data) return;
      current = summary(data, dayKey(Date.now()));
      ['today','week','month'].forEach(function (key) { q('[data-stat-value="' + key + '"]').textContent = duration(current[key]); });
      q('[data-stat-date]').textContent = shortDate(dayKey(Date.now()));
      q('[data-stat-since]').textContent = data.since ? t('stats.since', '从 {date} 开始记录', { date: data.since }) : t('stats.sinceToday', '从今天开始记录');
      var total = 0, max = 0;
      current.recent.forEach(function (row) { total += row.ms; max = Math.max(max, row.ms); });
      var ceiling = Math.max(10, Math.ceil(max / 60000 / 30) * 30);
      q('[data-stat-axis-max]').textContent = ceiling;
      q('[data-stat-axis-mid]').textContent = Math.round(ceiling / 2);
      q('[data-stat-total]').textContent = t('stats.sevenTotal', '7 天共 {time}', { time: duration(total) });
      visible(q('[data-stat-chart]'), total > 0); visible(q('[data-stat-trend-empty]'), total === 0);
      var columns = q('[data-stat-columns]'); columns.innerHTML = '';
      current.recent.forEach(function (row, index) {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'watch-stat-day watch-stat-action'; button.dataset.statDay = index; button.dataset.focus = 'stat-day-' + index;
        button.setAttribute('aria-label', row.day + ' · ' + duration(row.ms));
        var graphic = document.createElement('span'); graphic.className = 'watch-stat-graphic';
        var bar = document.createElement('span'); bar.className = 'watch-stat-bar'; bar.style.height = (row.ms / 60000 / ceiling * 100) + '%';
        var amount = document.createElement('span'); amount.className = 'watch-stat-bar-value'; amount.textContent = row.ms > 0 && row.ms < 60000 ? '<1' : Math.floor(row.ms / 60000); bar.appendChild(amount); graphic.appendChild(bar);
        var label = document.createElement('span'); label.className = 'watch-stat-day-label'; label.textContent = dateLabel(row);
        var date = document.createElement('span'); date.className = 'watch-stat-day-date'; date.textContent = shortDate(row.day); label.appendChild(date);
        button.appendChild(graphic); button.appendChild(label); columns.appendChild(button);
      });
      selectDay(selected); renderPreferences();
    }
    function load() {
      var token = ++generation, owner = options.owner();
      data = null; current = null;
      q('[data-stat-message]').textContent = t('common.loading', '加载中…');
      visible(q('[data-stat-message]'), true); visible(q('[data-stat-content]'), false); visible(q('[data-stat-retry]'), false);
      Promise.resolve().then(function () { return options.flush(); }).then(function () { return options.request(owner); }).then(function (value) {
        if (!open || token !== generation || owner !== options.owner()) return;
        data = value; render(); visible(q('[data-stat-message]'), false); visible(q('[data-stat-content]'), true);
      }).catch(function () {
        if (!open || token !== generation || owner !== options.owner()) return;
        q('[data-stat-message]').textContent = t('stats.loadFailed', '观看统计暂不可用，请重试'); visible(q('[data-stat-retry]'), true);
      });
    }
    root.addEventListener('click', function (event) {
      var button = event.target.closest('button'); if (!button || !root.contains(button)) return;
      if (button.hasAttribute('data-stat-day')) selectDay(Number(button.dataset.statDay));
      if (button.hasAttribute('data-stat-kind')) { kind = button.dataset.statKind; renderPreferences(); }
      if (button.hasAttribute('data-stat-retry')) load();
      if (button.hasAttribute('data-stat-back')) options.close();
    });
    root.addEventListener('focusin', function (event) { if (event.target.hasAttribute('data-stat-day')) selectDay(Number(event.target.dataset.statDay)); });
    return { show: function () { open = true; selected = 6; load(); }, hide: function () { open = false; ++generation; }, isOpen: function () { return open; }, reload: load, render: render };
  }
  return { dayKey: dayKey, summary: summary, genreFor: genreFor, createCollector: createCollector, createView: createView };
}));
