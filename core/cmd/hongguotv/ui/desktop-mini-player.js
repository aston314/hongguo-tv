(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoDesktopMiniPlayer = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function create(win, config) {
    var doc = win.document, active = false, pending = false, savedCinema = false, revision = 0, keyboardFocus = false;
    var timer = null, overlay, entry, title, episode, progress, volume, time, buttons = {};
    var hideTitlebar = false, titlebarHidden = false, settingCard, settingToggle, settingState;
    var titlebarKey = 'hongguo.desktop.mini-titlebar-hidden';
    var aspectSession = 0, aspectKey = '', aspectFailed = '', aspectFlight = null;
    try { hideTitlebar = win.localStorage.getItem(titlebarKey) === 'true'; } catch (_) {}
    function app() { return win.HongguoTV; }
    function bridge() { return win.go && win.go.main && win.go.main.desktopApp; }
    function state() { return app() && app().miniPlayerState ? app().miniPlayerState() : {}; }
    function text(key, fallback, params) { return win.HongguoI18n ? win.HongguoI18n.t(key, params, fallback) : fallback; }
    function supported() { return /^(darwin|windows|linux|preview)$/.test(config.platform) && (config.platform === 'preview' || bridge() && bridge().SetMiniPlayer); }
    function titlebarSupported() { return supported() && (config.platform === 'preview' || bridge() && bridge().SetMiniPlayerTitlebarHidden); }
    function aspectSupported() { return config.platform !== 'preview' && bridge() && typeof bridge().SetMiniPlayerWithAspect === 'function' && typeof bridge().UpdateMiniPlayerAspect === 'function'; }
    function videoAspect(s) {
      var w = Number(s.videoWidth), h = Number(s.videoHeight);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w !== Math.floor(w) || h !== Math.floor(h) || w <= 0 || h <= 0 || w > 32768 || h > 32768 || w > h * 10 || h > w * 10) return null;
      w = Math.round(w); h = Math.round(h);
      var a = w, b = h; while (b) { var next = a % b; a = b; b = next; }
      return { width: w, height: h, key: (w / a) + ':' + (h / a) };
    }
    function aspectFallback() {
      if (app() && app().miniPlayerNotify) app().miniPlayerNotify(text('mini.aspectFallback', '暂无法固定比例，已保留原小窗。'));
    }
    function syncAspect() {
      var video = videoAspect(state());
      if (!active || pending || !aspectSupported() || !aspectSession || !video || aspectFlight || video.key === aspectKey || video.key === aspectFailed) return;
      var flight = { session: aspectSession, revision: revision, key: video.key };
      aspectFlight = flight;
      Promise.resolve().then(function () { return bridge().UpdateMiniPlayerAspect(flight.session, video.width, video.height); }).then(function (result) {
        if (typeof result === 'string') result = JSON.parse(result);
        if (!active || pending || revision !== flight.revision || aspectSession !== flight.session) return;
        if (!result || !result.active || result.aspect_session !== flight.session || !result.aspect_applied) throw new Error('Aspect not applied');
        aspectKey = video.key; aspectFailed = '';
      }).catch(function () {
        if (active && !pending && revision === flight.revision && aspectSession === flight.session) { aspectKey = ''; aspectFailed = video.key; aspectFallback(); }
      }).then(function () {
        if (aspectFlight !== flight) return;
        aspectFlight = null;
        if (active && !pending) syncAspect(); // coalesce metadata changes during the native call
      });
    }
    function saveTitlebar(value) {
      try { win.localStorage.setItem(titlebarKey, value ? 'true' : 'false'); hideTitlebar = value; return true; } catch (_) { return false; }
    }
    function renderSetting(message) {
      if (!settingCard) return;
      settingCard.classList.toggle('is-hidden', !titlebarSupported());
      settingToggle.disabled = pending;
      settingToggle.setAttribute('aria-pressed', hideTitlebar ? 'true' : 'false');
      settingToggle.classList.toggle('account-primary', hideTitlebar);
      settingToggle.textContent = text(hideTitlebar ? 'settings.autoCinemaEnabled' : 'settings.autoCinemaDisabled', hideTitlebar ? '已开启' : '已关闭');
      settingState.textContent = message || text('mini.titlebarSettingState', '默认关闭，仅用于桌面小窗。');
    }
    function applyTitlebar(result) {
      titlebarHidden = active && !!result.titlebar_hidden;
      doc.documentElement.classList.toggle('desktop-mini-titlebar-hidden', titlebarHidden);
      // GTK no longer has native resize borders when decorations are hidden.
      // Wails already provides the edge-resize handler; enable it only here.
      if (config.platform === 'linux' && win.wails && win.wails.flags) win.wails.flags.enableResize = titlebarHidden;
      if (buttons.titlebar) buttons.titlebar.classList.toggle('is-hidden', !titlebarHidden);
      if (result.titlebar_fallback) {
        saveTitlebar(false);
        if (app() && app().miniPlayerNotify) app().miniPlayerNotify(text('mini.titlebarFallback', '已保留系统标题栏，可继续使用小窗。'));
      }
      renderSetting();
    }
    function chooseTitlebar(value) {
      if (pending || !titlebarSupported()) return Promise.resolve(false);
      if (!active) {
        var saved = saveTitlebar(value);
        renderSetting(saved ? '' : text('settings.saveFailed', '设置未能保存，请重试。'));
        return Promise.resolve(saved);
      }
      // The small window always retains a visible recovery action on hover.
      // A failed native restoration keeps this action and Escape available.
      pending = true; revision++; render();
      return Promise.resolve().then(function () {
        return config.platform === 'preview' ? { active: true, titlebar_hidden: value } : bridge().SetMiniPlayerTitlebarHidden(value);
      }).then(function (result) {
        if (typeof result === 'string') result = JSON.parse(result);
        if (!result || typeof result.active !== 'boolean') throw new Error('Invalid titlebar response');
        applyTitlebar(result);
        if (result.aspect_fallback) {
          var video = videoAspect(state());
          aspectKey = ''; aspectFailed = video ? video.key : ''; aspectFallback();
        }
        if (result.error) throw new Error(result.error);
        var saved = saveTitlebar(!!result.titlebar_hidden);
        if (!saved) renderSetting(text('settings.saveFailed', '设置未能保存，请重试。'));
        return saved;
      }).catch(function () {
        if (app() && app().miniPlayerNotify) app().miniPlayerNotify(text('mini.failed', '小窗切换失败，请重试'));
        return false;
      }).then(function (ok) { pending = false; render(); reveal(); return ok; });
    }
    function label(node, value) { node.title = value; node.setAttribute('aria-label', value); }
    function focus(node) { if (node && !node.disabled && app() && app().miniPlayerFocus) app().miniPlayerFocus(node); }
    function clock(value) { value = Math.max(0, Math.floor(value || 0)); return Math.floor(value / 60) + ':' + ('0' + value % 60).slice(-2); }
    function icon(name) { return '<svg aria-hidden="true" focusable="false"><use href="#icon-' + name + '" xlink:href="#icon-' + name + '"></use></svg>'; }
    function button(parent, name, symbol, action) {
      var node = doc.createElement('button');
      node.type = 'button'; node.className = 'mini-player-button'; node.id = 'mini-player-' + name;
      node.setAttribute('data-focus', node.id); node.innerHTML = icon(symbol) + '<span></span>';
      node.addEventListener('click', function () { if (!pending) action(); reveal(); });
      parent.appendChild(node); buttons[name] = node;
      return node;
    }
    function command(action, value) {
      if (active && !pending && app() && app().miniPlayerCommand) app().miniPlayerCommand(action, value);
      render();
    }
    function scheduleHide() {
      win.clearTimeout(timer);
      timer = null;
      if (overlay && overlay.classList.contains('is-visible') && active && !state().paused && !keyboardFocus) {
        timer = win.setTimeout(function () { overlay.classList.remove('is-visible'); }, 2500);
      }
    }
    function reveal() {
      if (!overlay) return;
      overlay.classList.add('is-visible');
      scheduleHide();
    }
    function apply(value) {
      var changed = active !== value;
      active = value;
      if (!active) { aspectSession = 0; aspectKey = aspectFailed = ''; aspectFlight = null; }
      doc.documentElement.classList.toggle('desktop-mini-player', active);
      if (overlay) overlay.setAttribute('aria-hidden', active ? 'false' : 'true');
      if (changed && app() && app().miniPlayerChanged) app().miniPlayerChanged(active, savedCinema);
      if (changed) { render(); if (state().available) focus(active ? buttons.pause : entry); reveal(); }
    }
    function request(enabled) {
      if (pending || !supported() || enabled && !state().available) return Promise.resolve(false);
      if (enabled === active) return Promise.resolve(true);
      if (enabled) {
        savedCinema = doc.querySelector('.app-shell').classList.contains('is-cinema');
        if (app() && app().miniPlayerChanged) app().miniPlayerChanged(true, savedCinema);
      }
      pending = true;
      revision++;
      // Paint the compact layout before the native size changes. Never move,
      // clone or reload the video element during a window-mode transition.
      doc.documentElement.classList.toggle('desktop-mini-player', enabled || active);
      render();
      var requestedAspect = null;
      return Promise.resolve().then(function () {
        if (config.platform === 'preview') return { active: enabled, titlebar_hidden: enabled && hideTitlebar };
        var s = state(), hidden = !!(enabled && hideTitlebar && titlebarSupported());
        if (enabled && aspectSupported()) {
          requestedAspect = videoAspect(s);
          return bridge().SetMiniPlayerWithAspect(true, !!s.portrait, hidden, requestedAspect ? requestedAspect.width : 0, requestedAspect ? requestedAspect.height : 0);
        }
        return bridge().SetMiniPlayer(enabled, !!s.portrait, hidden);
      }).then(function (value) {
        var result = typeof value === 'string' ? JSON.parse(value) : value;
        if (!result || typeof result.active !== 'boolean') throw new Error('Invalid window response');
        pending = false;
        if (enabled && result.active && aspectSupported()) {
          aspectSession = Number(result.aspect_session) || 0;
          aspectKey = requestedAspect && result.aspect_applied ? requestedAspect.key : '';
          aspectFailed = requestedAspect && result.aspect_fallback ? requestedAspect.key : '';
          if (result.aspect_fallback) aspectFallback();
        }
        apply(result.active);
        applyTitlebar(result);
        if (result.error) throw new Error(result.error);
        return result.active === enabled;
      }).catch(function () {
        pending = false;
        doc.documentElement.classList.toggle('desktop-mini-player', active);
        if (!active && app() && app().miniPlayerChanged) app().miniPlayerChanged(false, savedCinema);
        if (app() && app().miniPlayerNotify) app().miniPlayerNotify(text('mini.failed', '小窗切换失败，请重试'));
        return false;
      }).then(function (ok) { render(); return ok; });
    }
    function copy() {
      label(entry, text('mini.enter', '小窗播放'));
      entry.querySelector('.control-label').textContent = text('mini.enter', '小窗播放');
      var names = { restore: ['mini.restore', '返回大窗'], previousDrama: ['mini.previousDrama', '上一部'], previousEpisode: ['mini.previousEpisode', '上一集'],
        nextEpisode: ['mini.nextEpisode', '下一集'], nextDrama: ['mini.nextDrama', '下一部'], titlebar: ['mini.restoreTitlebar', '恢复系统标题栏'] };
      Object.keys(names).forEach(function (name) {
        var value = text(names[name][0], names[name][1]); label(buttons[name], value); buttons[name].querySelector('span').textContent = value;
      });
      label(progress, text('hero.playbackProgress', '播放进度')); label(volume, text('ui.volume', '音量'));
      renderSetting();
    }
    function render(nativeState, observedRevision) {
      if (!overlay) return;
      // Ignore a poll started before the most recent window-mode request.
      if (!pending && observedRevision === revision && nativeState && typeof nativeState.mini_player === 'boolean' && nativeState.mini_player !== active) apply(nativeState.mini_player);
      var s = state();
      entry.classList.toggle('is-hidden', !supported());
      entry.disabled = pending || !s.available;
      renderSetting();
      if (!active) return;
      if (!s.available && !pending) { request(false); return; }
      syncAspect();
      title.textContent = s.title || text('app.name', '红果短剧');
      episode.textContent = s.episode ? text('content.episodeNumber', '第{episode}集', { episode: s.episode }) : '';
      ['previousEpisode', 'nextEpisode', 'previousDrama', 'nextDrama'].forEach(function (name) { buttons[name].disabled = pending || !s[name]; });
      buttons.pause.disabled = pending || !s.canPlay;
      buttons.restore.disabled = pending;
      buttons.titlebar.disabled = pending;
      var pauseLabel = s.paused ? text('common.play', '播放') : text('ui.pause', '暂停');
      label(buttons.pause, pauseLabel); buttons.pause.querySelector('span').textContent = pauseLabel;
      var symbol = s.paused ? '#icon-play' : '#icon-pause', use = buttons.pause.querySelector('use');
      use.setAttribute('href', symbol); use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', symbol);
      progress.disabled = pending || !(s.duration > 0);
      progress.max = s.duration || 0;
      if (doc.activeElement !== progress) progress.value = s.position || 0;
      if (doc.activeElement !== volume) volume.value = s.volume || 0;
      time.textContent = clock(s.position) + ' / ' + clock(s.duration);
    }
    function handleKey(event, key, goFocus) {
      if (!active || !state().available || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
      if (key === 'Escape') { request(false); event.preventDefault(); event.stopPropagation(); return true; }
      keyboardFocus = true;
      var current = doc.activeElement;
      if (current && current.tagName === 'INPUT' && /^Arrow/.test(key)) { reveal(); event.stopPropagation(); return true; }
      if (key === 'Enter' || key === ' ') {
        if (!event.repeat) {
          if (key === 'Enter' && current && overlay.contains(current) && current.tagName === 'BUTTON') current.click();
          else command('toggle');
        }
      } else if (key === 'Tab' || /^Arrow/.test(key)) {
        var targets = Array.prototype.slice.call(overlay.querySelectorAll('button,input')).filter(function (node) { return !node.disabled && !node.classList.contains('is-hidden'); });
        ['player-retry', 'player-failure-diagnostics'].forEach(function (id) {
          var node = doc.getElementById(id);
          if (node && !node.disabled && node.getClientRects && node.getClientRects().length) targets.push(node);
        });
        var index = targets.indexOf(current), step = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Tab' && event.shiftKey ? -1 : 1;
        var target = targets[index < 0 ? 0 : (index + step + targets.length) % targets.length];
        if (target) goFocus(target);
      } else return false;
      reveal(); event.preventDefault(); event.stopPropagation(); return true;
    }
    function install() {
      var group = doc.querySelector('.playback-utility-group'), hero = doc.getElementById('hero');
      if (!group || !hero) return;
      entry = doc.createElement('button'); entry.type = 'button'; entry.id = 'desktop-mini-player';
      entry.className = 'control-button has-icon is-hidden'; entry.setAttribute('data-focus', 'desktop-mini-player');
      entry.innerHTML = '<span class="control-content">' + icon('mini-player') + '<span class="control-label"></span></span>';
      entry.addEventListener('click', function () { request(true); }); group.insertBefore(entry, group.firstChild);
      overlay = doc.createElement('section'); overlay.className = 'mini-player-overlay is-visible'; overlay.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('data-focus-zone', 'mini-player');
      var header = doc.createElement('div'); header.className = 'mini-player-header';
      var heading = doc.createElement('div'); heading.className = 'mini-player-heading';
      title = doc.createElement('strong'); episode = doc.createElement('span'); heading.appendChild(title); heading.appendChild(episode); header.appendChild(heading);
      button(header, 'titlebar', 'settings', function () { chooseTitlebar(false); }).classList.add('is-hidden');
      button(header, 'restore', 'fullscreen-exit', function () { request(false); }); overlay.appendChild(header);
      var footer = doc.createElement('div'); footer.className = 'mini-player-footer';
      progress = doc.createElement('input'); progress.id = 'mini-player-progress'; progress.type = 'range'; progress.min = '0'; progress.step = '.1'; progress.setAttribute('data-focus', 'mini-player-progress');
      progress.addEventListener('input', function () { command('seek', Number(progress.value)); }); footer.appendChild(progress);
      var row = doc.createElement('div'); row.className = 'mini-player-actions';
      button(row, 'previousDrama', 'drama-previous', function () { command('previousDrama'); });
      button(row, 'previousEpisode', 'episode-previous', function () { command('previousEpisode'); });
      button(row, 'pause', 'pause', function () { command('toggle'); });
      button(row, 'nextEpisode', 'episode-next', function () { command('nextEpisode'); });
      button(row, 'nextDrama', 'drama-next', function () { command('nextDrama'); }); footer.appendChild(row);
      var bottom = doc.createElement('div'); bottom.className = 'mini-player-audio'; time = doc.createElement('span'); bottom.appendChild(time);
      volume = doc.createElement('input'); volume.id = 'mini-player-volume'; volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.step = '1'; volume.setAttribute('data-focus', 'mini-player-volume');
      volume.addEventListener('input', function () { command('volume', Number(volume.value)); }); bottom.appendChild(volume); footer.appendChild(bottom);
      overlay.appendChild(footer); hero.appendChild(overlay);
      hero.addEventListener('mousemove', function () { keyboardFocus = false; reveal(); });
      hero.addEventListener('click', function (event) { if (event && event.detail > 0) keyboardFocus = false; reveal(); });
      overlay.addEventListener('mousedown', function () { keyboardFocus = false; });
      overlay.addEventListener('focusin', reveal); overlay.addEventListener('focusout', function () { win.setTimeout(scheduleHide, 0); });
      var video = doc.getElementById('hero-video');
      ['timeupdate', 'loadedmetadata', 'resize', 'play', 'pause', 'volumechange', 'emptied', 'ended'].forEach(function (name) { video.addEventListener(name, function () { render(); if (name === 'pause') scheduleHide(); }); });
      // A new episode and buffering recovery both emit playing. Media events
      // update labels/timers but leave visibility to explicit user interaction.
      video.addEventListener('playing', function () { render(); scheduleHide(); });
      if (win.HongguoI18n) win.HongguoI18n.onChange(function () { copy(); render(); });
      settingCard = doc.getElementById('desktop-mini-titlebar-settings');
      settingToggle = doc.getElementById('desktop-mini-titlebar-toggle');
      settingState = doc.getElementById('desktop-mini-titlebar-state');
      if (settingCard && settingToggle && settingState) settingToggle.addEventListener('click', function () { chooseTitlebar(!hideTitlebar); });
      else settingCard = null;
      copy(); render();
    }
    install();
    return { isActive: function () { return active; }, isPending: function () { return pending; }, revision: function () { return revision; }, request: request, render: render, handleKey: handleKey, chooseTitlebar: chooseTitlebar };
  }
  return { create: create };
}));
