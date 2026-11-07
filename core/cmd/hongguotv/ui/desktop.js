(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.HongguoDesktopUI = api;
    if (root.HongguoDesktop || /(?:^|[?&])platform=desktop(?:&|$)/.test(root.location.search)) api.install(root);
  }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function t(key, fallback, params) {
    var i18n = typeof window !== 'undefined' && window.HongguoI18n;
    return i18n && i18n.t ? i18n.t(key, params, fallback) : fallback;
  }
  function mediaSource(path, config) {
    if (!config || !config.mediaBase || !/^\/minireel-proxy\/media\/[a-zA-Z0-9_-]+\.mp4$/.test(path)) return path;
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(config.mediaBase)) return path;
    return config.mediaBase + path;
  }
  function editing(element) {
    return !!(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable));
  }
  function createPointerFocus(win, options) {
    var doc = win.document, hovered = null, muted = null, pointer = false, lastX = null, lastY = null;
    var moveEvent = win.PointerEvent ? 'pointermove' : 'mousemove';
    var downEvent = win.PointerEvent ? 'pointerdown' : 'mousedown';
    function unmute() {
      if (muted) muted.classList.remove('pointer-focus-muted');
      muted = null;
    }
    function paint(element) {
      unmute();
      if (pointer && doc.activeElement && doc.activeElement !== element) {
        muted = doc.activeElement;
        muted.classList.add('pointer-focus-muted');
      }
      options.paint(element);
    }
    function target(event) {
      var node = event.target && event.target.closest && event.target.closest(options.selector);
      return node && !node.disabled && (pointer && hovered === node || options.allowed(node)) ? node : null;
    }
    function focusChanged(element) {
      pointer = false; hovered = null;
      paint(element);
    }
    function move(event) {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      // Layout changes and a stationary cursor must not take focus back
      // after keyboard navigation, scrolling or a modal has opened.
      if (lastX === event.clientX && lastY === event.clientY) return;
      lastX = event.clientX; lastY = event.clientY;
      var node = target(event);
      if (pointer && hovered === node) return;
      pointer = true; hovered = node;
      paint(node);
      if (options.hover) options.hover(node);
    }
    function down(event) {
      if (event.pointerType && event.pointerType !== 'mouse' || event.button !== 0) return;
      var node = target(event);
      if (!node) return;
      // Safari buttons do not always focus on click. Establish the opener
      // before its click handler, without moving the page or consuming it.
      node.focus({ preventScroll: true });
      focusChanged(doc.activeElement);
    }
    function key(event) {
      if (!pointer) return;
      var node = hovered, active = doc.activeElement;
      var handoff = !editing(active) && !event.isComposing && event.keyCode !== 229 &&
        !event.ctrlKey && !event.altKey && !event.metaKey &&
        /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Enter| |Tab)$/.test(event.key || '');
      focusChanged(active);
      if (handoff && node && options.allowed(node)) options.focus(node);
    }
    function clear() {
      if (!pointer) return;
      hovered = null;
      paint(null);
    }
    function leave(event) { if (!event.relatedTarget) clear(); }
    doc.addEventListener(moveEvent, move);
    doc.addEventListener(downEvent, down, true);
    doc.addEventListener('keydown', key, true);
    doc.addEventListener('scroll', clear, true);
    doc.addEventListener('mouseout', leave);
    win.addEventListener('blur', clear);
    return { focusChanged: focusChanged, clear: clear };
  }
  function install(win) {
    var doc = win.document, config = win.HongguoDesktop || { platform: 'preview', version: t('ui.desktopPreview', '桌面预览') };
    win.HongguoDesktop = config;
    doc.documentElement.classList.add('desktop-shell');
    ['account-phone', 'account-code'].forEach(function (id) {
      var old = doc.getElementById(id);
      if (!old || old.tagName === 'INPUT') return;
      var input = doc.createElement('input');
      input.id = id; input.className = old.className; input.type = 'text';
      input.setAttribute('data-focus', old.getAttribute('data-focus'));
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('autocomplete', id === 'account-phone' ? 'tel' : 'one-time-code');
      input.maxLength = id === 'account-phone' ? 11 : 8;
      input.placeholder = id === 'account-phone' ? t('ui.inputPhone', '请输入手机号') : t('ui.inputCode', '请输入验证码');
      input.setAttribute('aria-label', id === 'account-phone' ? t('ui.phoneLabel', '手机号') : t('ui.codeLabel', '短信验证码'));
      input.addEventListener('input', function () {
        if (!input.composing) input.value = input.value.replace(/[^0-9]/g, '').slice(0, input.maxLength);
        input.classList.toggle('is-empty', !input.value);
      });
      input.addEventListener('compositionstart', function () { input.composing = true; });
      input.addEventListener('compositionend', function () { input.composing = false; input.dispatchEvent(new win.Event('input')); });
      old.parentNode.replaceChild(input, old);
    });
    doc.addEventListener('phonecountrychange', function (event) {
      var input = doc.getElementById('account-phone');
      if (input && event.detail && event.detail.maxLength) {
        input.maxLength = event.detail.maxLength;
        if (input.value.length > input.maxLength) input.value = input.value.slice(0, input.maxLength);
      }
    });
    var help = doc.querySelector('.account-input-help');
    if (help) help.textContent = t('ui.desktopInputHelp', '直接输入或粘贴手机号和验证码；按 Tab 切换，按 Enter 提交。');
    win.HongguoTVUpdates = createUpdateBridge(win, config);
    if (win.HongguoDesktopMiniPlayer) win.HongguoDesktopMini = win.HongguoDesktopMiniPlayer.create(win, config);
    win.HongguoDesktopWindow = createWindowMonitor(win, config);
    win.HongguoDesktopWindow.refresh();
    win.setInterval(win.HongguoDesktopWindow.refresh, 400);
    doc.addEventListener('visibilitychange', win.HongguoDesktopWindow.refresh);
  }
  function createWindowMonitor(win, config) {
    var pending = false, lastHidden = false, lastFullscreen = null;
    config.background = false;
    function refresh() {
      var bridge = win.go && win.go.main && win.go.main.desktopApp;
      if (pending || !bridge || !bridge.GetWindowState) return;
      pending = true;
      var mini = win.HongguoDesktopMini, miniRevision = mini && mini.revision();
      Promise.resolve(bridge.GetWindowState()).then(function (value) {
        var state = JSON.parse(value), hidden = !!state.hidden, fullscreen = !!state.fullscreen;
        config.background = hidden;
        if (mini) mini.render(state, miniRevision);
        if (!win.HongguoTV) return;
        if (hidden !== lastHidden) {
          lastHidden = hidden;
          if (hidden) win.HongguoTV.pauseForBackground(); else win.HongguoTV.resumeFromBackground();
        }
        if (fullscreen !== lastFullscreen) {
          lastFullscreen = fullscreen;
          win.HongguoTV.desktopFullscreenChanged(fullscreen);
        }
      }).catch(function () {}).then(function () { pending = false; });
    }
    return { refresh: refresh };
  }
  function createUpdateBridge(win, config) {
    var linux = config.platform === 'linux';
    var status = { supported: config.platform !== 'preview' && !linux, desktop: true, state: linux ? 'unsupported' : 'idle', current_version: config.version,
      message: linux ? t('ui.linuxManualUpdate', 'Linux 实验版请下载新版 AppImage 后手动替换。') : t('ui.updateDaily', '每天自动检查一次；下载 ZIP 后请自行解压替换。') };
    var pending = false, allowed = false;
    function app() { return win.go && win.go.main && win.go.main.desktopApp; }
    function poll() {
      if (pending || !app()) return;
      pending = true;
      Promise.resolve(app().GetUpdateStatus()).then(function (value) {
        var next = JSON.parse(value); next.prompt_allowed = allowed;
        if (linux && !next.supported) next.message = t('ui.linuxManualUpdate', 'Linux 实验版请下载新版 AppImage 后手动替换。');
        status = next;
      }).catch(function () { status.message = t('ui.updateUnavailable', '更新状态暂时不可用，请稍后重试。'); }).then(function () { pending = false; });
    }
    function invoke(method) {
      var bridge = app(); if (!bridge) return;
      Promise.resolve(bridge[method]()).then(poll).catch(function () { status.message = t('ui.updateFailed', '更新操作未能完成，请重试。'); });
    }
    return {
      getStatus: function () { poll(); return JSON.stringify(status); },
      setPromptAllowed: function (value) { allowed = !!value; status.prompt_allowed = allowed; },
      check: function () { invoke('CheckUpdate'); },
      download: function () { invoke('DownloadUpdate'); },
      openFolder: function () { invoke('OpenUpdateFolder'); }
    };
  }
  return { mediaSource: mediaSource, editing: editing, createPointerFocus: createPointerFocus, install: install, createUpdateBridge: createUpdateBridge, createWindowMonitor: createWindowMonitor };
}));
