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
    function app() { return win.HongguoTV; }
    function bridge() { return win.go && win.go.main && win.go.main.desktopApp; }
    function state() { return app() && app().miniPlayerState ? app().miniPlayerState() : {}; }
    function text(key, fallback, params) { return win.HongguoI18n ? win.HongguoI18n.t(key, params, fallback) : fallback; }
    function supported() { return /^(darwin|windows|linux|preview)$/.test(config.platform) && (config.platform === 'preview' || bridge() && bridge().SetMiniPlayer); }
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
    function reveal() {
      if (!overlay) return;
      overlay.classList.add('is-visible');
      win.clearTimeout(timer);
      if (active && !state().paused && !keyboardFocus) {
        timer = win.setTimeout(function () { overlay.classList.remove('is-visible'); }, 2500);
      }
    }
    function apply(value) {
      var changed = active !== value;
      active = value;
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
      return Promise.resolve().then(function () {
        return config.platform === 'preview' ? { active: enabled } : bridge().SetMiniPlayer(enabled, !!state().portrait);
      }).then(function (value) {
        var result = typeof value === 'string' ? JSON.parse(value) : value;
        if (!result || typeof result.active !== 'boolean') throw new Error('Invalid window response');
        pending = false;
        apply(result.active);
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
        nextEpisode: ['mini.nextEpisode', '下一集'], nextDrama: ['mini.nextDrama', '下一部'] };
      Object.keys(names).forEach(function (name) {
        var value = text(names[name][0], names[name][1]); label(buttons[name], value); buttons[name].querySelector('span').textContent = value;
      });
      label(progress, text('hero.playbackProgress', '播放进度')); label(volume, text('ui.volume', '音量'));
    }
    function render(nativeState, observedRevision) {
      if (!overlay) return;
      // Ignore a poll started before the most recent window-mode request.
      if (!pending && observedRevision === revision && nativeState && typeof nativeState.mini_player === 'boolean' && nativeState.mini_player !== active) apply(nativeState.mini_player);
      var s = state();
      entry.classList.toggle('is-hidden', !supported());
      entry.disabled = pending || !s.available;
      if (!active) return;
      if (!s.available && !pending) { request(false); return; }
      title.textContent = s.title || text('app.name', '红果短剧');
      episode.textContent = s.episode ? text('content.episodeNumber', '第{episode}集', { episode: s.episode }) : '';
      ['previousEpisode', 'nextEpisode', 'previousDrama', 'nextDrama'].forEach(function (name) { buttons[name].disabled = pending || !s[name]; });
      buttons.pause.disabled = pending || !s.canPlay;
      buttons.restore.disabled = pending;
      var pauseLabel = s.paused ? text('common.play', '播放') : text('ui.pause', '暂停');
      label(buttons.pause, pauseLabel); buttons.pause.querySelector('span').textContent = pauseLabel;
      var symbol = s.paused ? '#icon-play' : '#icon-pause', use = buttons.pause.querySelector('use');
      use.setAttribute('href', symbol); use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', symbol);
      progress.disabled = pending || !(s.duration > 0);
      progress.max = s.duration || 0;
      if (doc.activeElement !== progress) progress.value = s.position || 0;
      if (doc.activeElement !== volume) volume.value = s.volume || 0;
      time.textContent = clock(s.position) + ' / ' + clock(s.duration);
      if (s.paused) overlay.classList.add('is-visible');
    }
    function handleKey(event, key, goFocus) {
      if (!active || !state().available || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
      if (key === 'Escape') { request(false); event.preventDefault(); event.stopPropagation(); return true; }
      keyboardFocus = true;
      var current = doc.activeElement;
      if (current && current.tagName === 'INPUT' && /^Arrow/.test(key)) { event.stopPropagation(); return true; }
      if (key === 'Enter' || key === ' ') {
        if (!event.repeat) {
          if (key === 'Enter' && current && overlay.contains(current) && current.tagName === 'BUTTON') current.click();
          else command('toggle');
        }
      } else if (key === 'Tab' || /^Arrow/.test(key)) {
        var targets = Array.prototype.slice.call(overlay.querySelectorAll('button,input')).filter(function (node) { return !node.disabled; });
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
      overlay.addEventListener('mousedown', function () { keyboardFocus = false; });
      overlay.addEventListener('focusin', reveal); overlay.addEventListener('focusout', function () { win.setTimeout(reveal, 0); });
      var video = doc.getElementById('hero-video');
      ['timeupdate', 'loadedmetadata', 'play', 'pause', 'volumechange', 'emptied', 'ended'].forEach(function (name) { video.addEventListener(name, function () { render(); }); });
      video.addEventListener('playing', function () { render(); reveal(); });
      if (win.HongguoI18n) win.HongguoI18n.onChange(function () { copy(); render(); });
      copy(); render();
    }
    install();
    return { isActive: function () { return active; }, isPending: function () { return pending; }, revision: function () { return revision; }, request: request, render: render, handleKey: handleKey };
  }
  return { create: create };
}));
