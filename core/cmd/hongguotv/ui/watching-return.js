(function (root) {
  'use strict';
  function create(options) {
    var saved = null;
    var view = options.view;
    var hovered = false;
    var focused = false;
    var coverKey = '';
    function snapshot() {
      return saved && saved.owner === options.owner() ? saved : null;
    }
    function hideTooltip() { view.tooltip.classList.add('is-hidden'); }
    function tooltip() {
      hideTooltip();
      var needsTooltip = options.icons() || view.title.scrollWidth > view.title.clientWidth;
      if (!snapshot() || options.playbackPage() || !needsTooltip || !hovered && !focused) return;
      var rect = view.button.getBoundingClientRect();
      view.tooltip.classList.remove('is-hidden');
      var bounds = options.bounds();
      view.tooltip.style.left = Math.max(8, Math.min(rect.right + 12, bounds.width - view.tooltip.offsetWidth - 8)) + 'px';
      view.tooltip.style.top = Math.max(8, Math.min(rect.top, bounds.height - view.tooltip.offsetHeight - 8)) + 'px';
    }
    function render() {
      var current = snapshot();
      var hidden = !current || options.playbackPage();
      view.wrap.classList.toggle('is-hidden', hidden);
      if (options.visibility) options.visibility(!hidden);
      hideTooltip();
      if (hidden) { hovered = false; focused = false; return; }
      var title = current.item.title || options.text('ui.unnamedDrama', '未命名短剧');
      var meta = options.text('watching.episodePosition', '第 {episode} 集 · {position}', { episode: current.episode, position: options.clock(current.position) });
      view.title.textContent = view.tooltipTitle.textContent = title;
      view.meta.textContent = meta;
      view.tooltipMeta.textContent = meta + ' · ' + options.text('watching.fullscreen', '全屏继续');
      view.button.setAttribute('aria-label', options.text('watching.accessibility', '全屏继续观看《{title}》第{episode}集，从{position}继续', { title: title, episode: current.episode, position: options.clock(current.position) }));
      var key = current.item.series_id + ':' + (current.item.cover_fallback || current.item.cover || '');
      if (key !== coverKey) { coverKey = key; options.cover(view.cover, current.item); }
      tooltip();
    }
    function capture(value) {
      if (!value || !value.item || !value.item.series_id || value.owner !== options.owner() || !(value.episode > 0)) return false;
      saved = { item: Object.assign({}, value.item), episode: value.episode, position: Math.max(0, Number(value.position) || 0), owner: value.owner };
      return true;
    }
    view.button.addEventListener('click', function () {
      var current = snapshot();
      if (!current || options.playbackPage()) return;
      hideTooltip();
      options.resume(current, view.button);
    });
    view.button.addEventListener('focus', function () { focused = true; tooltip(); });
    view.button.addEventListener('blur', function () { focused = false; hideTooltip(); });
    view.button.addEventListener('mouseenter', function () { hovered = true; tooltip(); });
    view.button.addEventListener('mouseleave', function () { hovered = false; if (!focused) hideTooltip(); });
    return { capture: capture, render: render, layout: tooltip, clear: function () { saved = null; coverKey = ''; render(); }, snapshot: snapshot };
  }
  var api = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HongguoWatchingReturn = api;
})(typeof window !== 'undefined' ? window : this);
