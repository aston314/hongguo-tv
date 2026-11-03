(function (root) {
  'use strict';

  var STORAGE_KEY = 'hongguo-tv-locale';
  var DEFAULT_LOCALE = 'zh-CN';
  var locales = root.HongguoLocales || {};
  if (!Object.keys(locales).length && typeof module === 'object' && module.exports && typeof require === 'function') {
    try { locales = require('./locales/zh-CN.js'); } catch (ignoredLocale) {}
  }
  var listeners = [];
  var defaultKeyMap = null;

  function flattenKeys(messages, prefix, output) {
    if (!messages || typeof messages !== 'object') return output;
    for (var name in messages) {
      if (!Object.prototype.hasOwnProperty.call(messages, name)) continue;
      var key = prefix ? prefix + '.' + name : name;
      var value = messages[name];
      if (value && typeof value === 'object' && !Array.isArray(value)) flattenKeys(value, key, output);
      else output[key] = true;
    }
    return output;
  }

  function requiredKeys() {
    if (!defaultKeyMap) defaultKeyMap = flattenKeys(locales[DEFAULT_LOCALE], '', {});
    return defaultKeyMap;
  }

  function normalize(value) {
    return localeFor(value) || DEFAULT_LOCALE;
  }

  function systemLocaleCandidates() {
    var candidates = [];
    var bridge = root.HongguoTVPreferences;
    if (bridge && typeof bridge.readSystemLocale === 'function') {
      try {
        var nativeLocale = bridge.readSystemLocale();
        if (nativeLocale) candidates.push(nativeLocale);
      } catch (ignoredNativeLocale) {}
    }
    var navigatorObject = root.navigator;
    if (navigatorObject && Array.isArray(navigatorObject.languages)) {
      for (var i = 0; i < navigatorObject.languages.length; i += 1) {
        if (navigatorObject.languages[i]) candidates.push(navigatorObject.languages[i]);
      }
    }
    if (navigatorObject && navigatorObject.language) candidates.push(navigatorObject.language);
    return candidates;
  }

  function detectSystemLocale() {
    var candidates = systemLocaleCandidates();
    for (var i = 0; i < candidates.length; i += 1) {
      var detected = localeFor(candidates[i]);
      if (detected) return detected;
    }
    return DEFAULT_LOCALE;
  }

  function readStoredLocale() {
    try {
      var bridge = root.HongguoTVPreferences;
      if (bridge && typeof bridge.readLocale === 'function') {
        // New Android shells distinguish an explicit selection from the
        // default value returned by older shells. Preserve old-shell behavior
        // while allowing untouched installations to follow the system locale.
        if (typeof bridge.hasLocaleOverride === 'function') {
          if (bridge.hasLocaleOverride()) return normalize(bridge.readLocale());
          return detectSystemLocale();
        }
        return normalize(bridge.readLocale());
      }
      var stored = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      return stored ? normalize(stored) : detectSystemLocale();
    } catch (ignored) { return DEFAULT_LOCALE; }
  }

  var current = readStoredLocale();

  function lookup(messages, key) {
    if (!messages) return null;
    var value = messages[key];
    if (value !== undefined && value !== null) return value;
    var parts = String(key).split('.');
    value = messages;
    for (var i = 0; i < parts.length; i += 1) {
      if (!value || value[parts[i]] === undefined) return null;
      value = value[parts[i]];
    }
    return value === undefined || value === null ? null : value;
  }

  function missingKeys(messages) {
    var required = requiredKeys();
    var missing = [];
    for (var key in required) {
      if (Object.prototype.hasOwnProperty.call(required, key) && lookup(messages, key) === null) missing.push(key);
    }
    return missing;
  }

  function isCompleteLocale(locale) {
    if (!locales[locale]) return false;
    if (locale === DEFAULT_LOCALE) return true;
    return missingKeys(locales[locale]).length === 0;
  }

  function localeFor(value) {
    var raw = String(value || '');
    if (locales[raw] && isCompleteLocale(raw)) return raw;
    var normalized = raw.toLowerCase().replace(/_/g, '-');
    var exact = Object.keys(locales).filter(function (key) {
      return key.toLowerCase() === normalized && isCompleteLocale(key);
    });
    if (exact.length) return exact[0];
    if (/^zh-(tw|hk|mo|hant)(-|$)/.test(normalized) && isCompleteLocale('zh-TW')) return 'zh-TW';
    if (/^zh-(cn|sg|my|hans)(-|$)/.test(normalized) && isCompleteLocale('zh-CN')) return 'zh-CN';
    var language = normalized.split('-')[0];
    for (var key in locales) {
      if (Object.prototype.hasOwnProperty.call(locales, key) && key.toLowerCase().split('-')[0] === language && isCompleteLocale(key)) return key;
    }
    return null;
  }

  function interpolate(value, params) {
    if (!params || typeof value !== 'string') return value;
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, function (_, name) {
      return params[name] === undefined || params[name] === null ? '' : String(params[name]);
    });
  }

  function translate(key, params, fallback) {
    var value = lookup(locales[current], key);
    if (value === null) value = lookup(locales[DEFAULT_LOCALE], key);
    if (value === null) value = fallback === undefined ? key : fallback;
    return interpolate(String(value), params);
  }

  function setText(element, key) {
    if (!element) return;
    var value = translate(key, null, element.textContent || key);
    // Locale strings may use the small, explicit <br> token for compact TV
    // hints. Render only that token as markup so translations stay safe.
    var parts = String(value).split(/(<br\s*\/?>)/ig);
    element.textContent = '';
    for (var i = 0; i < parts.length; i += 1) {
      if (/^<br\s*\/?>$/i.test(parts[i])) element.appendChild(element.ownerDocument.createElement('br'));
      else if (parts[i]) element.appendChild(element.ownerDocument.createTextNode(parts[i]));
    }
  }

  function apply(scope) {
    if (!scope || !scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i += 1) setText(nodes[i], nodes[i].getAttribute('data-i18n'));
    var aria = scope.querySelectorAll('[data-i18n-aria-label]');
    for (var j = 0; j < aria.length; j += 1) aria[j].setAttribute('aria-label', translate(aria[j].getAttribute('data-i18n-aria-label')));
    var placeholders = scope.querySelectorAll('[data-i18n-placeholder]');
    for (var k = 0; k < placeholders.length; k += 1) placeholders[k].setAttribute('placeholder', translate(placeholders[k].getAttribute('data-i18n-placeholder')));
    var titles = scope.querySelectorAll('[data-i18n-title]');
    for (var n = 0; n < titles.length; n += 1) titles[n].setAttribute('title', translate(titles[n].getAttribute('data-i18n-title')));
    var alts = scope.querySelectorAll('[data-i18n-alt]');
    for (var a = 0; a < alts.length; a += 1) alts[a].setAttribute('alt', translate(alts[a].getAttribute('data-i18n-alt')));
  }

  function notify() {
    for (var i = 0; i < listeners.length; i += 1) {
      try { listeners[i](current); } catch (ignored) {}
    }
    if (root.document && root.document.documentElement) root.document.documentElement.lang = current;
    if (root.document) apply(root.document);
  }

  function setLocale(value) {
    var next = localeFor(String(value || ''));
    if (!next) return false;
    try {
      if (root.HongguoTVPreferences && typeof root.HongguoTVPreferences.writeLocale === 'function') root.HongguoTVPreferences.writeLocale(next);
      else if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, next);
    } catch (ignored) { return false; }
    current = next;
    notify();
    return true;
  }

  var api = {
    defaultLocale: DEFAULT_LOCALE,
    supportedLocales: function () {
      return Object.keys(locales).filter(function (locale) { return isCompleteLocale(locale); });
    },
    missingKeys: function (locale) {
      var key = localeFor(String(locale || '')) || String(locale || '');
      return missingKeys(locales[key]);
    },
    locale: function () { return current; },
    t: translate,
    apply: apply,
    setLocale: setLocale,
    onChange: function (listener) { if (typeof listener === 'function') listeners.push(listener); return function () { var index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); }; }
  };
  root.HongguoI18n = api;
  if (root.document && root.document.addEventListener) root.document.addEventListener('DOMContentLoaded', function () { root.document.documentElement.lang = current; apply(root.document); });
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : this));
