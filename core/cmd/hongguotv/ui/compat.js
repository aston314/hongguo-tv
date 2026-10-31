(function (window, document) {
  'use strict';
  function t(key, fallback, params) {
    return window.HongguoI18n && window.HongguoI18n.t ? window.HongguoI18n.t(key, params, fallback) : fallback;
  }
  // Android 6 can retain its original Chromium 44 WebView. Keep this file
  // ES5 and load it before pagination and app initialization.
  if (window.NodeList && !NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;
  if (!Object.assign) Object.assign = function (target) {
    if (target == null) throw new TypeError('Object.assign target');
    target = Object(target);
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (source != null) Object.keys(Object(source)).forEach(function (key) { target[key] = source[key]; });
    }
    return target;
  };
  if (!Number.isFinite) Number.isFinite = function (value) { return typeof value === 'number' && isFinite(value); };
  if (!Array.from) Array.from = function (value) {
    // Preserve Unicode code points for comment/danmaku length validation.
    if (typeof value === 'string') return value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || [];
    return Array.prototype.slice.call(value);
  };
  if (!Element.prototype.matches) Element.prototype.matches = Element.prototype.webkitMatchesSelector;
  if (!Element.prototype.closest) Element.prototype.closest = function (selector) {
    var node = this;
    while (node && node.nodeType === 1) { if (node.matches(selector)) return node; node = node.parentElement; }
    return null;
  };
  if (!Element.prototype.remove) Element.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  var NativeSearchParams = window.URLSearchParams;
  var searchParamsRecords = false;
  try {
    // Chromium 49–60 exposes the API but stringifies records as [object Object].
    searchParamsRecords = typeof NativeSearchParams === 'function' &&
      new NativeSearchParams({ hongguo: '1' }).toString() === 'hongguo=1';
  } catch (ignoredSearchParams) {}
  if (typeof NativeSearchParams === 'function' && !searchParamsRecords) {
    window.URLSearchParams = function (values) {
      if (values && Object.prototype.toString.call(values) === '[object Object]' && !(values instanceof NativeSearchParams)) {
        var params = new NativeSearchParams();
        Object.keys(values).forEach(function (key) { params.append(key, String(values[key])); });
        return params;
      }
      return new NativeSearchParams(values);
    };
    // Keep native encoding, methods, duplicate keys and instanceof behavior.
    window.URLSearchParams.prototype = NativeSearchParams.prototype;
  } else if (typeof NativeSearchParams !== 'function') {
    // The app constructs query strings from plain objects, not URLs.
    window.URLSearchParams = function (values) { this.values = Object.assign({}, values || {}); };
    window.URLSearchParams.prototype.toString = function () {
      var values = this.values;
      return Object.keys(values).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(String(values[key])); }).join('&');
    };
    window.URLSearchParams.prototype.set = function (key, value) { this.values[String(key)] = String(value); };
  }
  var legacyAbort = typeof window.AbortController !== 'function';
  if (legacyAbort) {
    window.AbortController = function () {
      var listeners = [];
      this.signal = { aborted: false,
        addEventListener: function (type, listener) { if (type === 'abort' && listeners.indexOf(listener) < 0) listeners.push(listener); },
        removeEventListener: function (type, listener) { var index = listeners.indexOf(listener); if (type === 'abort' && index >= 0) listeners.splice(index, 1); } };
      this.abort = function () {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        listeners.slice().forEach(function (listener) { listener(); }); listeners = [];
      };
    };
  }
  if ((!window.fetch || legacyAbort) && window.Promise) window.fetch = function (url, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var signal = options.signal;
      function cleanup() { if (signal) signal.removeEventListener('abort', abort); }
      function failure(name, message) { cleanup(); var error = new Error(message); error.name = name; reject(error); }
      function abort() { xhr.abort(); failure('AbortError', t('ui.requestCancelled', '请求已取消')); }
      if (signal && signal.aborted) { abort(); return; }
      xhr.open(options.method || 'GET', url, true);
      xhr.timeout = 180000;
      Object.keys(options.headers || {}).forEach(function (key) { xhr.setRequestHeader(key, options.headers[key]); });
      xhr.onload = function () {
        cleanup();
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status,
          json: function () { try { return Promise.resolve(JSON.parse(xhr.responseText)); } catch (error) { return Promise.reject(error); } } });
      };
      xhr.onerror = function () { failure('TypeError', t('ui.networkFailed', '连接失败')); };
      xhr.ontimeout = function () { failure('TimeoutError', t('ui.networkTimeout', '连接超时')); };
      if (signal) signal.addEventListener('abort', abort);
      xhr.send(options.body === undefined ? null : options.body);
    });
  };

  var root = document.documentElement;
  function supports(property, value) {
    var style = document.createElement('div').style;
    if (!(property in style)) return false;
    style[property] = value; return style[property] === value;
  }
  if (!supports('display', 'grid') || !supports('columnGap', '1px')) root.classList.add('legacy-grid');
  if (!supports('aspectRatio', '2 / 3')) root.classList.add('legacy-aspect');
  // CSS.supports(gap) also succeeds on WebViews supporting only grid gap.
  var probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px;';
  probe.appendChild(document.createElement('div')); probe.appendChild(document.createElement('div'));
  root.appendChild(probe);
  if (probe.scrollHeight !== 1) root.classList.add('legacy-flex-gap');
  probe.remove();

  if (!supports('scrollBehavior', 'smooth')) {
    var originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (!options || typeof options !== 'object') return originalScrollIntoView.call(this, options);
      // Older engines interpret the options object as boolean true and jump
      // the focused row to the top. Scroll only overflowing ancestors.
      var parent = this.parentElement;
      while (parent && parent !== document.body && parent !== root) {
        var style = window.getComputedStyle(parent);
        var target = this.getBoundingClientRect(); var box = parent.getBoundingClientRect();
        var top = box.top + parent.clientTop, left = box.left + parent.clientLeft;
        if (/auto|scroll/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
          if (target.top < top) parent.scrollTop += target.top - top;
          else if (target.bottom > top + parent.clientHeight) parent.scrollTop += target.bottom - top - parent.clientHeight;
        }
        if (/auto|scroll/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth) {
          if (options.inline === 'center') parent.scrollLeft += (target.left + target.right) / 2 - left - parent.clientWidth / 2;
          else if (target.left < left) parent.scrollLeft += target.left - left;
          else if (target.right > left + parent.clientWidth) parent.scrollLeft += target.right - left - parent.clientWidth;
        }
        parent = parent.parentElement;
      }
    };
  }

  window.addEventListener('error', function () {
    var status = document.getElementById('core-status');
    if (status && status.textContent === t('ui.coreConnecting', '连接核心服务…')) { status.textContent = t('ui.startupFailed', '界面启动失败，请重新打开应用'); status.dataset.ok = 'false'; }
  });
})(window, document);
