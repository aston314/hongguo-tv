(function (root) {
  'use strict';
  function create(options) {
    var bridge = options.bridge, mode = '', supported = false, message = '';
    function text(key, fallback, params) {
      return root.HongguoI18n && typeof root.HongguoI18n.t === 'function' ? root.HongguoI18n.t(key, params, fallback) : fallback;
    }
    function read() {
      if (!bridge || typeof bridge.engine !== 'function' || bridge.engine() !== 'mpv' ||
          typeof bridge.decoderMode !== 'function' || typeof bridge.setDecoderMode !== 'function') return false;
      var value = bridge.decoderMode();
      if (value !== 'mpv_auto' && value !== 'mpv_software') return false;
      mode = value; return true;
    }
    function render() { options.render({ supported: supported, mode: mode, message: message }); }
    try { supported = read(); } catch (ignored) { supported = false; }
    render();
    return { choose: function (value) {
      if (!supported || value !== 'mpv_auto' && value !== 'mpv_software') return false;
      try {
        bridge.setDecoderMode(value);
        if (!read() || mode !== value) throw new Error('Preference not saved');
        message = text('settings.decoderApplied', '已选择{mode}，下次播放或切集时生效。', { mode: mode === 'mpv_auto' ? text('settings.autoDecode', '自动解码') : text('settings.softwareDecode', '软件解码') });
        render(); return true;
      } catch (ignoredSave) {
        message = text('settings.saveFailed', '设置未能保存，请重试。'); render(); return false;
      }
    } };
  }
  function createHardwareHevc(options) {
    var bridge = options.bridge, supported = false, hardware = false, message = '';
    function text(key, fallback, params) {
      return root.HongguoI18n && typeof root.HongguoI18n.t === 'function' ? root.HongguoI18n.t(key, params, fallback) : fallback;
    }
    function read() {
      if (!bridge || typeof bridge.engine !== 'function' || bridge.engine() !== 'webview_media3' ||
          typeof bridge.supportsHardwareHevcPreference !== 'function' || !bridge.supportsHardwareHevcPreference() ||
          typeof bridge.hardwareHevcPreferred !== 'function' || typeof bridge.setHardwareHevcPreferred !== 'function') return false;
      var value = bridge.hardwareHevcPreferred();
      if (typeof value !== 'boolean') return false;
      hardware = value; return true;
    }
    function render() { options.render({ supported: supported, mode: hardware ? 'hardware' : 'standard', message: message }); }
    try { supported = read(); } catch (ignored) { supported = false; }
    render();
    return { choose: function (value) {
      if (!supported || value !== 'standard' && value !== 'hardware') return false;
      try {
        bridge.setHardwareHevcPreferred(value === 'hardware');
        if (!read() || hardware !== (value === 'hardware')) throw new Error('Preference not saved');
        message = text('settings.decoderApplied', '已选择{mode}，下次播放或切集时生效。', {
          mode: hardware ? text('settings.hardwareDecodePriority', '硬件解码优先') : text('settings.autoDecodeDefault', '自动（默认）')
        });
        render(); return true;
      } catch (ignoredSave) {
        message = text('settings.saveFailed', '设置未能保存，请重试。'); render(); return false;
      }
    } };
  }
  var api = { create: create, createHardwareHevc: createHardwareHevc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HongguoPlaybackSettings = api;
}(this));
