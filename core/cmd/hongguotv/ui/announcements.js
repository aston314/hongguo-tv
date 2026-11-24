(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoAnnouncements = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var PREFIX = 'hongguo-tv-announcement-read:';
  var MAX_ITEMS = 12;

  function text(value) { return String(value == null ? '' : value).trim(); }
  function bool(value) { return value === true; }
  function storageGet(storage, key) {
    try { return storage && storage.getItem(key) === '1'; } catch (ignored) { return false; }
  }
  function storageSet(storage, key) {
    try { if (storage) storage.setItem(key, '1'); } catch (ignored) {}
  }
  function isExpired(item, now) {
    if (!item.expires_at) return false;
    var stamp = Date.parse(item.expires_at);
    return !isFinite(stamp) || stamp <= now;
  }
  function normalizeItem(item, now) {
    if (!item || typeof item !== 'object' || !bool(item.enabled) || !text(item.id) || !text(item.title) || isExpired(item, now)) return null;
    var action = item.action && item.action.type === 'check_update' ? {
      type: 'check_update', label: text(item.action.label)
    } : null;
    return {
      id: text(item.id), kind: text(item.kind), level: text(item.level), status: text(item.status),
      title: text(item.title), summary: text(item.summary), body: text(item.body),
      dismissible: item.dismissible !== false, action: action
    };
  }
  function normalize(payload, now) {
    var raw = payload && payload.data && Array.isArray(payload.data.items) ? payload.data.items : [];
    var result = [], seen = {};
    raw.slice(0, MAX_ITEMS).forEach(function (item) {
      var normalized = normalizeItem(item, now);
      if (!normalized || seen[normalized.id]) return;
      seen[normalized.id] = true; result.push(normalized);
    });
    return result;
  }

  function create(options) {
    options = options || {};
    var win = options.window || (typeof window !== 'undefined' ? window : null);
    var doc = options.document || (win && win.document);
    var storage = options.storage || (win && win.localStorage);
    var request = options.request || function (url) {
      return win.fetch(url).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      });
    };
    var items = [], pending = null;

    function platform() {
      if (typeof options.platform === 'function') return text(options.platform()) || 'browser';
      return text(options.platform) || 'browser';
    }
    function version() {
      if (typeof options.version === 'function') return text(options.version());
      return text(options.version);
    }
    function t(key, fallback, values) {
      return options.t ? options.t(key, fallback, values) : fallback;
    }
    function unread() {
      return items.some(function (item) { return !storageGet(storage, PREFIX + item.id); });
    }
    function setBadge(value) {
      if (!doc) return;
      var badge = doc.getElementById('announcement-sidebar-badge');
      if (badge) badge.classList.toggle('is-hidden', !value);
    }
    function visibleItems() {
      return items.filter(function (item) { return !storageGet(storage, PREFIX + item.id); });
    }
    function render() {
      if (!doc) return;
      var card = doc.getElementById('system-announcements-card');
      var list = doc.getElementById('system-announcements');
      if (!card || !list) return;
      var visible = visibleItems();
      list.innerHTML = '';
      visible.forEach(function (item) {
        var article = doc.createElement('article');
        article.className = 'system-announcement'; article.setAttribute('data-announcement-id', item.id);
        var title = doc.createElement('h3'); title.className = 'system-announcement-title'; title.textContent = item.title; article.appendChild(title);
        if (item.summary) { var summary = doc.createElement('p'); summary.className = 'system-announcement-summary'; summary.textContent = item.summary; article.appendChild(summary); }
        if (item.body) { var body = doc.createElement('p'); body.className = 'system-announcement-body'; body.textContent = item.body; article.appendChild(body); }
        var actions = doc.createElement('div'); actions.className = 'app-update-actions system-announcement-actions';
        if (item.action) {
          var action = doc.createElement('button'); action.type = 'button'; action.className = 'announcement-action account-action';
          action.dataset.action = item.action.type; action.dataset.announcementId = item.id; action.dataset.focus = 'announcement-' + item.id + '-action';
          action.textContent = item.action.label || t('settings.announcementCheckUpdate', '检查更新'); actions.appendChild(action);
        }
        if (item.dismissible) {
          var acknowledge = doc.createElement('button'); acknowledge.type = 'button'; acknowledge.className = 'announcement-action account-action';
          acknowledge.dataset.action = 'acknowledge'; acknowledge.dataset.announcementId = item.id; acknowledge.dataset.focus = 'announcement-' + item.id + '-ack';
          acknowledge.textContent = t('settings.announcementAcknowledge', '知道了'); actions.appendChild(acknowledge);
        }
        if (actions.childNodes.length) article.appendChild(actions);
        list.appendChild(article);
      });
      card.classList.toggle('is-hidden', visible.length === 0);
      setBadge(unread());
    }
    function acknowledge(id) {
      id = text(id); if (!id) return;
      storageSet(storage, PREFIX + id); render();
    }
    function handle(action, id) {
      if (action === 'acknowledge') { acknowledge(id); return true; }
      if (action === 'check_update') {
        if (typeof options.checkUpdate === 'function') options.checkUpdate();
        return true;
      }
      return false;
    }
    function refresh() {
      if (pending) return pending;
      var query = '?platform=' + encodeURIComponent(platform());
      var currentVersion = version(); if (currentVersion) query += '&version=' + encodeURIComponent(currentVersion);
      pending = Promise.resolve(request('/api/v1/announcements' + query)).then(function (payload) {
        items = normalize(payload, Date.now()); render(); return items.slice();
      }).catch(function () { items = []; render(); return []; }).then(function (value) { pending = null; return value; });
      return pending;
    }
    if (doc) doc.addEventListener('click', function (event) {
      var action = event.target && event.target.closest && event.target.closest('.announcement-action');
      if (action) handle(action.dataset.action, action.dataset.announcementId);
    });
    return { refresh: refresh, render: render, acknowledge: acknowledge, handle: handle, unread: unread, items: function () { return items.slice(); } };
  }

  return { create: create, normalize: normalize, normalizeItem: normalizeItem };
}));
