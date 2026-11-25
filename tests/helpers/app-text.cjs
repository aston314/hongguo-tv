const locales = require('../../core/cmd/hongguotv/ui/locales/zh-CN.js');

const messages = locales['zh-CN'] || {};

function uiText(key, fallback, params) {
  let value = messages[key];
  if (value === undefined || value === null) value = fallback === undefined ? key : fallback;
  return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
    return params && params[name] !== undefined && params[name] !== null ? String(params[name]) : '';
  });
}

function apiError(payload, status, key, fallback) {
  const detail = payload && (payload.error || payload.message);
  return detail ? String(detail) : uiText(key, fallback || (status ? 'HTTP {status}' : '请求失败'), status ? { status } : null);
}

function localizedError(error, key, fallback) {
  const detail = error && typeof error === 'object' ? error.message : error;
  return apiError(detail ? { error: detail } : null, 0, key, fallback);
}

// Load the real content-display wrappers into function-only app fixtures.
// The default window has no display converter, matching Simplified mode.
function installContentText(context) {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../core/cmd/hongguotv/ui/app.js'), 'utf8');
  if (!context.window) context.window = {};
  vm.runInContext(source.slice(source.indexOf('  function setContentText('), source.indexOf('  function renderCoreStatus(')), context);
}

module.exports = { uiText, apiError, localizedError, installContentText };

// app.js behavior tests evaluate individual functions in isolated VM contexts.
// Make the production helper available to those contexts without duplicating
// translation logic in every fixture.
if (!Object.prototype.uiText) Object.defineProperty(Object.prototype, 'uiText', { value: uiText, configurable: true });
if (!Object.prototype.apiError) Object.defineProperty(Object.prototype, 'apiError', { value: apiError, configurable: true });
if (!Object.prototype.localizedError) Object.defineProperty(Object.prototype, 'localizedError', { value: localizedError, configurable: true });
