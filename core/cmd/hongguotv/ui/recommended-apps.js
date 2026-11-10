(function (root) {
  'use strict';
  var IDS = ['doudou', 'sports', 'yunying'];
  var ANDROID = { 21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' };
  function model(data, text) {
    data = data || {};
    var state = data.state || 'loading';
    var percent = data.size > 0 ? Math.max(0, Math.min(100, Math.floor(data.downloaded * 100 / data.size))) : 0;
    var keys = { idle: 'loading', loading: 'loading', available: 'install', downloading: 'cancel', ready: 'continue', installing: 'installing', installed: 'installed', incompatible: 'incompatible', permission: 'permission', error: 'retry' };
    var blocked = ['idle', 'loading', 'installed', 'installing', 'incompatible'].indexOf(state) >= 0 || !!data.busy;
    var statusKey = state === 'error' ? data.error === 'metadata' ? 'metadataError' : 'downloadError' : state === 'downloading' ? 'progress' : state === 'ready' ? 'readyHint' : state === 'permission' ? 'permissionHint' : state === 'installing' ? 'installingHint' : '';
    if (data.error === 'installer') statusKey = 'installerError';
    if (data.error === 'incomplete') statusKey = 'incomplete';
    return {
      state: state, percent: percent, blocked: blocked,
      label: text('apps.' + (state === 'ready' && data.alternative ? 'alternative' : keys[state] || 'retry')),
      status: statusKey ? text('apps.' + statusKey, { percent: percent }) : '',
      android: text('apps.android', { version: ANDROID[data.min_sdk] || 'API ' + (data.min_sdk || 23) }),
      version: data.version ? 'v' + data.version : '',
      size: data.size > 0 ? (data.size / 1048576).toFixed(1) + ' MB' : ''
    };
  }
  function create(options) {
    options = options || {};
    var bridge = options.android && options.bridge;
    var supported = !!(bridge && typeof bridge.getStatus === 'function' && typeof bridge.activate === 'function' && typeof bridge.refresh === 'function');
    var schedule = options.setTimeout || root.setTimeout;
    var unschedule = options.clearTimeout || root.clearTimeout;
    var visible = false, timer = 0, last = '', destroyed = false;
    function refresh() {
      if (!supported || !visible || destroyed) return;
      var value;
      try {
        var json = bridge.getStatus();
        if (json === last) return;
        value = JSON.parse(json);
        if (!value || !Array.isArray(value.apps)) throw new Error('status');
        last = json;
        options.render(value.apps.filter(function (app) { return app && IDS.indexOf(app.id) >= 0; }));
      } catch (ignored) {
        options.render(IDS.map(function (id) { return { id: id, state: 'error', error: 'metadata' }; }));
      }
    }
    function poll() {
      timer = 0; refresh();
      if (visible && !destroyed) timer = schedule(poll, 750);
    }
    return {
      supported: supported,
      show: function () {
        if (!supported || destroyed || visible) return;
        visible = true; last = '';
        try { bridge.setVisible(true); bridge.refresh(); } catch (ignored) {}
        poll();
      },
      hide: function () {
        visible = false;
        if (timer) unschedule(timer);
        timer = 0;
        if (supported) { try { bridge.setVisible(false); } catch (ignored) {} }
      },
      activate: function (id) {
        if (!supported || !visible || IDS.indexOf(id) < 0) return;
        try { bridge.activate(id); last = ''; refresh(); } catch (ignored) {}
      },
      refresh: function () { last = ''; refresh(); },
      destroy: function () { this.hide(); destroyed = true; }
    };
  }
  root.HongguoRecommendedAppsUI = { create: create, model: model };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.HongguoRecommendedAppsUI;
}(typeof window === 'undefined' ? globalThis : window));
