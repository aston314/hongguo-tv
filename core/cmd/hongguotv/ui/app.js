(function () {
  'use strict';

  // TV remote buttons are routed by semantic zones. A geometry-only algorithm
  // can jump from the sidebar to a right-side action just because it is close
  // on screen, which is especially confusing on a TV.
  var zoneSelectors = {
    sidebar: '.side-item',
    channels: '.channel-tab, #core-status[tabindex="0"]',
    coreConnection: '.core-connection-action, #core-connection-scroll',
    feed: '.hero-feed-focus',
    catalog: '.catalog-card',
    actions: '.round-action',
    controls: '.playback-buttons .control-button, #player-retry, #player-failure-diagnostics',
    timeline: '#control-progress',
    searchInput: '#search-input',
    searchSuggestions: '.search-suggestion',
    searchActions: '.search-action',
    searchHistory: '.search-history-action',
    searchScan: '.search-scan-action',
    searchFilters: '.search-filter, .filter-toggle',
    searchResults: '.search-result-card',
    listRetry: '.list-retry',
    rankPanels: '.rank-panel',
    rankFilters: '.rank-filter-toggle',
    discussion: '.discussion-item, .discussion-reply, .discussion-action, .discussion-close, #discussion-input',
    reservationItems: '.reservation-row',
    publicationActions: '.publication-action',
    rankTabs: '.rank-tab',
    rankViews: '.rank-view-tab',
    radarViewTabs: '.radar-view-tab',
    radarRefresh: '.radar-refresh',
    radarOfficialTabs: '.radar-filter[data-radar-official]',
    radarGrowthMetrics: '.radar-filter[data-radar-metric]',
    radarGrowthTypes: '.radar-filter[data-radar-type]',
    radarOfficialItems: '.radar-official-row',
    radarGrowthItems: '.radar-growth-row',
    rankSubnav: '.rank-subtab',
    rankItems: '.rank-row',
    rankActions: '.rank-row-play, .rank-row-detail, .rank-row-actor',
    newTabs: '.new-tab',
    newFilters: '.new-filter',
    newItems: '.new-card',
    calendarDays: '.calendar-day',
    calendarItems: '.calendar-row',
    reservationTabs: '.reservation-tab',
    libraryTabs: '.library-tab',
    followTabs: '.follow-tab',
    libraryActions: '.library-toolbar-button',
    historyFilters: '.history-filter',
    libraryItems: '.library-card',
    libraryRemovals: '.library-remove',
    accountInputs: '.account-input',
    accountKeypad: '.account-keypad-key',
    accountActions: '.account-action',
    appUpdates: '.app-update-action',
    webosUpdateNotes: '.webos-update-notes',
    localeActions: '.locale-action',
    recommendationDirection: '.recommendation-direction-action',
    sidebarDisplay: '.sidebar-display-action',
    autoCinema: '.auto-cinema-action',
    webosAudio: '.webos-audio-action',
    episodePrefetch: '.episode-prefetch-action',
    playbackModes: '.playback-mode-action',
    support: '.support-card, .support-close',
    rankModal: '.rank-filter-option, .rank-filter-close, .rank-filter-apply',
    actorWorks: '.actor-works-close, .actor-works-retry, .actor-work-card',
    detailHeaderActions: '.detail-header-action, #detail-close, .detail-cast-more',
    detailCast: '.detail-cast-item, #detail-cast-more',
    detailCastModal: '.detail-cast-close, .detail-cast-modal-item',
    confirmation: '.confirm-button',
    playerOptions: '.player-option, #player-compose-input, #player-diagnostics-scroll',
    playbackCommandMenu: '.playback-command-action',
    endRecommendations: '.end-recommendation-card, #end-recommendations-close',
    modalActions: '.modal-action',
    episodes: '.detail-episode',
    detailTabs: '.detail-tab',
    seriesRows: '.series-row'
    ,followItems: '.follow-card'
    ,followActions: '.follow-action'
    ,followNotifications: '.follow-notification-action'
    ,followNotificationItems: '.follow-notification-play, .follow-notification-detail'
    ,libraryTypeFilters: '.library-type-filter'
    ,accountCountry: '#account-country'
    ,accountCountryItems: '.account-country-item, #account-country-close'
  };
  var status = document.getElementById('core-status');
  var coreStatusLabel = document.getElementById('core-status-label');
  var coreStatusState = 'connecting';
  var coreStatusVersion = '';
  var coreStatusDiagnostic = '';
  var coreConnectionDiagnostic = null;
  var coreConnectionModalOpen = false;
  var coreConnectionReturnFocus = null;
  var notice = document.getElementById('action-notice');
  var shell = document.querySelector('.app-shell');
  function uiText(key, fallback, params) {
    return window.HongguoI18n && typeof window.HongguoI18n.t === 'function' ? window.HongguoI18n.t(key, params, fallback) : (fallback === undefined ? key : fallback);
  }
  function renderCoreStatus() {
    var message = {
      connecting: ['core.connecting', '连接核心服务…'],
      connected: ['ui.serviceConnected', '已连接'],
      error: ['ui.serviceError', '连接异常'],
      unavailable: ['ui.serviceUnavailable', '本机服务连接失败，请重新打开应用']
    }[coreStatusState] || ['core.connecting', '连接核心服务…'];
    var diagnostic = coreStatusState !== 'connected' ? coreStatusDiagnostic : '';
    coreStatusLabel.textContent = uiText(message[0], message[1]) + (diagnostic ? ' [' + diagnostic + ']' : '');
    status.dataset.ok = coreStatusState === 'connected' ? 'true' : 'false';
    var canDiagnose = !!window.HongguoWebOS && coreStatusState !== 'connected';
    status.tabIndex = canDiagnose ? 0 : -1;
    status.setAttribute('aria-disabled', canDiagnose ? 'false' : 'true');
    if (coreStatusState === 'connected' && coreStatusVersion) status.title = uiText('common.version', '版本 {version}', { version: coreStatusVersion });
    else if (diagnostic) status.title = diagnostic;
    else status.removeAttribute('title');
  }
  if (window.HongguoI18n && typeof window.HongguoI18n.onChange === 'function') window.HongguoI18n.onChange(renderCoreStatus);
  function apiError(payload, status, key, fallback) {
    var detail = payload && (payload.error || payload.message);
    var i18n = window.HongguoI18n;
    // Keep detailed upstream/server wording in the source locale. Once a
    // translated locale is active, use the stable UI key instead of leaking
    // Chinese backend text into the translated interface.
    if (detail && (!i18n || typeof i18n.locale !== 'function' || i18n.locale() === i18n.defaultLocale)) return String(detail);
    return uiText(key, fallback || (status ? 'HTTP {status}' : '请求失败'), status ? { status: status } : null);
  }
  function localizedError(error, key, fallback) {
    var detail = error && typeof error === 'object' ? error.message : error;
    return apiError(detail ? { error: detail } : null, 0, key, fallback);
  }
  function phoneCountryName(country) {
    return window.HongguoPhoneCountryName ? window.HongguoPhoneCountryName(country) : country && (country.name || country.code) || '';
  }
  var sidebarStorage;
  try { sidebarStorage = window.localStorage; } catch (ignoredStorage) {}
  var sidebarSettings = window.HongguoSidebarSettings.create({
    storage: sidebarStorage,
    bridge: window.HongguoTVPreferences,
    render: function (data) {
      shell.classList.toggle('sidebar-icons', data.mode === 'icons');
      document.querySelectorAll('.sidebar-display-action').forEach(function (button) {
        var selected = button.getAttribute('data-mode') === data.mode;
        button.classList.toggle('account-primary', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      document.getElementById('sidebar-display-state').textContent = data.mode === 'icons' ? uiText('settings.currentIcons', '当前：仅显示图标') : uiText('settings.currentExpanded', '当前：展开显示');
      syncNativePlayerBounds();
    }
  });
  function renderLocaleSettings() {
    var i18n = window.HongguoI18n;
    var current = i18n && typeof i18n.locale === 'function' ? i18n.locale() : 'zh-CN';
    document.querySelectorAll('.locale-action').forEach(function (button) {
      var selected = button.getAttribute('data-locale') === current;
      button.classList.toggle('account-primary', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    var state = document.getElementById('language-state');
    if (state) state.textContent = uiText('settings.currentLanguage', '当前：{language}', { language: current === 'zh-TW' ? uiText('settings.languageChineseTraditional', '繁體中文') : current === 'ja-JP' ? uiText('settings.languageJapanese', '日本語') : uiText('settings.languageChineseSimplified', '简体中文') });
  }
  var androidShell = /HongguoTV-Android/.test(navigator.userAgent);
  var webosShell = !!window.HongguoWebOS;
  // Explicit Wails configuration or ?platform=desktop; TV browser previews
  // retain the Android interaction model but do not expose native settings.
  var desktopShell = !!window.HongguoDesktop;
  var desktopPointerFocus = null;
  var autoCinemaPlatform = desktopShell ? 'desktop' : androidShell ? 'android' : webosShell ? 'webos' : 'desktop';
  var autoCinemaEnabled = autoCinemaPlatform === 'android' || autoCinemaPlatform === 'webos';
  var autoCinemaCandidate = false;
  var autoCinemaSession = null;
  var autoCinemaGeneration = 0;
  var autoCinemaPreferences = null;
  var autoCinemaSettingCard = document.getElementById('auto-cinema-settings');
  var autoCinemaToggle = document.getElementById('auto-cinema-toggle');
  var episodePrefetchSettingCard = document.getElementById('episode-prefetch-settings');
  var playbackMenuHintSeen = false;
  var playbackMenuHintCandidate = false;
  var playbackMenuHintTimer = 0;
  var playbackMenuHintPreviewForced = /(?:^|[?&])show-playback-menu-hint=1(?:&|$)/.test((window.location && window.location.search) || '');
  var playbackMenuHintAvailable = androidShell || webosShell || playbackMenuHintPreviewForced;
  function applicationHidden() { return desktopShell ? !!window.HongguoDesktop.background : !!document.hidden; }
  document.documentElement.classList.toggle('desktop-shell', desktopShell);
  document.documentElement.classList.toggle('tv-shell', androidShell || webosShell);
  var numericKeypad;
  var accountNumberScan;
  var accountPhoneCountries = window.HongguoPhoneCountries || [];
  var accountPhoneCountryCode = '+86';
  var accountCountryModalOpen = false;
  var accountCountryReturnFocus = null;
  var searchNumberScan;
  var danmakuNumberScan;
  var searchScanOpen = false;
  var danmakuScanOpen = false;
  var searchScanReturnFocus = null;
  var danmakuScanReturnFocus = null;
  var searchHistory;
  var searchHistoryEpoch = 0;
  var accountKeypadReturnFocus = null;
  var accountKeypadPhase = '';
  var mainSurface = document.getElementById('main-surface');
  var supportPage = document.getElementById('support-page');
  var supportModalOpen = false;
  var supportReturnFocus = null;
  var engagement;
  var pagePlaceholder = document.getElementById('page-placeholder');
  var detailModal = document.getElementById('detail-modal');
  var detailModalOpen = false;
  var playbackCommandMenu = document.getElementById('playback-command-menu');
  var playbackCommandMenuOpen = false;
  var playbackCommandMenuReturnFocus = null;
  var playbackDetailReturnToMenu = false;
  var playbackDetailResumeAction = '';
  var discussionOpen = false;
  var discussionReturn = null;
  var discussionSession = null;
  var discussionEpoch = 0;
  var discussionReplyTarget = null;
  var discussionBusy = false;
  var discussionRequest = null;
  var discussionDrafts = {};
  var replyPagers = [];
  var danmakuEnabled = false;
  var danmakuGeneration = 0;
  var danmakuRequest = null;
  var danmakuRows = [];
  var danmakuWindow = -1;
  var danmakuBusy = false;
  var danmakuLane = 0;
  var danmakuLast = -1;
  var detailGeneration = 0;
  var detailReturnFocus = null;
  var detailSeriesID = '';
  var currentDetail = null;
  var detailTab = 'episodes';
  var detailFocusPending = false;
  var detailRequestItem = null;
  var seriesRootID = '';
  var seriesItems = [];
  var seriesLoaded = false;
  var seriesGeneration = 0;
  var seriesRequest = null;
  var seriesFocusCurrent = false;
  var seasonCatalogCache = {};
  var seasonCatalogKeys = [];
  var seasonCatalogRequests = [];
  // Reservation writes can become visible in the upstream list a little later
  // than the mutation response. Keep a short, account-scoped confirmation so
  // the series selector and reservation page do not contradict each other.
  var reservationOverrides = Object.create(null);
  var reservationOverrideTTL = 5 * 60 * 1000;
  var seasonControlID = '';
  var seasonControlState = '';
  var seasonControlGeneration = 0;
  var seasonSwitchGeneration = 0;
  var seasonSwitchRequest = null;
  var seasonSwitchID = '';
  var seriesReservationRequest = null;
  var seriesReservationID = '';
  var lastContentFocus = null;
  var lastPageFocus = {};
  var featuredItem = null;
  var feedItems = [];
  var feedIndex = -1;
  var recommendationSession = null;
  var recommendationAutoplayPending = false;
  var lastAutoRecommendationSeriesMemory = '';
  var recommendationOrientationCheckLimit = 8;
  var feedGeneration = 0;
  var continuationGeneration = 0;
  var searchInput = document.getElementById('search-input');
  var searchPage = document.getElementById('search-page');
  var searchResults = document.getElementById('search-results');
  var searchSuggestions = document.getElementById('search-suggestions');
  document.querySelector('.search-submit').classList.toggle('is-hidden', androidShell);

  var filterRows = [];
  var searchPanelPending = false;
  var searchFiltersExpanded = false;
  var searchFilters = { genre: '', sort: 'hot_score' };
  var searchKind = 'browse';
  var searchItems = [];
  var rankPage = document.getElementById('rank-page');
  var rankList = document.getElementById('rank-list');
  var newPage = document.getElementById('new-page');
  var newGrid = document.getElementById('new-grid');
  var calendarList = document.getElementById('calendar-list');
  var dateStrip = document.getElementById('new-date-strip');
  var rankItems = [];
  var newItems = [];
  var newMode = 'recommend';
  var newGender = 'all';
  var calendarDate = '';
  var calendarSchema = null;
  var rankOptions = [];
  var rankSelection = { rank: 'all', rank_sub: 'ranklist_hot_play_sc', rank_panel: '' };
  var rankFilterOpen = false;
  var rankDraftSelection = null;
  var actorWorksOpen = false;
  var actorWorksReturnFocus = null;
  var actorWorksItem = null;
  var actorWorksRequest = null;
  var actorWorksGeneration = 0;
  var detailCastOpen = false;
  var detailCastReturnFocus = null;
  var rankView = 'official';
  var radarView = 'official';
  var radarData = null;
  var radarRequest = null;
  var radarGeneration = 0;
  var reservationMode = 'online';
  var followView = 'follow';
  var reservationCounts = { online: null, upcoming: null };
  var activeSearchQuery = '';
  var searchSuggestionTimer = null;
  var searchSuggestionRequest = null;
  var searchSuggestionGeneration = 0;
  var searchSuggestionOpen = false;
  var searchSuggestionItems = [];
  var searchSuggestionReturnKey = '';
  var searchSuggestionFocusedKey = '';
  var searchSuggestionDismissedQuery = '';
  var tailTimer = null;
  var playerReturnPage = null;
  var playerReturnFocus = null;
  var libraryPage = document.getElementById('library-page');
  var accountPage = document.getElementById('account-page');
  var settingsPage = document.getElementById('settings-page');
  var accountData = null;
  var accountStatusInitialized = false;
  var accountQR = null;
  var accountLoginMethod = 'qr';
  var pendingAccountHomeProgram = null;
  var accountBusy = false;
  var accountNotice = '';
  var accountNoticeIsError = false;
  var accountLeftFocus = null;
  var accountPollBusy = false;
  var accountEpoch = 0;
  var accountRequestGeneration = 0;
  var accountPollTimer = null;
  var smsVerification = null;
  var accountCountdownUntil = 0;
  var libraryData = { entries: [] };
  var libraryLoaded = false;
  var libraryError = '';
  var libraryEditing = false;
  var historyFilter = 'all';
  var libraryTypeFilter = 'all';
  var followPage = document.getElementById('follow-page');
  var followGrid = document.getElementById('follow-grid');
  var followActions = document.querySelector('#follow-page .follow-actions');
  var followListView = document.getElementById('follow-list-view');
  var followNotificationView = document.getElementById('follow-notification-view');
  var followNotificationList = document.getElementById('follow-notification-list');
  var followNotificationItems = [];
  var followNotificationUnread = 0;
  var followNotificationViewOpen = false;
  var followNotificationReturnFocus = null;
  var notificationCheckBusy = false;
  var notificationLastCheck = 0;
  var notificationPopupTimer = null;
  var notificationPopupQueue = [];
  var notificationKnownKey = '';
  var libraryQueue = Promise.resolve();
  var libraryReady;
  var confirmOpen = false;
  var confirmReturnFocus = null;
  var confirmOperation = null;
  var confirmAfterClose = null;
  var confirmationGeneration = 0;
  var activePlayback = null;
  var episodeCoverLoader = null;
  var prewarmedEpisodeCover = null;
  var detailCache = {};
  var playerOptionsOpen = false;
  var playerOptionsReturn = null;
  var diagnosticEpoch = 0;
  var diagnosticRequest = null;
  var controlsTimer = null;
  var controlsManuallyHidden = false;
  var playbackFeedback = null;
  var rangeTransitionTimer = null;
  var rangeStallTimer = null;
  var lastPlaybackControl = null;
  var nativeFullscreen = false;
  var fullscreenExitKeepsHidden = false;
  var playbackQuality = '';
  var playbackQualities = [];
  var qualityRequest = null;
  var qualityEpoch = 0;
  var qualityPrevious = null;
  var composeSession = null;
  var composeRequest = null;
  var composeBusy = false;
  var composeEpoch = 0;
  var danmakuDrafts = {};
  var playbackRequest = null;
  var playbackInfoRequest = null;
  var playbackPrefetchHandoff = null;
  var playbackAudioHold = null;
  var playbackTiming = [];
  var playbackRecovery = HongguoPlaybackRecovery.create({ maxAttempts: 1 });
  // webOS can leave the first local Range response waiting on an upstream
  // request for several seconds. Keep that delay bounded for the TV player;
  // desktop and MPV retain their existing recovery windows.
  var webOSRangeStallFallbackMs = 8000;
  // Bounded, memory-only diagnostics. No drama IDs, titles or account data.
  window.HongguoTVPlaybackTiming = { snapshot: function () { return playbackTiming.map(function (item) { return Object.assign({}, item); }); } };
  var episodePrefetch = HongguoEpisodePrefetch.create({
    maxRetries: window.HongguoWebOS ? 1 : 0,
    retryDelayMs: 3000,
    maxAgeMs: window.HongguoWebOS ? 120000 : 0,
    fullMaxAgeMs: 110 * 60 * 1000,
    lookup: function (info, signal) {
      return getDetail(info.item, signal).then(function (detail) {
        if (!detail || detail.series_id !== info.series_id) return null;
        var next = HongguoEpisodePrefetch.nextPrefetchEpisode(detail, info.episode);
        return next ? { series_id: info.series_id, vid: next.vid, episode: next.episode, quality: info.quality || '',
          fallback: '1', mode: info.mode || '', codec_mode: info.codec_mode || 'default', prefetch_mode: info.prefetch_mode || info.mode || '', owner: info.owner } : null;
      });
    },
    prepare: function (target, signal) {
      // `mode` describes the player that will consume the result. The
      // prefetch strategy is separate: full preparation must use the existing
      // complete-file resolver, while range preparation must stay on the
      // bounded Range path and never silently download the whole episode.
      var params = HongguoEpisodePrefetch.prepareParams(target);
      return fetchData('/api/v1/play/info?' + new URLSearchParams(params), signal ? { signal: signal } : {});
    }
  });
  var applicationInBackground = false;
  var playbackPreferences = { speed: 1, volume: 100, quality: '', danmaku: false, prefetch_mode: 'range' };
  var episodePrefetchSettings = null;
  var recommendationDirectionSettings = null;
  var endRecommendationIndex = 0, endRecommendationAnimation = 0, endRecommendationReadyCleanup = null;
  var endRecommendations = HongguoEndRecommendations.create({
    isCurrent: function (playback) {
      return !!(playback && activePlayback === playback && playback.owner === accountEpoch && playback.generation === feedGeneration &&
        pageMode() === 'player' && playback.completed && document.getElementById('hero-video').ended && !applicationInBackground && !applicationHidden());
    },
    canPresent: function () {
      return !scanModalOpen() && !accountKeypadOpen() && !supportModalOpen && !rankFilterOpen && !(typeof actorWorksOpen !== 'undefined' && actorWorksOpen) && !confirmOpen &&
        !detailModalOpen && !playerOptionsOpen && !(typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) && !discussionOpen && zoneOf(document.activeElement) === 'feed';
    },
    canAutoplay: function () {
      var track = document.getElementById('end-recommendations-track');
      return !scanModalOpen() && !accountKeypadOpen() && !supportModalOpen && !rankFilterOpen && !(typeof actorWorksOpen !== 'undefined' && actorWorksOpen) && !confirmOpen &&
        !detailModalOpen && !playerOptionsOpen && !(typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) && !discussionOpen && (!document.hasFocus || document.hasFocus()) && document.activeElement === track.children[0];
    },
    now: function () { return window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now(); },
    countdown: renderEndRecommendationCountdown,
    show: showEndRecommendations,
    hide: hideEndRecommendations,
    play: function (item) { startPlayer(item, playerReturnFocus); }
  });
  var playbackSpeeds = [.5, .75, 1, 1.25, 1.5, 2];
  function episodePrefetchPlatform() { return webosShell ? 'webos' : androidShell ? 'android' : desktopShell ? 'desktop' : 'preview'; }
  function supportsFullEpisodePrefetch() {
    return typeof HongguoEpisodePrefetchSettings !== 'undefined' && HongguoEpisodePrefetchSettings &&
      typeof HongguoEpisodePrefetchSettings.supports === 'function' && typeof episodePrefetchPlatform === 'function' &&
      HongguoEpisodePrefetchSettings.supports(episodePrefetchPlatform());
  }
  function effectiveEpisodePrefetchMode() {
    return supportsFullEpisodePrefetch() && playbackPreferences.prefetch_mode === 'full' ? 'full' : 'range';
  }
  function rangePlaybackEnabled() {
    // MPV now tries the same local Range/decrypt proxy as WebView/Media3.
    // The server still returns the established complete-file source when the
    // Range contract is not usable, so this remains a bounded preference.
    return true;
  }
  var keyNames = {
    // WebView delivers DOM key codes, not Android KeyEvent constants.
    // Chromium 44 may omit event.key entirely.
    37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
    13: 'Enter', 27: 'Escape', 8: 'Backspace', 9: 'Tab', 46: 'Delete', 32: ' ',
    19: 'ArrowUp', 20: 'ArrowDown', 21: 'ArrowLeft', 22: 'ArrowRight',
    23: 'Enter', 66: 'Enter', 160: 'Enter', 4: 'Escape', 111: 'Escape'
  };

  function playMedia(video) {
    // play() returned undefined before Chromium 50.
    try { return Promise.resolve(video.play()); } catch (error) { return Promise.reject(error); }
  }

  function stageNativePlaybackStartPosition(position) {
    var adapter = typeof window !== 'undefined' ? window.HongguoNativePlaybackAdapter : null;
    if (adapter && typeof adapter.setStartPosition === 'function') adapter.setStartPosition(position);
  }

  function fetchData(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || !payload.ok) {
          var error = new Error(apiError(payload, response.status, 'common.networkFailed', '连接失败') + (payload && (payload.error || payload.message) ? '' : '（' + response.status + '）'));
          error.code = payload.error || '';
          error.status = response.status;
          error.upstreamStatus = Number(payload.upstream_status) || 0;
          throw error;
        }
        var data = payload.data || payload;
        if (data.path && window.HongguoDesktopUI) data.path = window.HongguoDesktopUI.mediaSource(data.path, window.HongguoDesktop);
        return data;
      });
    });
  }
  function listStatus(pager, id) {
    var node = document.getElementById(id);
    if (!node) return;
    // Keep the retry node stable while it owns focus.
    if (pager.error) {
      var text = node.querySelector('span');
      if (!text) { node.innerHTML = ''; text = document.createElement('span'); node.appendChild(text); }
      text.textContent = uiText('content.loadFailed', '加载失败：{error}', { error: localizedError(pager.error, 'common.networkFailed', '连接失败') });
      var retry = node.querySelector('button');
      if (!retry) {
        retry = document.createElement('button'); retry.className = 'list-retry'; retry.textContent = uiText('common.retry', '重试'); retry.dataset.focus = id + '-retry'; retry.__pager = pager;
        retry.addEventListener('click', function () {
          var current = document.activeElement; var generation = pager.generation;
          pager.load(true).then(function (added) {
            if (generation !== pager.generation || document.activeElement !== current && document.activeElement !== document.body) return;
            if (!pager.error) { var cards = focusables(pager.selector); goFocus(cards[cards.length - added.length] || cards[cards.length - 1] || firstContentFocus()); }
          });
        });
        node.appendChild(retry);
      }
      retry.disabled = pager.busy;
    } else {
      var oldRetry = node.querySelector('button');
      if (oldRetry && document.activeElement === oldRetry && pager.busy) { oldRetry.disabled = true; return; }
      node.textContent = pager.busy ? uiText('common.loading', '正在加载…') : pager.loaded && !pager.hasMore() && pager.items.length ? uiText('content.allShown', '已显示全部') : '';
    }
    node.setAttribute('aria-busy', String(pager.busy));
  }
  function calendarCursor(data, old) {
    var cursor = { offset: Number(data.next_offset) || 0, session_id: data.session_id || old.session_id || '',
      subscribe_offset: data.next_subscribe_offset == null ? old.subscribe_offset || '' : String(data.next_subscribe_offset) };
    var date = data.calendar && data.calendar.default_date || old.date;
    if (date) cursor.date = date;
    return cursor;
  }
  function createListPager(endpoint, container, selector, id, render, metadata, prefetchPages) {
    var pager = HongguoPagination.create({
      request: function (params, signal) { var requestParams = Object.assign({}, params); if (endpoint === '/api/v1/follow') delete requestParams.shown; return fetchData((pager.endpoint || endpoint) + '?' + new URLSearchParams(requestParams).toString(), signal ? { signal: signal } : {}); },
      clear: function () { if (container) renderMessage(container, 'list-empty', uiText('common.loading', '正在加载…')); },
      render: function (items, append, p) {
        if (items.length && container) container.querySelectorAll('.list-empty, .calendar-empty, .search-result-empty, .rank-empty').forEach(function (node) { node.remove(); });
        render(items, append, p);
      },
      metadata: metadata,
      cursor: endpoint === '/api/v1/lists/calendar' ? calendarCursor : endpoint === '/api/v1/lists/recommend' ? function (data, old) { return { offset: Number(data.next_offset) || 0, session_id: data.session_id || old.session_id || '', feed_cell: data.feed_cell || old.feed_cell || '', feed_plan: data.feed_plan || old.feed_plan || '' }; } : endpoint === '/api/v1/follow' ? function (data) { return data.next_cursor ? { cursor: data.next_cursor } : {}; } : null,
      prefetchPages: prefetchPages,
      status: function (p) { listStatus(p, id); },
      after: queueTailCheck
    });
    pager.container = container; pager.selector = selector; pager.statusID = id;
    return pager;
  }
  var searchPager = (function () {
    var pager;
    // A single endpoint wrapper handles both contracts without changing cursors.
    pager = HongguoPagination.create({
      request: function (params, signal) { return fetchData((params.q ? '/api/v1/lists/search' : '/api/v1/category') + '?' + new URLSearchParams(params).toString(), signal ? { signal: signal } : {}); },
      clear: function () { searchItems = []; document.getElementById('search-result-count').textContent = ''; renderMessage(searchResults, 'list-empty', uiText('content.loadingDrama', '正在读取短剧…')); },
      render: function (items, append) { if (items.length) searchResults.querySelectorAll('.list-empty, .search-result-empty').forEach(function (node) { node.remove(); }); renderSearchResults(items, append); },
      metadata: function (data) {
        if (searchKind === 'browse') {
          if (searchPanelPending && (!data.filters || !data.filters.length)) throw new Error(uiText('content.filterMissing', '筛选条件未返回'));
          if (data.filters && data.filters.length) { searchPanelPending = false; renderFilterRows(data.filters); }
          document.getElementById('search-result-title').textContent = filterSummary(); document.getElementById('filter-state').textContent = filterSummary();
        } else if (!searchPager.loaded && searchPager.params.q && searchHistory && searchPager.historyEpoch === searchHistoryEpoch) {
          // First successful page, including empty results and a successful
          // retry. The pager excludes failed/cancelled/superseded responses.
          searchHistory.add(searchPager.params.q);
        }
      },
      status: function (p) { listStatus(p, 'search-pagination'); }, after: queueTailCheck
    });
    pager.container = searchResults; pager.selector = '.search-result-card'; pager.statusID = 'search-pagination'; return pager;
  })();
  var rankPager = createListPager('/api/v1/lists/rank', rankList, '.rank-row', 'rank-pagination', renderRank, function (data, pager) { if (!pager.loaded) renderRankSelectors(data.ranks); });
  var newPager = createListPager('/api/v1/lists/new', newGrid, '.new-card', 'new-pagination', renderNew);
  var calendarPager = createListPager('/api/v1/lists/calendar', calendarList, '.calendar-row', 'calendar-pagination', function (items, append) { renderPublications(items, append, false); }, function (data) { renderCalendarDays(data.calendar); });
  var reservationPager = createListPager('/api/v1/lists/reservations', document.getElementById('reservation-list'), '.reservation-row', 'reservation-pagination', function (items, append) { renderPublications(items, append, true); }, reservationMetadata);
  var libraryPager = createListPager('', document.getElementById('library-grid'), '.library-card', 'library-pagination', function () { renderLibrary(true); });
  var feedPager = createListPager('/api/v1/lists/recommend', null, '.hero-feed-focus', '', function (items, append) {
    if (!append) renderFeed(items);
    else if (feedIndex < 0 && items.length) renderFeed(items);
    else { feedItems = feedItems.concat(items); updateFeedCounter(); syncHomeChannel(feedItems); }
  }, null, 1);
  var discussionPager = HongguoPagination.create({
    key: function (item) { return item.comment_id; },
    cursor: function (data) { return data.next_cursor ? { cursor: data.next_cursor } : {}; },
    request: function (params, signal) { return fetchData('/api/v1/comments?' + new URLSearchParams(params), signal ? { signal: signal } : {}); },
    metadata: function (data) { if (discussionSession) { document.getElementById('discussion-title').textContent = uiText('content.commentCount', '第{episode}集评论 · {count}', { episode: discussionSession.episode, count: data.total || 0 }); engagement.commentTotal(discussionSession, data.total); } },
    clear: function () { renderMessage(document.getElementById('discussion-list'), 'list-empty', uiText('content.readingComments', '正在读取评论…')); },
    render: renderDiscussion,
    status: function (p) { listStatus(p, 'discussion-pagination'); }, after: queueTailCheck
  });
  discussionPager.container = document.getElementById('discussion-list'); discussionPager.selector = '.discussion-item'; discussionPager.statusID = 'discussion-pagination';
  var followPager = createListPager('/api/v1/follow', followGrid, '.follow-card', 'follow-pagination', renderFollow);
  var allPagers = [searchPager, rankPager, newPager, calendarPager, reservationPager, libraryPager, feedPager, followPager, discussionPager];

  function visiblePager() {
    if (discussionOpen) {
      var row = document.activeElement && document.activeElement.closest('.discussion-item');
      if (row && row.__replyPager && !row.querySelector('.discussion-replies').classList.contains('is-hidden') && row.__replyPager.hasMore()) return row.__replyPager;
      return discussionPager;
    }
    if (detailModalOpen || (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) || confirmOpen || playerOptionsOpen) return null;
    if (pageMode() === 'search') return searchPager;
    if (pageMode() === 'rank') return rankPager;
    if (pageMode() === 'new') return newMode === 'calendar' ? calendarPager : newPager;
    if (pageMode() === 'follows') return followView === 'reservations' ? reservationPager : followPager;
    if (isLibraryPage()) return libraryPager;
    return null;
  }
  function queueTailCheck() {
    clearTimeout(tailTimer); tailTimer = setTimeout(checkListTail, 80);
  }
  function checkListTail() {
    var pager = visiblePager();
    if (!pager || !pager.loaded || pager.busy || pager.error || !pager.hasMore()) return;
    var cards = pager.container.querySelectorAll(pager.selector);
    var last = cards[cards.length - 1];
    if (!last) { pager.load(); return; }
    var bottom = discussionOpen ? document.getElementById('discussion-scroll').getBoundingClientRect().bottom : mainSurface.getBoundingClientRect().bottom;
    var page = pager.container.closest('.page-workspace');
    if (page) bottom = Math.min(bottom, page.getBoundingClientRect().bottom);
    if (last.getBoundingClientRect().bottom < bottom + 280) pager.load();
  }
  function listBoundary(pager, current, direction, focusAnchor) {
    focusAnchor = focusAnchor || current;
    if (pager.error) return firstVisible('#' + pager.statusID + ' .list-retry');
    if (pager.hasMore()) {
      var generation = pager.generation; var mode = pageMode();
      pager.load().then(function () {
        if (generation !== pager.generation || pageMode() !== mode || focusAnchor !== document.activeElement) return;
        var target = moveGrid(pager.selector, current, direction);
        if (target) goFocus(target);
        else if (pager.error) goFocus(firstVisible('#' + pager.statusID + ' .list-retry'));
      });
    }
    return null;
  }

  function playbackSnapshot() {
    return activePlayback && activePlayback.vid ? { series_id: activePlayback.item.series_id, vid: activePlayback.vid, episode: activePlayback.episode } : null;
  }
  function draftKey(session) { return session ? session.series_id + ':' + session.vid : ''; }
  function storeDraft(drafts, key, value) {
    if (value.trim()) drafts[key] = value; else delete drafts[key];
    var keys = Object.keys(drafts); while (keys.length > 20) delete drafts[keys.shift()];
  }
  function writePlayerAction(body, signal) {
    return fetchData('/api/v1/player/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal });
  }
  function needPlayerLogin(message) {
    if (accountData && accountData.logged_in) return false;
    message.textContent = uiText('content.loginRequired', '请先到“我的 / 登录”登录红果账号'); return true;
  }
  function discussionAction(text, focus, operation) {
    var button = document.createElement('button'); button.className = 'discussion-action'; button.textContent = text; button.dataset.focus = focus;
    button.addEventListener('click', function (event) { event.stopPropagation(); operation(button); }); return button;
  }
  function commentAge(created) {
    var elapsed = Math.max(0, Date.now() / 1000 - created);
    return !created ? '' : elapsed < 60 ? uiText('common.justNow', '刚刚') : elapsed < 3600 ? uiText('common.minuteAgo', '{value}分钟前', { value: Math.floor(elapsed / 60) }) : elapsed < 86400 ? uiText('common.hourAgo', '{value}小时前', { value: Math.floor(elapsed / 3600) }) : uiText('common.dayAgo', '{value}天前', { value: Math.floor(elapsed / 86400) });
  }
  function renderDiscussion(items, append) {
    var list = document.getElementById('discussion-list');
    if (!append) list.innerHTML = '';
    if (items.length) list.querySelectorAll('.list-empty').forEach(function (node) { node.remove(); });
    if (!items.length && !list.children.length) renderMessage(list, 'list-empty', uiText('content.noComments', '本集暂无评论'));
    items.forEach(function (item) {
      var row = document.createElement('div'); row.className = 'discussion-item'; row.tabIndex = 0; row.dataset.focus = 'comment-' + item.comment_id; row.__item = item;
      var main = document.createElement('div'); main.className = 'discussion-main';
      var avatar = document.createElement('img'); avatar.className = 'discussion-avatar'; avatar.alt = ''; avatar.referrerPolicy = 'no-referrer';
      if (/^https?:\/\//.test(item.avatar || '')) avatar.src = item.avatar;
      avatar.addEventListener('error', function () { avatar.removeAttribute('src'); });
      var content = document.createElement('div'); content.className = 'discussion-copy';
      var author = document.createElement('strong'); author.textContent = item.author || uiText('content.user', '红果用户');
      var copy = document.createElement('p'); copy.textContent = item.text;
      var meta = document.createElement('small'); meta.textContent = commentAge(item.created);
      var actions = document.createElement('div'); actions.className = 'discussion-actions';
      actions.appendChild(discussionAction(uiText('content.reply', '回复'), 'reply-' + item.comment_id, function () { selectDiscussionReply(item); }));
      if (item.replies) actions.appendChild(discussionAction(uiText('content.expandReplies', '展开 {count} 条回复', { count: item.replies }), 'expand-' + item.comment_id, function (button) { toggleReplies(row, button); }));
      if (item.own) actions.appendChild(discussionAction(uiText('content.delete', '删除'), 'delete-' + item.comment_id, function (button) { confirmDeleteComment(row, button); }));
      var like = discussionAction('', 'comment-like-' + item.comment_id, function (button) { likeComment(row, button); }); like.classList.add('discussion-like');
      like.innerHTML = '<svg><use href="#icon-favorite" xlink:href="#icon-favorite"></use></svg><small></small>';
      like.setAttribute('aria-pressed', String(!!item.liked)); like.setAttribute('aria-label', uiText('content.commentLike', '评论点赞')); like.querySelector('small').textContent = item.likes || 0;
      content.appendChild(author); content.appendChild(copy); content.appendChild(meta); content.appendChild(actions); main.appendChild(avatar); main.appendChild(content); main.appendChild(like); row.appendChild(main);
      var replies = document.createElement('div'); replies.className = 'discussion-replies is-hidden'; row.appendChild(replies);
      row.addEventListener('focus', function () { main.scrollIntoView({ block: 'nearest' }); }); list.appendChild(row);
    });
  }
  function likeComment(row, button) {
    if (button.getAttribute('aria-busy') === 'true' || needPlayerLogin(document.getElementById('discussion-message'))) return;
    var epoch = discussionEpoch; var item = row.__item; var value = !item.liked;
    button.setAttribute('aria-busy', 'true');
    writePlayerAction(Object.assign({ series_id: discussionSession.series_id, vid: discussionSession.vid }, { action: 'comment-like', comment_id: item.comment_id, value: value })).then(function () {
      if (epoch !== discussionEpoch) return;
      item.liked = value; item.likes = Math.max(0, (item.likes || 0) + (value ? 1 : -1));
      button.setAttribute('aria-pressed', String(value)); button.querySelector('small').textContent = item.likes;
    }).catch(function (error) { if (epoch === discussionEpoch) document.getElementById('discussion-message').textContent = localizedError(error, 'common.operationFailed', '操作未完成，请重试。'); })
      .then(function () { button.removeAttribute('aria-busy'); });
  }
  function confirmDeleteComment(row, button) {
    if (needPlayerLogin(document.getElementById('discussion-message'))) return;
    confirmOpen = true; confirmReturnFocus = button; ++confirmationGeneration;
    document.getElementById('confirm-title').textContent = uiText('content.deleteCommentTitle', '删除这条评论？');
    document.getElementById('confirm-copy').textContent = uiText('content.deleteCommentCopy', '会从红果账号的评论中删除，删除后无法恢复。');
    document.getElementById('confirm-accept').textContent = uiText('content.delete', '删除');
    document.getElementById('confirm-modal').classList.remove('is-hidden');
    document.getElementById('confirm-modal').setAttribute('aria-hidden', 'false');
    var session = { series_id: discussionSession.series_id, vid: discussionSession.vid }; var epoch = discussionEpoch;
    confirmOperation = function () {
      if (epoch !== discussionEpoch) return Promise.resolve(true);
      return writePlayerAction(Object.assign(session, { action: 'comment-delete', comment_id: row.__item.comment_id })).then(function () {
        if (epoch !== discussionEpoch) return true;
        var next = row.nextElementSibling || row.previousElementSibling;
        if (row.__replyPager) row.__replyPager.cancel();
        row.remove(); confirmReturnFocus = next && next.classList.contains('discussion-item') ? next : document.getElementById('discussion-input');
        return true;
      }).catch(function (error) { if (epoch === discussionEpoch) document.getElementById('confirm-copy').textContent = localizedError(error, 'common.operationFailed', '操作未完成，请重试。'); return false; });
    };
    goFocus(document.getElementById('confirm-cancel'));
  }
  function selectDiscussionReply(item) {
    discussionReplyTarget = item || null;
    var target = document.getElementById('discussion-target'); target.classList.toggle('is-hidden', !item); target.textContent = item ? uiText('content.replyTo', '回复 {name}', { name: item.author || uiText('content.user', '红果用户') }) : '';
    document.getElementById('discussion-cancel-reply').classList.toggle('is-hidden', !item);
    if (item) goFocus(document.getElementById('discussion-input'));
  }
  function toggleReplies(row, button) {
    var panel = row.querySelector('.discussion-replies'); var item = row.__item;
    var opening = panel.classList.contains('is-hidden'); panel.classList.toggle('is-hidden', !opening); button.textContent = opening ? uiText('content.collapseReplies', '收起回复') : uiText('content.expandReplies', '展开 {count} 条回复', { count: item.replies });
    if (!opening) { if (row.__replyPager) row.__replyPager.cancel(); return; }
    if (!row.__replyPager) {
      var list = document.createElement('div'); panel.appendChild(list);
      var statusNode = document.createElement('div'); statusNode.className = 'list-status'; statusNode.id = 'replies-status-' + item.comment_id; panel.appendChild(statusNode);
      var pager = HongguoPagination.create({ key: function (reply) { return reply.comment_id; }, cursor: function (data) { return data.next_cursor ? { cursor: data.next_cursor } : {}; },
        request: function (params, signal) { return fetchData('/api/v1/replies?' + new URLSearchParams(params), signal ? { signal: signal } : {}); },
        clear: function () { renderMessage(list, 'list-empty', uiText('content.readingReplies', '正在读取回复…')); },
        render: function (replies, append) {
          if (!append) list.innerHTML = '';
          if (!replies.length && !list.children.length) renderMessage(list, 'list-empty', uiText('content.noReplies', '暂无回复'));
          replies.forEach(function (reply) { var node = document.createElement('div'); node.className = 'discussion-reply'; node.tabIndex = 0; node.dataset.focus = 'reply-row-' + reply.comment_id; var name = document.createElement('strong'); name.textContent = reply.author || uiText('content.user', '红果用户'); var text = document.createElement('p'); text.textContent = reply.text; node.appendChild(name); node.appendChild(text); node.addEventListener('focus', function () { node.scrollIntoView({ block: 'nearest' }); }); list.appendChild(node); });
        }, status: function (p) { listStatus(p, statusNode.id); }, after: queueTailCheck });
      pager.container = list; pager.selector = '.discussion-reply'; pager.statusID = statusNode.id; row.__replyPager = pager; replyPagers.push(pager);
      pager.reset(Object.assign({}, discussionSession, { comment_id: item.comment_id }));
    } else if (!row.__replyPager.loaded) row.__replyPager.load(!!row.__replyPager.error);
    queueTailCheck();
  }
  function sendDiscussion() {
    var input = document.getElementById('discussion-input'); var message = document.getElementById('discussion-message');
    if (discussionBusy || !discussionSession || needPlayerLogin(message)) return;
    var text = input.value.trim(); if (!text || Array.from(text).length > 500) { message.textContent = uiText('content.commentLength', '请输入 1～500 字的内容'); goFocus(input); return; }
    var epoch = discussionEpoch; var target = discussionReplyTarget;
    var body = Object.assign({}, discussionSession, { action: target ? 'reply' : 'comment', text: text }); delete body.episode;
    if (target) body.comment_id = target.comment_id;
    discussionBusy = true; input.readOnly = true; message.textContent = uiText('common.submitting', '正在发送…'); document.getElementById('discussion-send').setAttribute('aria-busy', 'true');
    discussionRequest = typeof AbortController === 'function' ? new AbortController() : null;
    writePlayerAction(body, discussionRequest && discussionRequest.signal).then(function () {
      if (epoch !== discussionEpoch) return;
      input.value = ''; delete discussionDrafts[draftKey(discussionSession)]; selectDiscussionReply(null);
      message.textContent = uiText('common.submitted', '已发送，审核通过后显示');
      goFocus(input);
    }).catch(function (error) { if (epoch === discussionEpoch && error.name !== 'AbortError') message.textContent = localizedError(error, 'common.operationFailed', '操作未完成，请重试。'); })
      .then(function () { if (epoch === discussionEpoch) { discussionBusy = false; discussionRequest = null; input.readOnly = false; document.getElementById('discussion-send').removeAttribute('aria-busy'); } });
  }
  function openDiscussion(button) {
    var session = playbackSnapshot();
    if (!session) { showNotice(uiText('content.commentStarted', '开始播放后可查看本集评论')); return; }
    closePlayerOptions(false); clearTimeout(controlsTimer); discussionOpen = true; discussionReturn = button; discussionSession = session; ++discussionEpoch;
    shell.classList.add('is-discussion-open');
    var panel = document.getElementById('discussion-panel'); panel.classList.remove('is-hidden'); panel.setAttribute('aria-hidden', 'false');
    document.getElementById('discussion-title').textContent = uiText('content.commentCount', '第{episode}集评论 · {count}', { episode: session.episode, count: 0 }).replace(/ · 0$/, '');
    document.getElementById('discussion-input').value = discussionDrafts[draftKey(session)] || ''; document.getElementById('discussion-message').textContent = ''; selectDiscussionReply(null);
    discussionPager.reset({ series_id: session.series_id, vid: session.vid });
    goFocus(document.getElementById('discussion-close'));
  }
  function closeDiscussion(restore) {
    if (!discussionOpen) return;
    if (discussionSession) storeDraft(discussionDrafts, draftKey(discussionSession), document.getElementById('discussion-input').value);
    ++discussionEpoch; if (discussionRequest) discussionRequest.abort(); discussionRequest = null; discussionBusy = false; discussionSession = null;
    document.getElementById('discussion-input').readOnly = false; document.getElementById('discussion-send').removeAttribute('aria-busy');
    replyPagers.forEach(function (pager) { pager.cancel(); }); replyPagers = [];
    discussionOpen = false; discussionPager.cancel(); shell.classList.remove('is-discussion-open');
    document.getElementById('discussion-panel').classList.add('is-hidden'); document.getElementById('discussion-panel').setAttribute('aria-hidden', 'true');
    if (restore !== false) { goFocus(discussionReturn || document.getElementById('hero-feed-focus')); scheduleControlsHide(); }
    discussionReturn = null;
  }
  function moveDiscussion(current, direction) {
    var input = document.getElementById('discussion-input'); var close = document.getElementById('discussion-close');
    var rows = focusables('.discussion-item,.discussion-reply');
    if (current.id === 'discussion-close') return direction === 'down' ? rows[0] || firstVisible('#discussion-pagination .list-retry') || input : null;
    if (current === input) return direction === 'up' ? rows[rows.length - 1] || close : direction === 'down' ? document.getElementById('discussion-send') : null;
    if (current.closest('.discussion-compose-actions')) {
      var composeActions = focusables('.discussion-compose-actions .discussion-action');
      return direction === 'up' ? input : direction === 'left' || direction === 'right' ? composeActions[composeActions.indexOf(current) + (direction === 'right' ? 1 : -1)] || null : null;
    }
    if (current.classList.contains('list-retry')) return direction === 'down' ? input : rows[rows.length - 1] || close;
    var root = current.closest('.discussion-item');
    var row = current.closest('.discussion-reply') || root;
    if (!row) return input;
    if (direction === 'left' || direction === 'right') {
      if (current === row) return direction === 'right' && root ? root.querySelector('.discussion-like') : close;
      var actions = focusables('.discussion-like,.discussion-actions .discussion-action').filter(function (node) { return node.closest('.discussion-item') === root; });
      actions.sort(function (a, b) { return a.classList.contains('discussion-like') ? -1 : b.classList.contains('discussion-like') ? 1 : 0; });
      return actions[actions.indexOf(current) + (direction === 'right' ? 1 : -1)] || (direction === 'left' ? row : null);
    }
    if (direction === 'up' && current !== row) return row;
    var index = rows.indexOf(row); var next = rows[index + (direction === 'down' ? 1 : -1)];
    var pager = root && root.__replyPager && row.classList.contains('discussion-reply') ? root.__replyPager : discussionPager;
    if (direction === 'down' && root && root.__replyPager && root.__replyPager.hasMore() && row.classList.contains('discussion-reply') && (!next || !root.contains(next))) {
      loadDiscussionTail(root.__replyPager, row, current); return null;
    }
    if (next) return next;
    if (direction === 'up') return close;
    if (pager.error) return firstVisible('#' + pager.statusID + ' .list-retry') || input;
    if (pager.hasMore()) { loadDiscussionTail(pager, row, current); return null; }
    return input;
  }
  function loadDiscussionTail(pager, row, anchor) {
    var epoch = discussionEpoch; var generation = pager.generation;
    pager.load().then(function () {
      if (epoch !== discussionEpoch || generation !== pager.generation || document.activeElement !== anchor) return;
      if (pager.error) { goFocus(firstVisible('#' + pager.statusID + ' .list-retry')); return; }
      var rows = focusables('.discussion-item,.discussion-reply'); goFocus(rows[rows.indexOf(row) + 1] || document.getElementById('discussion-input'));
    });
  }
  function resetDanmaku() {
    ++danmakuGeneration; if (danmakuRequest) danmakuRequest.abort(); danmakuRequest = null;
    danmakuRows = []; danmakuWindow = -1; danmakuBusy = false; danmakuLast = -1;
    document.getElementById('danmaku-layer').innerHTML = '';
  }
  function toggleDanmaku() {
    danmakuEnabled = !danmakuEnabled; resetDanmaku();
    playbackPreferences.danmaku = danmakuEnabled; savePlaybackPreferences(); updateDanmakuButton(); tickDanmaku();
  }
  function updateDanmakuButton() {
    var button = document.querySelector('.playback-buttons [data-action="danmaku"]');
    if (!button) return;
    var label = danmakuEnabled ? uiText('ui.danmakuOpen', '弹幕开') : uiText('ui.danmakuClosed', '弹幕关');
    var icon = danmakuEnabled ? 'icon-danmaku' : 'icon-danmaku-off';
    button.setAttribute('aria-pressed', String(danmakuEnabled));
    button.setAttribute('aria-label', danmakuEnabled ? uiText('ui.danmakuEnabled', '弹幕已开启') : uiText('ui.danmakuDisabled', '弹幕已关闭'));
    button.querySelector('.control-label').textContent = label;
    var use = button.querySelector('use');
    use.setAttribute('href', '#' + icon);
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + icon);
  }
  function tickDanmaku() {
    var video = document.getElementById('hero-video');
    if (!danmakuEnabled || !activePlayback || !activePlayback.vid || video.paused || !isPlaybackPage() || applicationHidden() || applicationInBackground) return;
    var now = Math.floor(video.currentTime * 1000); var windowStart = Math.floor(now / 30000) * 30000;
    if (danmakuWindow !== windowStart && !danmakuBusy) {
      danmakuWindow = windowStart; danmakuBusy = true; danmakuRows = [];
      var generation = danmakuGeneration;
      danmakuRequest = typeof AbortController === 'function' ? new AbortController() : null;
      var params = new URLSearchParams({ series_id: activePlayback.item.series_id, vid: activePlayback.vid, start: String(windowStart), duration: String(Math.max(1, Math.floor((video.duration || 600) * 1000))) });
      fetchData('/api/v1/danmaku?' + params, danmakuRequest ? { signal: danmakuRequest.signal } : {}).then(function (data) {
        if (generation !== danmakuGeneration) return;
        danmakuRows = (data.items || []).filter(function (item) { return item.offset_ms >= now - 1500 && item.offset_ms < windowStart + 30000; });
      }).catch(function (error) { if (generation === danmakuGeneration && error.name !== 'AbortError') showNotice(uiText('ui.danmakuUnavailable', '弹幕暂时不可用，可关闭后重试')); })
        .then(function () { if (generation === danmakuGeneration) { danmakuBusy = false; danmakuRequest = null; } });
    }
    var layer = document.getElementById('danmaku-layer'); var last = danmakuLast;
    danmakuRows.forEach(function (item) {
      if (item.shown || item.offset_ms > now || now - last < 700 || layer.children.length >= 8) return;
      item.shown = true; last = now; danmakuLast = now;
      if (item.offset_ms < now - 2000) return;
      var line = document.createElement('span'); line.className = 'danmaku-line'; line.textContent = item.text.slice(0, 120); line.style.top = (danmakuLane++ % 4) * 38 + 'px';
      line.addEventListener('animationend', function () { line.remove(); }); layer.appendChild(line);
    });
  }

  function pageMode() {
    return shell && shell.dataset.mode ? shell.dataset.mode : 'recommend';
  }

  // The recommendation page can autoplay a video without switching the
  // shell into the dedicated player page. Only expose the native menu key
  // after that autoplay has a real media source, so a plain recommendation
  // list never consumes the remote's menu button.
  function playbackCommandMenuAvailable() {
    if (pageMode() === 'player') return true;
    if (pageMode() !== 'recommend' || !activePlayback || !activePlayback.vid) return false;
    var video = document.getElementById('hero-video');
    return !!(video && video.getAttribute('src'));
  }

  function syncNativePlaybackPageState() {
    if (!androidShell || !window.HongguoTVInput || typeof window.HongguoTVInput.setPlaybackPageActive !== 'function') return;
    window.HongguoTVInput.setPlaybackPageActive(playbackCommandMenuAvailable());
  }

  function playbackCommandMenuSeasonButton() {
    return document.getElementById('player-menu-seasons');
  }

  function syncPlaybackDrawerLayout() {
    var open = playbackCommandMenuOpen || pageMode() === 'player' && (detailModalOpen || playbackDetailReturnToMenu);
    mainSurface.classList.toggle('has-playback-drawer', open);
    if (!isPlaybackPage()) return;
    syncNativePlayerBounds();
    if (window.requestAnimationFrame) window.requestAnimationFrame(syncNativePlayerBounds);
    setTimeout(syncNativePlayerBounds, 140);
  }

  function updatePlaybackCommandMenu() {
    if (!playbackCommandMenu) return;
    var item = activePlayback && activePlayback.item || featuredItem || currentDetail;
    var episodeButton = document.getElementById('player-menu-episodes');
    var episodeLabel = uiText('modal.selectEpisode', '选集');
    var episodeCount = Number(item && item.episode_count) || 0;
    if (episodeCount > 0) episodeLabel += ' · ' + uiText('content.episodeCount', '全{count}集', { count: episodeCount });
    if (episodeButton) {
      var episodeText = episodeButton.querySelector('.playback-command-label');
      if (episodeText) { episodeText.removeAttribute('data-i18n'); episodeText.textContent = episodeLabel; }
      episodeButton.removeAttribute('data-i18n-aria-label');
      episodeButton.setAttribute('aria-label', episodeLabel);
    }
    var seasonButton = playbackCommandMenuSeasonButton();
    var existingSeasonButton = document.querySelector('[data-action="seasons"]');
    var showSeasons = !!(existingSeasonButton && !existingSeasonButton.classList.contains('is-hidden'));
    if (seasonButton) {
      seasonButton.classList.toggle('is-hidden', !showSeasons);
      var seasonText = seasonButton.querySelector('.playback-command-label');
      var seasonCatalog = item && seasonCatalogCache[item.series_id];
      var seasonCount = seasonCatalog && Array.isArray(seasonCatalog.items) ? seasonCatalog.items.length : 0;
      var seasonLabel = seasonCount ? uiText('ui.selectSeasonCount', '选季 · {count} 季', { count: seasonCount }) : uiText('ui.selectSeason', '选季');
      if (seasonText) { seasonText.removeAttribute('data-i18n'); seasonText.textContent = seasonLabel; }
      seasonButton.removeAttribute('data-i18n-aria-label');
      seasonButton.setAttribute('aria-label', seasonLabel);
      if (!showSeasons && playbackCommandMenuOpen && (document.activeElement === seasonButton || seasonButton.classList.contains('is-focused'))) goFocus(document.getElementById('player-menu-episodes'));
    }
    var fullscreenButton = document.getElementById('player-menu-fullscreen');
    if (fullscreenButton) {
      var full = shell.classList.contains('is-cinema');
      var key = full ? 'ui.exitFullscreen' : 'ui.fullscreen';
      var label = fullscreenButton.querySelector('.playback-command-label');
      var icon = full ? 'icon-fullscreen-exit' : 'icon-fullscreen';
      if (label) {
        label.removeAttribute('data-i18n');
        label.dataset.i18n = key;
        label.textContent = uiText(key, full ? '退出全屏' : '全屏');
      }
      fullscreenButton.setAttribute('data-i18n-aria-label', key);
      fullscreenButton.setAttribute('aria-label', uiText(key, full ? '退出全屏' : '全屏'));
      var use = fullscreenButton.querySelector('use');
      if (use) {
        use.setAttribute('href', '#' + icon);
        use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + icon);
      }
    }
  }

  function closePlaybackCommandMenu(restoreFocus) {
    if (!playbackCommandMenuOpen) return false;
    playbackCommandMenuOpen = false;
    if (playbackCommandMenu) {
      playbackCommandMenu.classList.add('is-hidden');
      playbackCommandMenu.setAttribute('aria-hidden', 'true');
    }
    syncPlaybackDrawerLayout();
    clearTimeout(controlsTimer);
    var target = playbackCommandMenuReturnFocus;
    playbackCommandMenuReturnFocus = null;
    if (restoreFocus !== false) {
      if (!target || !document.contains(target) || target.disabled || !target.getClientRects().length || focusables().indexOf(target) < 0) target = document.getElementById('hero-feed-focus');
      goFocus(target);
      scheduleControlsHide();
    }
    return true;
  }

  function openPlaybackCommandMenu(focusAction, preserveReturnFocus) {
    if (!playbackCommandMenuAvailable() || !playbackCommandMenu || detailModalOpen || confirmOpen || discussionOpen || supportModalOpen || rankFilterOpen || detailCastOpen || playerOptionsOpen || scanModalOpen() || (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) || (endRecommendations && endRecommendations.isOpen())) return false;
    if (playbackCommandMenuOpen) return true;
    if (!preserveReturnFocus) {
      playbackCommandMenuReturnFocus = remoteFocusTarget() || document.activeElement;
      if (!playbackCommandMenuReturnFocus || focusables().indexOf(playbackCommandMenuReturnFocus) < 0) playbackCommandMenuReturnFocus = document.getElementById('hero-feed-focus');
    }
    updatePlaybackCommandMenu();
    playbackCommandMenuOpen = true;
    playbackCommandMenu.classList.remove('is-hidden');
    playbackCommandMenu.setAttribute('aria-hidden', 'false');
    syncPlaybackDrawerLayout();
    clearTimeout(controlsTimer);
    var target = focusAction && document.getElementById(focusAction);
    if (!target || target.classList.contains('is-hidden')) target = document.getElementById('player-menu-episodes');
    goFocus(target && !target.classList.contains('is-hidden') ? target : firstVisible('.playback-command-action'));
    return true;
  }

  function togglePlaybackCommandMenu() {
    var existingHint = document.getElementById('playback-menu-hint');
    if (existingHint && !existingHint.classList.contains('is-hidden') && typeof closePlaybackMenuHint === 'function') closePlaybackMenuHint();
    return playbackCommandMenuOpen ? closePlaybackCommandMenu(true) : openPlaybackCommandMenu();
  }

  function handlePlaybackCommandMenuKey(key, repeat) {
    var current = remoteFocusTarget() || document.activeElement;
    if (key === 'Escape' || key === 'Backspace') { if (!repeat) closePlaybackCommandMenu(true); return true; }
    if (key === 'Enter') {
      if (!repeat && current && typeof current.click === 'function') current.click();
      return true;
    }
    var direction = ({ ArrowUp: 'up', ArrowDown: 'down' })[key];
    if (key === 'ArrowLeft' || key === 'ArrowRight') return true;
    if (direction && !repeat) {
      var target = moveWithinZone('playbackCommandMenu', current, direction);
      if (target) goFocus(target);
      return true;
    }
    return !!direction;
  }

  function scanModalOpen() { return searchScanOpen || danmakuScanOpen; }

  function focusables(selector) {
    var result = [];
    var query = selector || Object.keys(zoneSelectors).map(function (zone) { return zoneSelectors[zone]; }).join(',');
    Array.prototype.forEach.call(document.querySelectorAll(query), function (element) {
      var style = window.getComputedStyle(element);
      var insideModal = element.closest && element.closest('#detail-modal');
      if (coreConnectionModalOpen) { if (!element.closest('#core-connection-modal')) return; }
      else if (scanModalOpen()) { if (!element.closest('#search-scan-modal')) return; }
      else if (accountCountryModalOpen) { if (!element.closest('#account-country-modal')) return; }
      else if (accountKeypadOpen()) { if (!element.closest('#account-keypad-modal')) return; }
      else if (supportModalOpen) { if (!element.closest('#support-modal')) return; }
      else if (rankFilterOpen) { if (!element.closest('#rank-filter-modal')) return; }
      else if (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) { if (!element.closest('#actor-works-modal')) return; }
      else if (detailCastOpen) { if (!element.closest('#detail-cast-modal')) return; }
      else if (confirmOpen) { if (!element.closest('#confirm-modal')) return; }
      else if (typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) { if (!element.closest('#playback-command-menu')) return; }
      else if (playerOptionsOpen) { if (!element.closest('#player-options')) return; }
      else if (discussionOpen) { if (!element.closest('#discussion-panel')) return; }
      else if (endRecommendations && endRecommendations.isOpen()) { if (!element.closest('#end-recommendations')) return; }
      else if (element.closest('#playback-command-menu')) return;
      else if (element.closest('#end-recommendations')) return;
      else if (element.closest('#discussion-panel')) return;
      else if (detailModalOpen ? !insideModal : insideModal) return;
      if (!element.getClientRects || !element.getClientRects().length) return;
      if (!element.disabled && style.display !== 'none' && style.visibility !== 'hidden') result.push(element);
    });
    return result;
  }

  function firstVisible(selector) {
    return focusables(selector)[0] || null;
  }

  function markFocus(element) {
    if (typeof desktopPointerFocus !== 'undefined' && desktopPointerFocus) { desktopPointerFocus.focusChanged(element); return; }
    paintFocus(element);
  }

  function remoteFocusTarget() {
    var painted = document.querySelector('.is-focused');
    if (painted && focusables().indexOf(painted) >= 0) return painted;
    var active = document.activeElement;
    if (active && focusables().indexOf(active) >= 0) return active;
    var remembered = lastPageFocus[pageMode()];
    if (remembered && focusables().indexOf(remembered) >= 0) return remembered;
    return null;
  }

  function paintFocus(element) {
    document.querySelectorAll('.is-focused').forEach(function (node) { node.classList.remove('is-focused'); });
    if (element) element.classList.add('is-focused');
  }

  function revealSidebarFocus(element) {
    var node = element && element.parentElement;
    while (node) {
      var style = window.getComputedStyle(node);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        var bounds = node.getBoundingClientRect();
        var portTop = bounds.top + (node.clientTop || 0) + 6;
        var portBottom = bounds.top + (node.clientTop || 0) + node.clientHeight - 6;
        var rect = element.getBoundingClientRect();
        if (rect.top < portTop) node.scrollTop = Math.max(0, node.scrollTop - (portTop - rect.top));
        else if (rect.bottom > portBottom) node.scrollTop += rect.bottom - portBottom;
      }
      if (node.classList && node.classList.contains('sidebar')) break;
      node = node.parentElement;
    }
  }

  function zoneOf(element) {
    if (!element) return '';
    if (element.id === 'core-connection-scroll' || element.classList.contains('core-connection-action')) return 'coreConnection';
    if (element.id === 'core-status') return 'channels';
    if (element.classList.contains('end-recommendation-card') || element.id === 'end-recommendations-close') return 'endRecommendations';
    if (element.classList.contains('search-scan-action')) return 'searchScan';
    if (element.classList.contains('search-history-action')) return 'searchHistory';
    if (element.classList.contains('search-suggestion')) return 'searchSuggestions';
    if (element.classList.contains('account-keypad-key')) return 'accountKeypad';
    if (element.classList.contains('account-country-button')) return 'accountCountry';
    if (element.classList.contains('account-country-item') || element.classList.contains('account-country-close')) return 'accountCountryItems';
    if (element.classList.contains('support-card') || element.classList.contains('support-close')) return 'support';
    if (element.classList.contains('discussion-item') || element.classList.contains('discussion-close')) return 'discussion';
    if (element.classList.contains('side-item')) return 'sidebar';
    if (element.classList.contains('channel-tab')) return 'channels';
    if (element.classList.contains('hero-feed-focus')) return 'feed';
    if (element.classList.contains('catalog-card')) return 'catalog';
    if (element.classList.contains('round-action')) return 'actions';
    if (element.id === 'control-progress') return 'timeline';
    if (element.classList.contains('control-button')) return 'controls';
    if (element.id === 'search-input') return 'searchInput';
    if (element.classList.contains('search-action')) return 'searchActions';
    if (element.classList.contains('filter-toggle')) return 'searchFilters';
    if (element.classList.contains('search-filter')) return 'searchFilters';
    if (element.classList.contains('search-result-card')) return 'searchResults';
    if (element.classList.contains('list-retry')) return 'listRetry';
    if (element.classList.contains('rank-panel')) return 'rankPanels';
    if (element.classList.contains('rank-filter-toggle')) return 'rankFilters';
    if (element.classList.contains('reservation-row')) return 'reservationItems';
    if (element.classList.contains('publication-action')) return 'publicationActions';
    if (element.classList.contains('rank-tab')) return 'rankTabs';
    if (element.classList.contains('rank-view-tab')) return 'rankViews';
    if (element.classList.contains('radar-view-tab')) return 'radarViewTabs';
    if (element.classList.contains('rank-filter-open')) return 'rankTabs';
    if (element.classList.contains('rank-subtab')) return 'rankSubnav';
    if (element.classList.contains('rank-row')) return 'rankItems';
    if (element.classList.contains('rank-row-play') || element.classList.contains('rank-row-detail') || element.classList.contains('rank-row-actor')) return 'rankActions';
    if (element.classList.contains('radar-refresh')) return 'radarRefresh';
    if (element.dataset && element.dataset.radarOfficial) return 'radarOfficialTabs';
    if (element.dataset && element.dataset.radarMetric) return 'radarGrowthMetrics';
    if (element.dataset && element.dataset.radarType) return 'radarGrowthTypes';
    if (element.classList.contains('radar-official-row')) return 'radarOfficialItems';
    if (element.classList.contains('radar-growth-row')) return 'radarGrowthItems';
    if (element.classList.contains('new-tab')) return 'newTabs';
    if (element.classList.contains('new-filter')) return 'newFilters';
    if (element.classList.contains('new-card')) return 'newItems';
    if (element.classList.contains('calendar-day')) return 'calendarDays';
    if (element.classList.contains('calendar-row')) return 'calendarItems';
    if (element.classList.contains('reservation-tab')) return 'reservationTabs';
    if (element.classList.contains('library-tab')) return 'libraryTabs';
    if (element.classList.contains('follow-tab')) return 'followTabs';
    if (element.classList.contains('library-toolbar-button')) return 'libraryActions';
    if (element.classList.contains('history-filter')) return 'historyFilters';
    if (element.classList.contains('library-card')) return 'libraryItems';
    if (element.classList.contains('library-remove')) return 'libraryRemovals';
    if (element.classList.contains('account-input')) return 'accountInputs';
    if (element.classList.contains('app-update-action')) return 'appUpdates';
    if (element.classList.contains('webos-update-notes')) return 'webosUpdateNotes';
    if (element.classList.contains('locale-action')) return 'localeActions';
    if (element.classList.contains('recommendation-direction-action')) return 'recommendationDirection';
    if (element.classList.contains('sidebar-display-action')) return 'sidebarDisplay';
    if (element.classList.contains('auto-cinema-action')) return 'autoCinema';
    if (element.classList.contains('webos-audio-action')) return 'webosAudio';
    if (element.classList.contains('episode-prefetch-action')) return 'episodePrefetch';
    if (element.classList.contains('playback-mode-action')) return 'playbackModes';
    if (element.classList.contains('account-action')) return 'accountActions';
    if (element.classList.contains('confirm-button')) return 'confirmation';
    if (element.classList.contains('playback-command-action')) return 'playbackCommandMenu';
    if (element.classList.contains('player-option') || element.id === 'player-compose-input' || element.id === 'player-diagnostics-scroll') return 'playerOptions';
    if (element.closest('#discussion-panel')) return 'discussion';
    if (element.classList.contains('detail-tab')) return 'detailTabs';
    if (element.classList.contains('review-card')) return 'detailReviews';
    if (element.classList.contains('related-card')) return 'detailRelated';
    if (element.classList.contains('rank-filter-option') || element.classList.contains('rank-filter-close') || element.classList.contains('rank-filter-apply')) return 'rankModal';
    if (element.classList.contains('actor-works-close') || element.classList.contains('actor-works-retry') || element.classList.contains('actor-work-card')) return 'actorWorks';
    if (element.classList.contains('detail-header-action') || element.id === 'detail-close') return 'detailHeaderActions';
    if (element.classList.contains('detail-cast-item') || element.id === 'detail-cast-more') return 'detailCast';
    if (element.classList.contains('detail-cast-close') || element.classList.contains('detail-cast-modal-item')) return 'detailCastModal';
    if (element.classList.contains('follow-action')) return 'followActions';
    if (element.classList.contains('follow-notification-play') || element.classList.contains('follow-notification-detail')) return 'followNotificationItems';
    if (element.classList.contains('follow-notification-action')) return 'followNotifications';
    if (element.classList.contains('follow-card')) return 'followItems';
    if (element.classList.contains('library-type-filter')) return 'libraryTypeFilters';
    if (element.classList.contains('series-row') || element.classList.contains('series-retry')) return 'seriesRows';
    if (element.classList.contains('detail-episode')) return 'episodes';
    if (element.classList.contains('modal-action')) return 'modalActions';
    if (element.classList.contains('page-placeholder-action')) return 'placeholder';
    if (element.classList.contains('primary-action')) return 'hero';
    return '';
  }

  function goFocus(element) {
    if (!element || element.disabled || !element.getClientRects().length) return;
    if (window.getComputedStyle(element).visibility !== 'visible') return;
    if (coreConnectionModalOpen && !element.closest('#core-connection-modal')) return;
    // The default scroll behavior is sufficient; old WebViews have no
    // focus-options overload.
    var previous = document.activeElement;
    if (typeof androidShell !== 'undefined' && androidShell &&
        (!previous || previous === document.body || focusables().indexOf(previous) < 0) && remoteFocusTarget()) {
      previous = remoteFocusTarget();
    }
    if (previous && previous.tagName === 'INPUT' && element.tagName !== 'INPUT' && window.HongguoTVInput) window.HongguoTVInput.finishEditing();
    element.focus();
    markFocus(element);
    if (zoneOf(element) === 'sidebar') revealSidebarFocus(element);
    // Older WebViews may focus an action without scrolling its workspace.
    if ((pageMode() === 'account' || pageMode() === 'settings') && element.closest &&
        element.closest(pageMode() === 'settings' ? '#settings-page' : '#account-page')) {
      // Keep settings choices and their status above the viewport edge,
      // including old WebViews without scroll-margin support.
      var scrollTarget = element.closest('.settings-card') || element;
      try { scrollTarget.scrollIntoView(false); } catch (ignored) {}
    }
    if (accountCountryModalOpen && element.classList.contains('account-country-item')) {
      try { element.scrollIntoView(false); } catch (ignoredCountryScroll) {}
    }
    if (!scanModalOpen() && !accountCountryModalOpen && !accountKeypadOpen() && !detailModalOpen && !(typeof actorWorksOpen !== 'undefined' && actorWorksOpen) && !confirmOpen && !playerOptionsOpen && !(typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) && !discussionOpen && zoneOf(element) !== 'sidebar') {
      lastContentFocus = element;
      lastPageFocus[pageMode()] = element;
    }
  }

  function firstContentFocus() {
    if (pageMode() === 'player') return document.querySelector('.hero-feed-focus');
    // Restored recommendations are already visible; enter the channel bar
    // explicitly instead of relying on the loading placeholder.
    if (pageMode() === 'recommend') return activeChannel();
    // The rank page has a two-level entry bar. Always enter that bar first;
    // restoring a previously focused data row would hide the view switch on
    // TV remotes and make the Radar view appear unreachable.
    if (pageMode() === 'rank') return firstRankView();
    if (['favorites', 'likes'].indexOf(pageMode()) >= 0) return firstVisible('.library-tab.is-active') || firstVisible('.library-tab');
    if (pageMode() === 'follows') return firstVisible('.follow-tab.is-active') || firstVisible('.follow-tab');
    var remembered = lastPageFocus[pageMode()];
    if (remembered && focusables().indexOf(remembered) >= 0) return remembered;
    if (pageMode() === 'search') return searchInput || document.querySelector('.search-submit');
    if (pageMode() === 'account') return firstVisible('#account-method-qr[aria-pressed="true"]') || firstVisible('#account-method-phone') || firstVisible('.account-input') || firstVisible('.account-action');
    if (pageMode() === 'settings') return selectedSidebarDisplay() || selectedLocale() || firstVisible('.recommendation-direction-action[aria-pressed="true"]') || firstVisible('.recommendation-direction-action') || firstVisible('.auto-cinema-action') || firstVisible('.webos-audio-action') || firstVisible('.episode-prefetch-action[aria-pressed="true"]') || firstVisible('.episode-prefetch-action') || firstVisible('.playback-mode-action[aria-pressed="true"]') || firstVisible('.playback-mode-action') || firstVisible('.app-update-action') || activeSidebar();
    if (pageMode() === 'support') return firstVisible('.support-card');
    if (isLibraryPage()) return firstVisible('.library-card') || firstVisible('.history-filter.is-active') || firstVisible('[data-action="library-discover"]') || firstVisible('.library-toolbar-button');
    if (pageMode() === 'new') return firstVisible('.new-tab.is-active') || firstNewTab();
    if (pageMode() === 'follows') return followView === 'reservations' ? firstVisible('.reservation-tab.is-active') : followNotificationViewOpen ? firstNotificationFocus() : firstVisible('.follow-card') || firstVisible('#follow-notifications-open') || firstVisible('#follow-refresh');
    return document.querySelector('.page-placeholder-action');
  }

  function activeSidebar() {
    return document.querySelector('.side-item.is-active') || document.querySelector('.side-item');
  }

  function selectedSidebarDisplay() {
    return firstVisible('.sidebar-display-action[aria-pressed="true"]') || firstVisible('.sidebar-display-action');
  }

  function selectedLocale() {
    return firstVisible('.locale-action[aria-pressed="true"]') || firstVisible('.locale-action');
  }

  function activeChannel() {
    return document.querySelector('.channel-tab.is-active') || document.querySelector('.channel-tab');
  }

  function firstCatalog() {
    return document.querySelector('.catalog-card');
  }

  function firstSearchFilter() {
    var panel = document.getElementById('filter-panel');
    if (!panel || panel.classList.contains('is-hidden')) return null;
    return panel.classList.contains('is-collapsed') ? firstVisible('#filter-toggle') : firstVisible('.search-filter');
  }

  function firstSearchAction() {
    return firstVisible('.search-submit') || firstVisible('#search-scan');
  }

  function firstSearchResult() {
    return firstVisible('.search-result-card');
  }

  function firstRankTab() { return firstVisible('.rank-tab'); }
  function firstRankView() { return firstVisible('.rank-view-tab'); }
  function firstRadarViewTab() { return firstVisible('.radar-view-tab'); }
  function firstRadarOfficialTab() { return firstVisible('.radar-filter[data-radar-official]'); }
  function firstRadarGrowthMetric() { return firstVisible('.radar-filter[data-radar-metric]'); }
  function firstRadarGrowthType() { return firstVisible('.radar-filter[data-radar-type]'); }
  function firstRadarOfficialRow() { return firstVisible('.radar-official-row'); }
  function firstRadarGrowthRow() { return firstVisible('.radar-growth-row'); }
  function firstRankSubtab() { return firstVisible('.rank-subtab'); }
  function firstRankFilterToggle() { return firstVisible('#rank-filter-toggle'); }
  function firstRankFilterEntry() {
    return firstVisible('.rank-panel') || firstRankFilterToggle() || firstVisible('.rank-subtab.is-active') || firstRankTab();
  }
  function firstRankRow() { return firstVisible('.rank-row'); }
  function firstNewTab() { return firstVisible('.new-tab'); }
  function firstNewFilter() { return firstVisible('.new-filter'); }
  function firstNewCard() { return firstVisible('.new-card'); }
  function firstCalendarDay() { return firstVisible('.calendar-day.is-active') || firstVisible('.calendar-day'); }
  function firstCalendarRow() { return firstVisible('.calendar-row'); }

  function hideWorkspacePages() {
    [rankPage, newPage, followPage, libraryPage, accountPage, settingsPage, supportPage].forEach(function (page) {
      if (page) page.classList.add('is-hidden');
    });
  }

  function moveSearchFilter(current, direction) {
    if (current && current.id === 'filter-toggle') {
      if (direction === 'up') return firstSearchAction() || searchInput;
      if (direction === 'down') return document.getElementById('filter-panel').classList.contains('is-collapsed') ? firstSearchResult() || firstVisible('#search-pagination .list-retry') : firstVisible('.search-filter');
      if (direction === 'left') return activeSidebar();
      return null;
    }
    var row = current && current.closest ? current.closest('.filter-row') : null;
    if (!row) return null;
    var items = focusables('.filter-row[data-filter-group="' + row.dataset.filterGroup + '"] .search-filter');
    if (direction === 'left' || direction === 'right') {
      var index = items.indexOf(current);
      if (index < 0) return items[0] || null;
      index += direction === 'left' ? -1 : 1;
      return items[index] || (direction === 'left' ? activeSidebar() : null);
    }
    var rows = [];
    document.querySelectorAll('.filter-row[data-filter-group]').forEach(function (node) { rows.push(node); });
    var rowIndex = rows.indexOf(row);
    var targetRowIndex = rowIndex + (direction === 'up' ? -1 : 1);
    if (targetRowIndex < 0) return firstVisible('#filter-toggle') || firstVisible('.search-history-action') || firstSearchAction() || searchInput;
    if (targetRowIndex >= rows.length) return firstSearchResult() || firstVisible('.search-more') || firstVisible('#search-pagination .list-retry');
    var targetItems = focusables('.filter-row[data-filter-group="' + rows[targetRowIndex].dataset.filterGroup + '"] .search-filter');
    if (!targetItems.length) return null;
    var currentRect = current.getBoundingClientRect();
    var best = targetItems[0];
    var bestDistance = Infinity;
    targetItems.forEach(function (node) {
      var distance = Math.abs(node.getBoundingClientRect().left - currentRect.left);
      if (distance < bestDistance) { bestDistance = distance; best = node; }
    });
    return best;
  }

  function moveWithinZone(zone, current, direction) {
    var items = focusables(zoneSelectors[zone]);
    var index = items.indexOf(current);
    if (index < 0) return items[0] || null;
    if (direction === 'up' || direction === 'left') index -= 1;
    if (direction === 'down' || direction === 'right') index += 1;
    return items[index] || null;
  }

  function moveGrid(selector, current, direction) {
    var currentRect = current && current.getBoundingClientRect ? current.getBoundingClientRect() : null;
    if (!currentRect) return null;
    var candidates = focusables(selector).filter(function (node) { return node !== current; });
    var currentX = currentRect.left + currentRect.width / 2;
    var currentY = currentRect.top + currentRect.height / 2;
    var vertical = direction === 'up' || direction === 'down';
    var best = null;
    var bestScore = Infinity;
    candidates.forEach(function (node) {
      var rect = node.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      var rowDelta = direction === 'down' ? y - currentY : currentY - y;
      if (vertical && rowDelta <= 16) return;
      if (!vertical) {
        if (Math.abs(y - currentY) > 16) return;
        var columnDelta = direction === 'right' ? x - currentX : currentX - x;
        if (columnDelta > 8 && columnDelta < bestScore) { bestScore = columnDelta; best = node; }
        return;
      }
      var horizontal = Math.abs(x - currentX);
      var score = rowDelta * 100 + horizontal;
      if (score < bestScore) { bestScore = score; best = node; }
    });
    return best;
  }

  function moveModalFrom(current, direction) {
    var zone = zoneOf(current);
    if (zone === 'rankModal') {
      if (direction === 'left' || direction === 'right') return moveWithinZone('rankModal', current, direction);
      if (direction === 'up' || direction === 'down') return moveWithinZone('rankModal', current, direction);
      return null;
    }
    if (zone === 'actorWorks') {
      if (current.classList.contains('actor-works-close') || current.classList.contains('actor-works-retry')) {
        return direction === 'down' ? firstVisible('.actor-work-card') : (direction === 'right' ? firstVisible('.actor-work-card') : null);
      }
      if (direction === 'left' || direction === 'right') return moveGrid('.actor-work-card', current, direction) || (direction === 'left' ? document.getElementById('actor-works-close') : null);
      if (direction === 'up') return moveGrid('.actor-work-card', current, direction) || document.getElementById('actor-works-close');
      if (direction === 'down') return moveGrid('.actor-work-card', current, direction);
      return null;
    }
    if (zone === 'detailCastModal') {
      if (current.classList.contains('detail-cast-close')) return direction === 'down' ? firstVisible('.detail-cast-modal-item') : null;
      if (direction === 'left' || direction === 'right') return moveGrid('.detail-cast-modal-item', current, direction);
      if (direction === 'up') return moveGrid('.detail-cast-modal-item', current, direction) || document.getElementById('detail-cast-close');
      if (direction === 'down') return moveGrid('.detail-cast-modal-item', current, direction);
      return null;
    }
    if (zone === 'detailTabs') {
      if (direction === 'left' || direction === 'right') return moveWithinZone('detailTabs', current, direction);
      if (direction === 'up') return firstVisible('.detail-cast-item') || document.getElementById('detail-close');
      if (direction === 'down') return detailTab === 'series' ? currentSeriesRow() || firstVisible('.series-row') || firstVisible('.series-retry') : detailTab === 'reviews' ? firstVisible('.review-card') : detailTab === 'related' ? firstVisible('.related-card') : currentDetailEpisode() || firstVisible('#detail-retry');
      return null;
    }
    if (zone === 'detailHeaderActions') {
      if (current.id === 'detail-close') return direction === 'down' ? document.querySelector('.detail-tab.is-active') : direction === 'left' ? document.getElementById('detail-favorite') : null;
      if (direction === 'left' || direction === 'right') return moveWithinZone('detailHeaderActions', current, direction);
      if (direction === 'down') return firstVisible('.detail-cast-item') || document.querySelector('.detail-tab.is-active');
      return null;
    }
    if (zone === 'detailCast') {
      if (current.id === 'detail-cast-more') {
        if (direction === 'left') return moveGrid('.detail-cast-strip .detail-cast-item', current, direction) || firstVisible('.detail-cast-item');
        if (direction === 'down') return document.querySelector('.detail-tab.is-active');
        if (direction === 'up') return document.getElementById('detail-close');
        return null;
      }
      if (direction === 'left' || direction === 'right') return moveGrid('.detail-cast-strip .detail-cast-item', current, direction) || (direction === 'right' ? firstVisible('#detail-cast-more') : null);
      if (direction === 'up') return document.getElementById('detail-close');
      if (direction === 'down') return document.querySelector('.detail-tab.is-active');
      return null;
    }
    if (zone === 'seriesRows') {
      if (direction === 'up') return moveWithinZone('seriesRows', current, direction) || document.getElementById('detail-tab-series');
      if (direction === 'down') return moveWithinZone('seriesRows', current, direction);
      if (direction === 'left') return document.getElementById('detail-tab-series');
      return null;
    }
    if (zone === 'detailReviews' || zone === 'detailRelated') {
      var socialSelector = zone === 'detailReviews' ? '.review-card' : '.related-card';
      var socialTab = zone === 'detailReviews' ? 'reviews' : 'related';
      if (direction === 'left' || direction === 'right') return moveGrid(socialSelector, current, direction) || (direction === 'left' ? document.getElementById('detail-tab-' + socialTab) : null);
      if (direction === 'up') return moveGrid(socialSelector, current, direction) || document.getElementById('detail-tab-' + socialTab);
      if (direction === 'down') return moveGrid(socialSelector, current, direction);
      return null;
    }
    if (zone === 'modalActions') {
      if (current.id === 'detail-close') return direction === 'down' ? document.querySelector('.detail-tab.is-active') : null;
      if (direction === 'up' || direction === 'left') return document.getElementById('detail-tab-episodes');
      return null;
    }
    if (zone === 'episodes') {
      if (direction === 'left' || direction === 'right') {
        var episodeTarget = moveGrid('.detail-episode', current, direction);
        return episodeTarget || (direction === 'left' ? document.querySelector('.detail-close') : null);
      }
      if (direction === 'up') return moveGrid('.detail-episode', current, direction) || document.getElementById('detail-tab-episodes');
      if (direction === 'down') return moveGrid('.detail-episode', current, direction);
      return null;
    }
    return null;
  }

  function moveFrom(current, direction) {
    if (coreConnectionModalOpen) return moveCoreConnectionFocus(current, direction);
    if (scanModalOpen()) return direction === 'left' || direction === 'right' ? moveWithinZone('searchScan', current, direction) : null;
    if (typeof accountCountryModalOpen !== 'undefined' && accountCountryModalOpen) {
      if (current.id === 'account-country-close') return direction === 'down' ? document.querySelector('.account-country-item.is-selected') || firstVisible('.account-country-item') : null;
      if (direction === 'up') return moveWithinZone('accountCountryItems', current, direction) || document.getElementById('account-country-close');
      if (direction === 'down') return moveWithinZone('accountCountryItems', current, direction) || current;
      return null;
    }
    if (supportModalOpen) return document.getElementById('support-close');
    if (confirmOpen) return direction === 'left' || direction === 'right' ? moveWithinZone('confirmation', current, direction) : null;
    if (typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) return moveWithinZone('playbackCommandMenu', current, direction);
    if (rankFilterOpen) return moveModalFrom(current, direction);
    if (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) return moveModalFrom(current, direction);
    if (playerOptionsOpen) {
      if (document.getElementById('player-options').classList.contains('is-diagnostics')) {
        return moveDiagnosticFocus(current, direction);
      }
      if (current.id === 'player-compose-input') return direction === 'down' ? firstVisible('#player-compose-scan') || document.getElementById('player-compose-send') : direction === 'up' ? document.getElementById('player-options-close') : direction === 'right' ? document.getElementById('player-compose-send') : null;
      if (current.id === 'player-compose-scan') return direction === 'up' || direction === 'left' ? document.getElementById('player-compose-input') : direction === 'right' || direction === 'down' ? document.getElementById('player-compose-send') : null;
      if (current.id === 'player-compose-send') return direction === 'up' ? firstVisible('#player-compose-scan') || document.getElementById('player-compose-input') : direction === 'left' ? firstVisible('#player-compose-scan') || document.getElementById('player-compose-input') : null;
      if (current.id === 'player-options-close') return direction === 'down' ? firstVisible('#player-compose-input') || document.querySelector('.player-option.is-selected') || firstVisible('#player-options-list .player-option') : null;
      return moveGrid('#player-options-list .player-option', current, direction) || (direction === 'up' ? document.getElementById('player-options-close') : null);
    }
    if (detailModalOpen) { detailFocusPending = false; return moveModalFrom(current, direction); }
    if (discussionOpen) {
      return moveDiscussion(current, direction);
    }
    var zone = zoneOf(current);
    if (zone === 'accountCountry') {
      if (direction === 'right' || direction === 'down') return document.getElementById('account-phone');
      return direction === 'left' || direction === 'up' ? activeSidebar() : null;
    }
    if (zone === 'support') {
      if (direction === 'left' || direction === 'right') return moveWithinZone('support', current, direction) || (direction === 'left' ? activeSidebar() : null);
      return direction === 'up' ? activeSidebar() : null;
    }
    if (zone === 'sidebar') {
      if (direction === 'up' || direction === 'down') return moveWithinZone(zone, current, direction);
      if (direction === 'right') return firstContentFocus();
      return null;
    }
    if (zone === 'channels') {
      if (direction === 'left' || direction === 'right') {
        var channelTarget = moveWithinZone(zone, current, direction);
        return channelTarget || (direction === 'left' ? activeSidebar() : null);
      }
      if (direction === 'down') return firstVisible('.hero-feed-focus') || firstCatalog() || firstVisible('.primary-action');
      if (direction === 'up') return activeSidebar();
      return null;
    }
    if (zone === 'feed') {
      if (direction === 'left') return shell.classList.contains('is-cinema') ? firstVisible('.playback-buttons .control-button') : activeSidebar();
      if (direction === 'right') return firstVisible('.round-action') || firstVisible('.playback-buttons .control-button');
      if (direction === 'down') return firstVisible('.playback-buttons .control-button');
      if (direction === 'up') return pageMode() === 'player' ? null : activeChannel();
      return null;
    }
    if (zone === 'hero') {
      if (direction === 'right') return document.querySelector('.round-action');
      if (direction === 'down') return firstCatalog() || firstVisible('.playback-buttons .control-button');
      if (direction === 'up') return activeChannel();
      if (direction === 'left') return activeSidebar();
      return null;
    }
    if (zone === 'placeholder') {
      if (direction === 'up') return activeSidebar();
      if (direction === 'left') return activeSidebar();
      return null;
    }
    if (zone === 'catalog') {
      if (direction === 'left' || direction === 'right') {
        var cardTarget = moveWithinZone(zone, current, direction);
        return cardTarget || (direction === 'left' ? activeSidebar() : null);
      }
      if (direction === 'up') return firstVisible('.primary-action') || activeChannel();
      if (direction === 'down') return firstVisible('.playback-buttons .control-button');
      return null;
    }
    if (zone === 'actions') {
      if (direction === 'up' || direction === 'down') return moveWithinZone(zone, current, direction) || (direction === 'down' ? firstVisible('.playback-buttons [data-action="fullscreen"]') : null);
      if (direction === 'left') return firstVisible('.hero-feed-focus') || firstVisible('.primary-action') || firstCatalog();
      return null;
    }
    if (zone === 'controls') {
      if (direction === 'left' || direction === 'right') {
        var controlTarget = moveWithinZone(zone, current, direction);
        return controlTarget || (direction === 'left' ? activeSidebar() : null);
      }
      if (direction === 'up') {
        if (current.dataset.action === 'fullscreen') return firstVisible('#control-progress');
        return firstVisible('#control-progress') || firstVisible('.hero-feed-focus') || firstCatalog() || firstVisible('.primary-action');
      }
      return null;
    }
    if (zone === 'searchInput') {
      if (direction === 'up') return activeSidebar();
      // Left/right edit text; Down first enters live suggestions when present.
      if (direction === 'down') return searchSuggestionOpen ? firstVisible('.search-suggestion') : firstSearchAction();
      if (direction === 'right') return firstSearchAction();
      return null;
    }
    if (zone === 'searchSuggestions') {
      if (direction === 'up') return moveWithinZone(zone, current, direction) || searchInput;
      if (direction === 'down') return moveWithinZone(zone, current, direction);
      if (direction === 'left') return activeSidebar();
      return null;
    }
    if (zone === 'searchActions') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? searchInput : null);
      if (direction === 'up') return searchInput;
      if (direction === 'down') return firstVisible('.search-history-action') || firstSearchFilter() || firstSearchResult() || firstVisible('#search-pagination .list-retry');
      return null;
    }
    if (zone === 'searchHistory') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstSearchAction() || searchInput;
      if (direction === 'down') return firstSearchFilter() || firstSearchResult() || firstVisible('#search-page .list-retry') || firstSearchAction();
      return null;
    }
    if (zone === 'searchFilters') {
      return moveSearchFilter(current, direction);
    }
    if (zone === 'searchResults') {
      if (direction === 'left' || direction === 'right') {
        var resultTarget = moveGrid('.search-result-card', current, direction);
        return resultTarget || (direction === 'left' ? activeSidebar() : null);
      }
      if (direction === 'up') return moveGrid('.search-result-card', current, direction) || lastSearchFilter() || firstVisible('.search-history-action') || searchInput;
      if (direction === 'down') return moveGrid('.search-result-card', current, direction) || listBoundary(searchPager, current, direction);
      return null;
    }
    if (zone === 'listRetry') {
      var pager = current.__pager;
      if (direction === 'up') { var cards = focusables(pager.selector); return cards[cards.length - 1] || firstContentFocus(); }
      if (direction === 'left') return activeSidebar();
      return null;
    }
    if (zone === 'rankPanels') {
      var target = moveGrid('.rank-panel', current, direction);
      if (target) return target;
      if (direction === 'down') return firstRankRow();
      if (direction === 'up') return firstRankFilterToggle() || firstVisible('.rank-subtab.is-active') || firstVisible('.rank-tab.is-active');
      if (direction === 'left') return firstRankFilterToggle() || firstVisible('.rank-subtab.is-active');
      return null;
    }
    if (zone === 'publicationActions') {
      var row = current.closest('.publication-row');
      if (!row) return direction === 'left' || direction === 'up' ? firstVisible('.reservation-tab.is-active') : null;
      if (direction === 'left') return row;
      if (direction === 'up' || direction === 'down') {
        var reservations = row.classList.contains('reservation-row');
        var selector = reservations ? '.reservation-row' : '.calendar-row';
        return moveGrid(selector, row, direction) || (direction === 'down'
          ? listBoundary(reservations ? reservationPager : calendarPager, row, direction, current)
          : firstVisible(reservations ? '.reservation-tab.is-active' : '.calendar-day.is-active'));
      }
      return null;
    }
    if (zone === 'reservationItems') {
      if (reservationMode === 'online') {
        var target = moveGrid('.reservation-row', current, direction);
        if (target) return target;
        if (direction === 'up') return firstVisible('.reservation-tab.is-active');
        if (direction === 'down') return listBoundary(reservationPager, current, direction);
        if (direction === 'left') return activeSidebar();
        return null;
      }
      if (direction === 'up') return moveWithinZone(zone, current, direction) || firstVisible('.reservation-tab.is-active');
      if (direction === 'down') return moveWithinZone(zone, current, direction) || listBoundary(reservationPager, current, direction);
      if (direction === 'right') return current.querySelector('.publication-action');
      if (direction === 'left') return activeSidebar();
      return null;
    }
    if (zone === 'libraryActions') {
      if (current.dataset.action === 'library-discover' && direction === 'up') return firstVisible('.history-filter.is-active') || firstVisible('.library-tab.is-active') || activeSidebar();
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? firstVisible('.library-tab.is-active') || activeSidebar() : null);
      if (direction === 'down') return firstVisible('.history-filter.is-active') || firstVisible('.library-type-filter.is-active') || firstVisible('.library-card') || firstVisible('[data-action="library-discover"]');
      if (direction === 'up') return firstVisible('.history-filter.is-active') || firstVisible('.library-tab.is-active') || firstVisible('.library-card') || activeSidebar();
      return null;
    }
    if (zone === 'historyFilters') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : firstVisible('#library-manage'));
      if (direction === 'up') return firstVisible('#library-manage') || firstVisible('.library-tab.is-active') || activeSidebar();
      if (direction === 'down') return firstVisible('.library-card') || firstVisible('[data-action="library-discover"]');
      return null;
    }
    if (zone === 'libraryTypeFilters') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstVisible('.library-tab.is-active') || firstVisible('#library-manage') || activeSidebar();
      if (direction === 'down') return firstVisible('.library-card') || firstVisible('[data-action="library-discover"]');
      return null;
    }
    if (zone === 'followActions') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? firstVisible('.follow-tab.is-active') || activeSidebar() : null);
      if (direction === 'up') return firstVisible('.follow-tab.is-active') || activeSidebar();
      if (direction === 'down') return followView === 'reservations' ? firstVisible('.reservation-tab.is-active') : followNotificationViewOpen ? firstNotificationFocus() : firstVisible('.follow-card') || firstVisible('#follow-pagination .list-retry');
      return null;
    }
    if (zone === 'followNotifications') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstVisible('.follow-action') || firstVisible('.follow-tab.is-active') || activeSidebar();
      if (direction === 'down') return firstNotificationFocus() || current;
      return null;
    }
    if (zone === 'followNotificationItems') {
      var row = current.closest('.follow-notification-row');
      var rowActions = row ? focusables('.follow-notification-play, .follow-notification-detail').filter(function (node) { return node.closest('.follow-notification-row') === row; }) : [];
      if (direction === 'left' || direction === 'right') {
        var next = rowActions.indexOf(current) + (direction === 'right' ? 1 : -1);
        return rowActions[next] || (direction === 'left' && rowActions[0] === current ? activeSidebar() : null);
      }
      var actionSelector = current.classList.contains('follow-notification-play') ? '.follow-notification-play' : '.follow-notification-detail';
      if (direction === 'up') return row && moveGrid(actionSelector, current, direction) || firstVisible('#follow-notifications-back');
      if (direction === 'down') return row && moveGrid(actionSelector, current, direction) || current;
      return null;
    }
    if (zone === 'followItems') {
      if (direction === 'left' || direction === 'right') return moveGrid('.follow-card', current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return moveGrid('.follow-card', current, direction) || firstVisible('.follow-action') || firstVisible('.follow-tab.is-active') || activeSidebar();
      if (direction === 'down') return moveGrid('.follow-card', current, direction) || listBoundary(followPager, current, direction);
      return null;
    }
    if (zone === 'sidebarDisplay') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return activeSidebar();
      if (direction === 'down') return firstVisible('.locale-action[aria-pressed="true"]') || firstVisible('.locale-action') || firstVisible('.recommendation-direction-action[aria-pressed="true"]') || firstVisible('.recommendation-direction-action') || firstVisible('.auto-cinema-action') || firstVisible('.webos-audio-action') || firstVisible('.episode-prefetch-action[aria-pressed="true"]') || firstVisible('.episode-prefetch-action') || firstVisible('.playback-mode-action[aria-pressed="true"]') || firstVisible('.playback-mode-action') || firstVisible('.app-update-action');
      return null;
    }
    if (zone === 'localeActions') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return selectedSidebarDisplay() || activeSidebar();
      if (direction === 'down') return firstVisible('.recommendation-direction-action[aria-pressed="true"]') || firstVisible('.recommendation-direction-action') || firstVisible('.auto-cinema-action') || firstVisible('.webos-audio-action') || firstVisible('.episode-prefetch-action[aria-pressed="true"]') || firstVisible('.episode-prefetch-action') || firstVisible('.playback-mode-action[aria-pressed="true"]') || firstVisible('.playback-mode-action') || firstVisible('.app-update-action');
      return null;
    }
    if (zone === 'recommendationDirection') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstVisible('.locale-action[aria-pressed="true"]') || firstVisible('.locale-action') || selectedSidebarDisplay() || activeSidebar();
      if (direction === 'down') return firstVisible('.auto-cinema-action') || firstVisible('.webos-audio-action') || firstVisible('.episode-prefetch-action[aria-pressed="true"]') || firstVisible('.episode-prefetch-action') || firstVisible('.playback-mode-action[aria-pressed="true"]') || firstVisible('.playback-mode-action') || firstVisible('.app-update-action');
      return null;
    }
    if (zone === 'appUpdates') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstVisible('.playback-mode-action[aria-pressed="true"]') || firstVisible('.playback-mode-action') || firstVisible('.episode-prefetch-action[aria-pressed="true"]') || firstVisible('.episode-prefetch-action') || firstVisible('.webos-audio-action') || firstVisible('.auto-cinema-action') || firstVisible('.recommendation-direction-action[aria-pressed="true"]') || firstVisible('.recommendation-direction-action') || firstVisible('.locale-action[aria-pressed="true"]') || firstVisible('.locale-action') || selectedSidebarDisplay() || activeSidebar();
      if (direction === 'down') return firstVisible('.webos-update-notes');
      return null;
    }
    if (zone === 'webosUpdateNotes') {
      if (direction === 'left' || direction === 'up' && current.scrollTop <= 1) return document.getElementById('app-check-update');
      if (direction === 'up' || direction === 'down') current.scrollTop += (direction === 'up' ? -1 : 1) * Math.max(80, Math.floor(current.clientHeight * 0.65));
      return current;
    }
    if (zone === 'autoCinema') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstVisible('.recommendation-direction-action[aria-pressed="true"]') || firstVisible('.recommendation-direction-action') || firstVisible('.locale-action[aria-pressed="true"]') || firstVisible('.locale-action') || selectedSidebarDisplay() || activeSidebar();
      if (direction === 'down') return firstVisible('.webos-audio-action') || firstVisible('.episode-prefetch-action[aria-pressed="true"]') || firstVisible('.episode-prefetch-action') || firstVisible('.playback-mode-action[aria-pressed="true"]') || firstVisible('.playback-mode-action') || firstVisible('.app-update-action');
      return null;
    }
    if (zone === 'webosAudio') {
      if (direction === 'left') return activeSidebar();
      if (direction === 'up') return firstVisible('.auto-cinema-action') || firstVisible('.recommendation-direction-action[aria-pressed="true"]') || firstVisible('.recommendation-direction-action') || firstVisible('.locale-action[aria-pressed="true"]') || selectedSidebarDisplay() || activeSidebar();
      if (direction === 'down') return firstVisible('.episode-prefetch-action[aria-pressed="true"]') || firstVisible('.episode-prefetch-action') || firstVisible('.playback-mode-action[aria-pressed="true"]') || firstVisible('.playback-mode-action') || firstVisible('.app-update-action');
      return null;
    }
    if (zone === 'episodePrefetch') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstVisible('.webos-audio-action') || firstVisible('.auto-cinema-action') || firstVisible('.recommendation-direction-action[aria-pressed="true"]') || firstVisible('.recommendation-direction-action') || firstVisible('.locale-action[aria-pressed="true"]') || firstVisible('.locale-action') || selectedSidebarDisplay() || activeSidebar();
      if (direction === 'down') return firstVisible('.playback-mode-action[aria-pressed="true"]') || firstVisible('.playback-mode-action') || firstVisible('.app-update-action');
      return null;
    }
    if (zone === 'playbackModes') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstVisible('.episode-prefetch-action[aria-pressed="true"]') || firstVisible('.episode-prefetch-action') || firstVisible('.webos-audio-action') || firstVisible('.auto-cinema-action') || firstVisible('.recommendation-direction-action[aria-pressed="true"]') || firstVisible('.recommendation-direction-action') || firstVisible('.locale-action[aria-pressed="true"]') || firstVisible('.locale-action') || selectedSidebarDisplay() || activeSidebar();
      if (direction === 'down') return firstVisible('.app-update-action');
      return null;
    }
    if (zone === 'accountInputs' || zone === 'accountActions') {
      var qrSelected = accountLoginMethod === 'qr' && accountData && accountData.qr_login_available && !webosShell;
      if (current.id === 'account-method-phone' || current.id === 'account-method-qr') {
        if (direction === 'left') return current.id === 'account-method-phone' ? document.getElementById('account-method-qr') : activeSidebar();
        if (direction === 'right') return current.id === 'account-method-qr' ? document.getElementById('account-method-phone') : null;
        if (direction === 'down') return qrSelected ? document.getElementById('account-qr-refresh') : firstVisible('#account-country') || firstVisible('#account-phone');
        return direction === 'up' ? activeSidebar() : null;
      }
      if (current.id === 'account-qr-refresh' || current.id === 'account-qr-cancel') {
        if (direction === 'up') return document.getElementById('account-method-qr');
        if (direction === 'left') return current.id === 'account-qr-cancel' ? document.getElementById('account-qr-refresh') : activeSidebar();
        if (direction === 'right') return current.id === 'account-qr-refresh' ? document.getElementById('account-qr-cancel') : firstVisible('#account-sync');
        return null;
      }
      if (direction === 'up' && (current.id === 'account-phone' || current.id === 'account-country')) return firstVisible('#account-method-phone') || activeSidebar();
      if (current.id === 'account-sms-qr') return direction === 'down' ? firstVisible('#account-verify') || firstVisible('#account-cancel') : direction === 'left' || direction === 'up' ? activeSidebar() : null;
      if (accountData && accountData.phase === 'mfa' && direction === 'up' && (current.id === 'account-verify' || current.id === 'account-cancel')) return firstVisible('#account-sms-qr') || activeSidebar();
      var leftSelector = '#account-login-methods .account-action, #account-qr-panel .account-action, #account-login-form .account-input, #account-login-form .account-action, #account-mfa .account-action, #account-profile .account-action';
      if (current.id === 'account-sync' || current.id === 'account-import-history') {
        if (direction === 'left') return focusables(leftSelector).indexOf(accountLeftFocus) >= 0 ? accountLeftFocus : firstVisible(leftSelector) || activeSidebar();
        if (direction === 'down') return current.id === 'account-sync' ? firstVisible('#account-import-history') : null;
        if (direction === 'up') return current.id === 'account-import-history' ? firstVisible('#account-sync') || firstVisible(leftSelector) : null;
        return null;
      }
      if (zone === 'accountInputs' && direction === 'down') {
        if (current.id === 'account-phone' && firstVisible('#account-code')) return document.getElementById('account-code');
        return firstVisible('#account-login') || firstVisible('#account-send-code') || firstVisible('#account-change-phone');
      }
      if (zone === 'accountInputs' && current.id === 'account-phone' && direction === 'left') return document.getElementById('account-country');
      if (zone === 'accountActions' && direction === 'up') {
        return firstVisible('#account-code') || firstVisible('#account-phone') || moveGrid(leftSelector, current, direction);
      }
      var target = moveGrid(leftSelector, current, direction);
      if (target) return target;
      if (direction === 'right' && (firstVisible('#account-sync') || firstVisible('#account-import-history'))) { accountLeftFocus = current; return firstVisible('#account-sync') || firstVisible('#account-import-history'); }
      return direction === 'left' || direction === 'up' ? activeSidebar() : null;
    }
    if (zone === 'libraryItems') {
      if (direction === 'left' || direction === 'right') return moveGrid('.library-card', current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return moveGrid('.library-card', current, direction) || firstVisible('.history-filter.is-active') || firstVisible('.library-type-filter.is-active') || firstVisible('.library-tab.is-active') || firstVisible('.library-toolbar-button');
      if (direction === 'down') return libraryEditing ? current.parentElement.querySelector('.library-remove') : moveGrid('.library-card', current, direction) || listBoundary(libraryPager, current, direction);
      return null;
    }
    if (zone === 'libraryRemovals') {
      if (direction === 'up') return current.parentElement.querySelector('.library-card');
      if (direction === 'down') { var card = current.parentElement.querySelector('.library-card'); return moveGrid('.library-card', card, 'down') || listBoundary(libraryPager, card, 'down', current); }
      if (direction === 'left' || direction === 'right') return moveGrid('.library-remove', current, direction) || (direction === 'left' ? activeSidebar() : null);
      return null;
    }
    if (zone === 'rankTabs') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstRankView() || activeSidebar();
      if (direction === 'down') return firstVisible('.rank-subtab.is-active') || firstRankSubtab() || firstRankRow();
      return null;
    }
    if (zone === 'rankViews') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return activeSidebar();
      if (direction === 'down') return rankView === 'radar' ? firstRadarViewTab() : (firstVisible('.rank-subtab.is-active') || firstRankSubtab() || firstRankRow());
      return null;
    }
    if (zone === 'radarViewTabs') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstRankView();
      if (direction === 'down') return radarView === 'growth' ? firstRadarGrowthMetric() : firstRadarOfficialTab();
      return null;
    }
    if (zone === 'radarRefresh') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstRankView();
      if (direction === 'down') return firstRadarOfficialTab();
      return null;
    }
    if (zone === 'radarOfficialTabs') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstRadarViewTab() || firstRankView();
      if (direction === 'down') return firstRadarOfficialRow() || firstRadarGrowthMetric();
      return null;
    }
    if (zone === 'radarGrowthMetrics') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstRadarViewTab() || firstRankView();
      if (direction === 'down') return firstRadarGrowthType() || firstRadarGrowthRow();
      return null;
    }
    if (zone === 'radarGrowthTypes') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstRadarGrowthMetric();
      if (direction === 'down') return firstRadarGrowthRow();
      return null;
    }
    if (zone === 'radarOfficialItems') {
      if (direction === 'up') return moveGrid('.radar-official-row', current, direction) || firstRadarOfficialTab();
      if (direction === 'down') return moveGrid('.radar-official-row', current, direction) || current;
      if (direction === 'left') return firstRadarOfficialTab() || activeSidebar();
      return null;
    }
    if (zone === 'radarGrowthItems') {
      if (direction === 'up') return moveGrid('.radar-growth-row', current, direction) || firstRadarGrowthType() || firstRadarGrowthMetric();
      if (direction === 'down') return moveGrid('.radar-growth-row', current, direction) || current;
      if (direction === 'left') return firstRadarGrowthType() || firstRadarGrowthMetric() || activeSidebar();
      return null;
    }
    if (zone === 'rankFilters') {
      if (direction === 'up') return firstVisible('.rank-subtab.is-active') || firstVisible('.rank-tab.is-active') || activeSidebar();
      if (direction === 'down') return firstVisible('.rank-panel') || firstRankRow();
      if (direction === 'right') return firstVisible('.rank-panel') || firstRankRow();
      if (direction === 'left') return firstVisible('.rank-subtab.is-active') || activeSidebar();
      return null;
    }
    if (zone === 'rankSubnav') {
      if (direction === 'up') return moveWithinZone(zone, current, direction) || firstVisible('.rank-tab.is-active');
      if (direction === 'down') return moveWithinZone(zone, current, direction);
      if (direction === 'left') return activeSidebar();
      if (direction === 'right') return firstRankFilterToggle() || firstVisible('.rank-panel.is-active') || firstVisible('.rank-panel') || firstRankRow();
      return moveWithinZone(zone, current, direction);
    }
    if (zone === 'rankItems') {
      if (direction === 'up') return moveWithinZone(zone, current, direction) || firstRankFilterEntry();
      if (direction === 'down') return moveWithinZone(zone, current, direction) || listBoundary(rankPager, current, direction);
      if (direction === 'left') return firstVisible('.rank-subtab.is-active');
      if (direction === 'right') return current.querySelector('.rank-row-play, .rank-row-actor');
      return null;
    }
    if (zone === 'rankActions') {
      var row = current.closest('.rank-row');
      if (direction === 'left') return row;
      if (direction === 'up' && current.classList.contains('rank-row-detail')) return row.querySelector('.rank-row-play');
      if (direction === 'down' && current.classList.contains('rank-row-play')) return row.querySelector('.rank-row-detail');
      if (direction === 'up' || direction === 'down') return moveGrid('.rank-row', row, direction) || (direction === 'down' ? listBoundary(rankPager, row, direction, current) : firstRankFilterEntry());
      return null;
    }
    if (zone === 'newTabs') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : firstNewFilter());
      if (direction === 'up') return activeSidebar();
      if (direction === 'down') return firstNewFilter() || (newMode === 'calendar' ? firstCalendarDay() : firstNewCard());
      return null;
    }
    if (zone === 'newFilters') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? firstVisible('.new-tab.is-active') : null);
      if (direction === 'up') return firstNewTab();
      if (direction === 'down') return newMode === 'calendar' ? firstCalendarDay() : firstNewCard();
      return null;
    }
    if (zone === 'newItems') {
      if (direction === 'left' || direction === 'right') return moveGrid('.new-card', current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return moveGrid('.new-card', current, direction) || firstNewFilter() || firstNewTab();
      if (direction === 'down') return moveGrid('.new-card', current, direction) || listBoundary(newPager, current, direction);
      return null;
    }
    if (zone === 'calendarDays') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : null);
      if (direction === 'up') return firstNewTab();
      if (direction === 'down') return firstCalendarRow();
      return null;
    }
    if (zone === 'calendarItems') {
      if (direction === 'up') return moveWithinZone(zone, current, direction) || firstCalendarDay();
      if (direction === 'down') return moveWithinZone(zone, current, direction) || listBoundary(calendarPager, current, direction);
      if (direction === 'right') return current.querySelector('.publication-action');
      if (direction === 'left') return activeSidebar();
      return null;
    }
    if (zone === 'reservationTabs') {
      if (direction === 'down') return firstVisible('.reservation-row') || firstVisible('#reservations-view .publication-action') || firstVisible('#reservation-pagination .list-retry');
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? firstVisible('.follow-tab.is-active') || activeSidebar() : null);
      if (direction === 'up') return firstVisible('.follow-tab.is-active') || activeSidebar();
      return null;
    }
    if (zone === 'libraryTabs') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : firstVisible('#library-manage'));
      if (direction === 'up') return activeSidebar();
      if (direction === 'down') return firstVisible('.library-type-filter.is-active') || firstVisible('.library-card') || firstVisible('.library-toolbar-button');
      return null;
    }
    if (zone === 'followTabs') {
      if (direction === 'left' || direction === 'right') return moveWithinZone(zone, current, direction) || (direction === 'left' ? activeSidebar() : firstVisible('#follow-notifications-open'));
      if (direction === 'up') return activeSidebar();
      if (direction === 'down') return followView === 'reservations' ? firstVisible('.reservation-tab.is-active') : firstVisible('.follow-action') || firstVisible('.follow-card') || firstVisible('#follow-pagination .list-retry');
      return null;
    }
    return direction === 'right' ? firstContentFocus() : activeSidebar();
  }

  function accountKeypadOpen() { return !!(numericKeypad && numericKeypad.isOpen()); }
  function accountKeypadFocus() {
    return document.querySelectorAll('.account-keypad-key')[numericKeypad.snapshot().index];
  }
  function renderAccountNumber(field) {
    var code = field.id === 'account-code';
    var placeholder = code ? uiText('content.inputCode', '请输入验证码') : accountData && accountData.phase === 'code' && accountData.phone ? uiText('content.phoneComplete', '请重新输入 {phone} 的完整手机号', { phone: accountData.phone }) : uiText('content.inputPhone', '请输入手机号');
    if (desktopShell) field.placeholder = placeholder;
    else field.textContent = field.value || placeholder;
    field.classList.toggle('is-empty', !field.value);
    field.setAttribute('aria-label', (code ? uiText('content.codeLabel', '短信验证码') : uiText('content.phoneLabel', '手机号')) + (desktopShell ? '' : uiText('ui.phoneComplete', '，确认键输入')));
  }
  function accountPhoneCountry() {
    for (var i = 0; i < accountPhoneCountries.length; i++) if (accountPhoneCountries[i].code === accountPhoneCountryCode) return accountPhoneCountries[i];
    return accountPhoneCountries[0] || { code: '+86', localeKey: 'country.mainlandChina', minLength: 11, maxLength: 11 };
  }
  function accountPhoneValid(value, country) {
    country = country || accountPhoneCountry();
    if (!country || typeof value !== 'string' || value.length < country.minLength || value.length > country.maxLength || !/^[0-9]+$/.test(value)) return false;
    return country.code !== '+86' || /^1[3-9][0-9]{9}$/.test(value);
  }
  function setAccountPhoneCountry(code, clearPhone) {
    var country = null;
    for (var i = 0; i < accountPhoneCountries.length; i++) if (accountPhoneCountries[i].code === code) { country = accountPhoneCountries[i]; break; }
    if (!country) return false;
    var changed = accountPhoneCountryCode !== country.code;
    accountPhoneCountryCode = country.code;
    try { window.localStorage.setItem('hongguo.account.phoneCountryCode', country.code); } catch (ignoredPhoneCountryStorage) {}
    document.getElementById('account-country-name').textContent = phoneCountryName(country);
    document.getElementById('account-country-code').textContent = country.code;
    var phone = document.getElementById('account-phone');
    phone.setAttribute('data-country-code', country.code);
    if (clearPhone && changed) { phone.value = ''; renderAccountNumber(phone); }
    if (desktopShell && phone.tagName === 'INPUT') phone.maxLength = country.maxLength;
    try {
      var countryEvent;
      if (typeof CustomEvent === 'function') countryEvent = new CustomEvent('phonecountrychange', { detail: { code: country.code, maxLength: country.maxLength } });
      else { countryEvent = document.createEvent('CustomEvent'); countryEvent.initCustomEvent('phonecountrychange', false, false, { code: country.code, maxLength: country.maxLength }); }
      document.dispatchEvent(countryEvent);
    } catch (ignoredPhoneCountryEvent) {}
    document.querySelectorAll('.account-country-item').forEach(function (item) {
      var selected = item.getAttribute('data-country-code') === country.code;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    renderAccountMessages(accountData || {}, !!(accountData && accountData.app_code_available));
    return true;
  }
  function buildAccountCountryList() {
    var list = document.getElementById('account-country-list');
    list.innerHTML = '';
    accountPhoneCountries.forEach(function (country) {
      var item = document.createElement('button');
      item.type = 'button'; item.className = 'account-country-item';
      item.setAttribute('role', 'option'); item.setAttribute('data-country-code', country.code);
      item.setAttribute('data-focus', 'account-country-' + country.code.slice(1));
      var name = document.createElement('span'); name.className = 'account-country-item-name'; name.textContent = phoneCountryName(country);
      var code = document.createElement('span'); code.className = 'account-country-item-code'; code.textContent = country.code;
      item.appendChild(name); item.appendChild(code);
      item.addEventListener('click', function () { setAccountPhoneCountry(country.code, true); closeAccountCountryModal(true); });
      list.appendChild(item);
    });
  }
  function openAccountCountryModal() {
    if (accountCountryModalOpen || accountBusy || pageMode() !== 'account' || accountData && accountData.phase === 'code') return;
    accountCountryReturnFocus = document.activeElement;
    accountCountryModalOpen = true;
    var modal = document.getElementById('account-country-modal');
    modal.classList.remove('is-hidden'); modal.setAttribute('aria-hidden', 'false');
    setAccountPhoneCountry(accountPhoneCountryCode, false);
    goFocus(document.querySelector('.account-country-item.is-selected') || firstVisible('.account-country-item'));
  }
  function closeAccountCountryModal(selected) {
    if (!accountCountryModalOpen) return;
    accountCountryModalOpen = false;
    var modal = document.getElementById('account-country-modal');
    modal.classList.add('is-hidden'); modal.setAttribute('aria-hidden', 'true');
    var target = selected ? document.getElementById('account-phone') : accountCountryReturnFocus;
    accountCountryReturnFocus = null;
    goFocus(target && focusables().indexOf(target) >= 0 ? target : document.getElementById('account-country'));
  }
  function openAccountKeypad(field) {
    if (!numericKeypad || !field || field.disabled || accountBusy || pageMode() !== 'account' || accountKeypadOpen()) return;
    accountKeypadReturnFocus = field;
    accountKeypadPhase = accountData && accountData.phase || 'phone';
    var kind = field.id === 'account-code' ? 'code' : 'phone';
    if (numericKeypad.open(kind, field.value, kind === 'phone' ? accountPhoneCountry() : null) && !desktopShell && accountNumberScan) accountNumberScan.start(kind, kind === 'phone' ? accountPhoneCountry() : null);
  }

  function normalizedKey(event) {
    var key = event.key || event.keyIdentifier;
    var aliases = { Left: 'ArrowLeft', Up: 'ArrowUp', Right: 'ArrowRight', Down: 'ArrowDown',
      Return: 'Enter', Esc: 'Escape', Spacebar: ' ', GoBack: 'Escape', BrowserBack: 'Escape',
      'U+000D': 'Enter', 'U+001B': 'Escape', 'U+0008': 'Backspace', 'U+0020': ' ' };
    if (aliases[key]) return aliases[key];
    if (!key || key === 'Unidentified' || key === 'Unknown' || /^U\+/.test(key)) {
      var code = event.keyCode || event.which;
      key = code >= 48 && code <= 57 ? String(code - 48) : code >= 96 && code <= 105 ? String(code - 96) : keyNames[code] || key || '';
    }
    return key;
  }

  function handleKey(event) {
    var key = normalizedKey(event);
    if (handleEndRecommendationKey(key, !!event.repeat)) { event.preventDefault(); event.stopPropagation(); return; }
    if (accountKeypadOpen()) {
      numericKeypad.handleKey(key, !!event.repeat);
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen && typeof handlePlaybackCommandMenuKey === 'function' && handlePlaybackCommandMenuKey(key, !!event.repeat)) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    var current = event.remoteNavigation ? remoteFocusTarget() || document.activeElement : document.activeElement;
    if (typeof desktopShell !== 'undefined' && desktopShell && window.HongguoDesktopUI.editing(current)) {
      if (event.isComposing || event.keyCode === 229) return;
      if (current.id === 'search-input') {
        if (key === 'Escape' && searchSuggestionOpen) {
          handleBack();
          event.preventDefault(); event.stopPropagation(); return;
        }
        var searchTarget = null;
        if (key === 'ArrowDown') searchTarget = moveFrom(current, 'down');
        else if (key === 'ArrowRight' && typeof current.selectionStart === 'number' &&
            current.selectionStart === current.value.length && current.selectionEnd === current.selectionStart) {
          searchTarget = firstSearchAction();
        }
        if (searchTarget) {
          goFocus(searchTarget);
          event.preventDefault(); event.stopPropagation(); return;
        }
      }
      if (key !== 'Enter') return;
      if (current.id === 'search-input') submitSearch();
      else if (current.id === 'account-phone') accountSendCode();
      else if (current.id === 'account-code') accountLogin();
      else return;
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (current && current.classList.contains('player-text-input') && ['Escape', 'ArrowUp', 'ArrowDown'].indexOf(key) < 0) return;
    var direction = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' })[key];

    if (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) {
      if (key === 'Escape' || key === 'Backspace') handleBack();
      else if (key === 'Enter' && !event.repeat && current && typeof current.click === 'function') current.click();
      else if (direction) { var actorTarget = moveModalFrom(current, direction); if (actorTarget) goFocus(actorTarget); }
      event.preventDefault(); event.stopPropagation(); return;
    }

    var command = ({ MediaPlayPause: 'toggle', MediaPlay: 'play', MediaPause: 'pause', MediaFastForward: 'forward', MediaRewind: 'rewind', ' ': 'toggle' })[key];
    if (command && (!event.repeat || command === 'forward' || command === 'rewind') && handleMediaCommand(command)) {
      event.preventDefault(); event.stopPropagation(); return;
    }

    if (current && current.id === 'search-input' && ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'].indexOf(key) >= 0) return;

    if (key === 'Enter') {
      if (event.repeat) { event.preventDefault(); return; }
      if (zoneOf(current) === 'feed' && shell.classList.contains('is-controls-hidden')) {
        revealControls(); goFocus(firstVisible('.playback-buttons .control-button'));
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (current && current.id === 'control-progress') {
        goFocus(lastPlaybackControl || firstVisible('.playback-buttons .control-button'));
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (current && current.id === 'search-input') {
        submitSearch();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (current && typeof current.click === 'function') {
        current.click();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (key === 'Escape' || key === 'Backspace') {
      if (handleBack()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!direction) return;
    if (!detailModalOpen && !playerOptionsOpen && !confirmOpen && !discussionOpen && current && current.id === 'control-progress') {
      if (direction === 'left' || direction === 'right') seekBy(direction === 'left' ? -10 : 10);
      else goFocus(direction === 'up' ? document.getElementById('hero-feed-focus') : lastPlaybackControl || firstVisible('.playback-buttons .control-button'));
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (!detailModalOpen && !playerOptionsOpen && !confirmOpen && !discussionOpen && pageMode() === 'recommend' && zoneOf(current) === 'feed' &&
      shell.classList.contains('is-cinema') && (direction === 'up' || direction === 'down')) {
      if (!event.repeat) switchPlayerEpisode(direction === 'up' ? -1 : 1);
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (!detailModalOpen && !playerOptionsOpen && !confirmOpen && !discussionOpen && pageMode() === 'recommend' && zoneOf(current) === 'feed' && (direction === 'up' || direction === 'down')) {
      if (!event.repeat) switchRecommendation(direction === 'up' ? -1 : 1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!detailModalOpen && !playerOptionsOpen && !confirmOpen && !discussionOpen && zoneOf(current) === 'feed' && pageMode() === 'player' && (direction === 'up' || direction === 'down')) {
      if (!event.repeat) switchPlayerEpisode(direction === 'up' ? -1 : 1);
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (!detailModalOpen && !playerOptionsOpen && !confirmOpen && !discussionOpen &&
      (pageMode() === 'player' || pageMode() === 'recommend' && shell.classList.contains('is-cinema')) &&
      zoneOf(current) === 'feed' && (direction === 'left' || direction === 'right') &&
      (shell.classList.contains('is-cinema') || shell.classList.contains('is-controls-hidden'))) {
      var seeked = seekBy(direction === 'left' ? -10 : 10, false);
      if (!seeked) showNotice(uiText('ui.videoReadySeek', '视频准备好后才能快进或后退'));
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (isPlaybackPage() && !detailModalOpen && !playerOptionsOpen && !confirmOpen && !discussionOpen && (direction !== 'left' || shell.classList.contains('is-cinema') || zoneOf(current) !== 'feed')) revealControls();
    var target = moveFrom(current, direction);
    if (target) {
      goFocus(target);
    }
    // Consume boundary keys too; WebView must not scroll the page or perform
    // its own focus search when the remote reaches the end of a zone.
    event.preventDefault();
    event.stopPropagation();
  }

  function remoteKey(keyCode, repeat) {
    if ([19, 20, 21, 22, 23, 66, 160].indexOf(keyCode) < 0) return false;
    var handled = false;
    handleKey({ keyCode: keyCode, repeat: !!repeat, remoteNavigation: true, preventDefault: function () { handled = true; }, stopPropagation: function () {} });
    return handled;
  }

  function switchPlayerEpisode(step, fromWheel) {
    var playerMode = pageMode() === 'player';
    var fullscreenRecommendation = pageMode() === 'recommend' && shell.classList.contains('is-cinema');
    if ((!playerMode && !fullscreenRecommendation) || (!fromWheel && zoneOf(document.activeElement) !== 'feed') ||
      detailModalOpen || (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) || playerOptionsOpen || confirmOpen || discussionOpen) return false;
    step = Number(step);
    if (step !== -1 && step !== 1) return false;

    var playback = activePlayback;
    var request = playbackRequest;
    var item = playback && playback.item || feedItems[feedIndex] || featuredItem;
    var current = playback && Number(playback.episode) || request && request.index === feedIndex && Number(request.episode) ||
      featuredItem && Number(featuredItem.start_episode) || 0;
    if (!current) {
      showNotice(uiText('ui.readingCurrentEpisode', '正在读取当前集数'));
      return true;
    }
    current = Math.max(1, Math.floor(current));
    var target = current + step;
    if (target < 1) {
      showNotice(uiText('ui.firstEpisode', '已经是第一集'));
      return true;
    }
    var total = Number(item && item.episode_count) || Number(featuredItem && featuredItem.episode_count) || 0;
    if (total > 0 && target > total) {
      showNotice(uiText('ui.lastEpisode', '已经是本季最后一集'));
      return true;
    }

    // Keep the video area focused while playFeedItem cancels the old request,
    // resolves the new episode, and restores the existing transition/loading UI.
    playFeedItem(feedIndex, target, 0);
    goFocus(document.getElementById('hero-feed-focus'));
    return true;
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.classList.remove('is-hidden');
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(function () { notice.classList.add('is-hidden'); }, 3200);
  }

  function readPlaybackMenuHintSeen() {
    try {
      if (androidShell && window.HongguoTVPreferences && typeof window.HongguoTVPreferences.readPlaybackMenuHint === 'function') {
        return window.HongguoTVPreferences.readPlaybackMenuHint() === 'seen';
      }
      return window.localStorage.getItem('hongguo-tv-playback-menu-hint') === 'seen';
    } catch (ignored) { return false; }
  }

  function savePlaybackMenuHintSeen() {
    try {
      if (androidShell && window.HongguoTVPreferences && typeof window.HongguoTVPreferences.writePlaybackMenuHint === 'function') {
        window.HongguoTVPreferences.writePlaybackMenuHint('seen');
      } else window.localStorage.setItem('hongguo-tv-playback-menu-hint', 'seen');
    } catch (ignored) { /* An optional hint must never affect playback. */ }
  }

  function resizePlaybackMenuHint() {
    var graphic = document.getElementById('playback-menu-hint-graphic');
    if (!graphic || !playbackMenuHintAvailable) return;
    var width = Math.min(680, Math.floor((window.innerWidth || 680) * .9), Math.floor((window.innerHeight || 520) * .78 * 680 / 520));
    width = Math.max(240, width);
    graphic.style.width = width + 'px';
  }

  function updatePlaybackMenuHintCopy(playback) {
    var item = playback && playback.item || featuredItem || {};
    var count = Number(item.episode_count) || 0;
    var seasonEntry = item.series_id && seasonCatalogCache[item.series_id];
    var seasons = seasonEntry && Array.isArray(seasonEntry.items) ? seasonEntry.items.length : 0;
    var episode = Number(playback && playback.episode || item.start_episode || 1) || 1;
    var set = function (id, value) { var node = document.getElementById(id); if (node) node.textContent = value; };
    set('playback-menu-hint-title', uiText('player.menuHintTitle', '播放菜单提示'));
    set('playback-menu-hint-copy', uiText('player.menuHintCopy', '按返回键或等待片刻可关闭提示'));
    set('playback-menu-hint-press', uiText('player.menuHintPress', '按下菜单键'));
    set('playback-menu-hint-screen-episode', uiText('player.menuHintEpisodeBadge', '第 {episode} 集', { episode: episode }));
    set('playback-menu-hint-menu-title', uiText('player.quickMenu', '播放菜单'));
    set('playback-menu-hint-episode', count ? uiText('player.menuHintEpisode', '选集 · 全{count}集', { count: count }) : uiText('modal.selectEpisode', '选集'));
    set('playback-menu-hint-season', seasons > 1 ? uiText('player.menuHintSeason', '选季 · {count}季', { count: seasons }) : uiText('player.menuHintSeasonShort', '选季'));
    set('playback-menu-hint-fullscreen', uiText('player.menuHintFullscreen', '全屏'));
    set('playback-menu-hint-caption', uiText('player.menuHintCaption', '屏幕右侧弹出播放菜单'));
    resizePlaybackMenuHint();
  }
  if (window.HongguoI18n && typeof window.HongguoI18n.onChange === 'function') window.HongguoI18n.onChange(function () {
    var hint = document.getElementById('playback-menu-hint');
    if (hint && !hint.classList.contains('is-hidden')) updatePlaybackMenuHintCopy(activePlayback);
  });

  function closePlaybackMenuHint() {
    clearTimeout(playbackMenuHintTimer);
    playbackMenuHintTimer = 0;
    var hint = document.getElementById('playback-menu-hint');
    if (hint) { hint.classList.add('is-hidden'); hint.setAttribute('aria-hidden', 'true'); }
    playbackMenuHintCandidate = false;
  }

  function armPlaybackMenuHint() {
    if (!playbackMenuHintAvailable || playbackMenuHintSeen || pageMode() !== 'recommend' || !feedItems.length) return false;
    playbackMenuHintCandidate = true;
    return true;
  }

  function showPlaybackMenuHint(playback) {
    if (!playbackMenuHintAvailable || playbackMenuHintSeen || !playbackMenuHintCandidate || !isPlaybackPage()) return false;
    playbackMenuHintSeen = true;
    playbackMenuHintCandidate = false;
    savePlaybackMenuHintSeen();
    updatePlaybackMenuHintCopy(playback);
    var hint = document.getElementById('playback-menu-hint');
    if (!hint) return false;
    hint.classList.remove('is-hidden');
    hint.setAttribute('aria-hidden', 'false');
    clearTimeout(playbackMenuHintTimer);
    playbackMenuHintTimer = setTimeout(closePlaybackMenuHint, 10000);
    return true;
  }

  function notificationAccountKey() {
    return accountData && accountData.logged_in && accountData.profile && accountData.profile.uid ? String(accountData.profile.uid) : '';
  }
  function notificationStorageKey() { return 'hongguo-notification-seen:' + notificationAccountKey(); }
  function notificationSeenIDs() {
    var result = Object.create(null);
    try {
      var raw = localStorage.getItem(notificationStorageKey());
      var values = raw ? JSON.parse(raw) : [];
      (values || []).forEach(function (id) { if (id) result[String(id)] = true; });
    } catch (ignored) {}
    return result;
  }
  function saveNotificationSeenIDs(seen) {
    try {
      var values = Object.keys(seen).slice(-220);
      localStorage.setItem(notificationStorageKey(), JSON.stringify(values));
    } catch (ignored) {}
  }
  function renderNotificationBadge() {
    var badge = document.getElementById('follow-notifications-badge');
    if (!badge) return;
    badge.textContent = followNotificationUnread > 99 ? '99+' : String(followNotificationUnread);
    badge.classList.toggle('is-hidden', followNotificationUnread < 1);
  }
  function updateFollowNotificationAccess() {
    var button = document.getElementById('follow-notifications-open');
    if (!button) return;
    var enabled = !!(accountData && accountData.logged_in);
    button.classList.toggle('is-hidden', !enabled);
    button.disabled = !enabled;
  }
  function notificationCanPopup() {
    return !applicationInBackground && !applicationHidden() && !isPlaybackPage() && !detailModalOpen && !(typeof actorWorksOpen !== 'undefined' && actorWorksOpen) && !playerOptionsOpen && !discussionOpen && !confirmOpen && !supportModalOpen;
  }
  function notificationHidePopup() {
    clearTimeout(notificationPopupTimer);
    var popup = document.getElementById('notification-popup');
    if (popup) popup.classList.add('is-hidden');
  }
  function notificationShowPopup(item) {
    if (!item || !notificationCanPopup()) { if (item) notificationPopupQueue.push(item); return; }
    var popup = document.getElementById('notification-popup');
    if (!popup) return;
    popup.textContent = '';
    var title = document.createElement('strong'); title.textContent = item.kind === 'reservation_online' ? uiText('ui.reservationNotification', '预约提醒') : uiText('ui.followNotification', '追更提醒');
    var message = document.createElement('span'); message.textContent = item.message || item.title || uiText('ui.newDramaUpdate', '有新的短剧更新');
    popup.appendChild(title); popup.appendChild(message); popup.classList.remove('is-hidden');
    clearTimeout(notificationPopupTimer);
    notificationPopupTimer = setTimeout(notificationHidePopup, 7000);
  }
  function flushNotificationPopup() {
    if (!notificationCanPopup() || !notificationPopupQueue.length) return;
    var item = notificationPopupQueue.shift();
    notificationShowPopup(item);
  }
  function formatNotificationTime(stamp) {
    if (!stamp) return '';
    try { return new Date(stamp).toLocaleString(); } catch (ignored) { return ''; }
  }
  function renderFollowNotifications() {
    renderNotificationBadge();
    if (!followNotificationList) return;
    followNotificationList.innerHTML = '';
    if (!followNotificationItems.length) {
      var empty = document.createElement('div'); empty.className = 'follow-notification-empty'; empty.textContent = uiText('ui.noUpdateNotifications', '暂无更新提醒'); followNotificationList.appendChild(empty); return;
    }
    followNotificationItems.slice().reverse().forEach(function (item) {
      var drama = Object.assign({}, item.drama || {}, { series_id: (item.drama && item.drama.series_id) || item.series_id, title: (item.drama && item.drama.title) || item.title });
      var row = document.createElement('div'); row.className = 'follow-notification-row' + (item.read ? '' : ' is-unread'); row.dataset.notificationId = item.id || '';
      var play = document.createElement('button'); play.type = 'button'; play.className = 'follow-notification-play'; play.dataset.focus = 'follow-notice-play-' + item.id;
      play.setAttribute('aria-label', uiText('ui.playLabel', '播放：') + (drama.title || item.title || uiText('app.name', '短剧')));
      var image = document.createElement('img'); image.className = 'follow-notification-image'; image.alt = drama.title || uiText('app.name', '短剧'); setCover(image, drama);
      var copy = document.createElement('span'); copy.className = 'follow-notification-copy-block';
      var title = document.createElement('strong'); title.className = 'follow-notification-title'; title.textContent = drama.title || uiText('ui.dramaUpdate', '短剧更新');
      var meta = document.createElement('span'); meta.className = 'follow-notification-meta'; meta.textContent = dramaMeta(drama);
      var intro = document.createElement('span'); intro.className = 'follow-notification-intro'; intro.textContent = drama.intro || uiText('ui.noIntro', '暂无简介');
      var heat = document.createElement('span'); heat.className = 'follow-notification-heat'; heat.textContent = drama.heat || drama.favorite_text || drama.like_text || '';
      var message = document.createElement('span'); message.className = 'follow-notification-message'; message.textContent = item.message || '';
      copy.appendChild(title); copy.appendChild(meta); copy.appendChild(intro); copy.appendChild(heat); copy.appendChild(message);
      var time = document.createElement('time'); time.className = 'follow-notification-time'; time.textContent = formatNotificationTime(item.created_at);
      play.appendChild(image); play.appendChild(copy); play.appendChild(time);
      var detail = document.createElement('button'); detail.type = 'button'; detail.className = 'follow-notification-detail'; detail.dataset.focus = 'follow-notice-detail-' + item.id; detail.textContent = uiText('ui.detailButton', '详情'); detail.setAttribute('aria-label', uiText('ui.detailButton', '详情') + '：' + (drama.title || item.title || uiText('app.name', '短剧')));
      play.addEventListener('click', function () { markNotificationRead(item.id); startPlayer(drama, play); });
      detail.addEventListener('click', function () { markNotificationRead(item.id); openDetail(drama, undefined, detail); });
      keepNotificationActionVisible(play); keepNotificationActionVisible(detail);
      row.appendChild(play); row.appendChild(detail); followNotificationList.appendChild(row);
    });
  }
  function keepNotificationActionVisible(action) {
    action.addEventListener('focus', function () {
      var row = action.closest('.follow-notification-row');
      var list = followNotificationList;
      if (!row || !list || !list.getBoundingClientRect) return;
      var listRect = list.getBoundingClientRect();
      var rowRect = row.getBoundingClientRect();
      if (rowRect.top < listRect.top) list.scrollTop -= listRect.top - rowRect.top;
      else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
    });
  }
  function firstNotificationFocus() { return firstVisible('.follow-notification-play') || firstVisible('.follow-notification-detail') || firstVisible('#follow-notifications-back'); }
  function acceptNotificationData(data, showNew) {
    var notificationView = document.getElementById('follow-notification-view');
    var restoreFocus = followNotificationViewOpen && notificationView && notificationView.contains(document.activeElement);
    var focusedKey = restoreFocus && document.activeElement.dataset ? document.activeElement.dataset.focus : '';
    var items = data && data.items || [];
    followNotificationItems = items.slice();
    followNotificationUnread = Number(data && data.unread_count) || followNotificationItems.filter(function (item) { return !item.read; }).length;
    renderFollowNotifications();
    if (restoreFocus) {
      var restored = null;
      if (focusedKey) document.querySelectorAll('[data-focus]').forEach(function (node) { if (!restored && node.dataset.focus === focusedKey) restored = node; });
      goFocus(restored || firstNotificationFocus());
    }
    if (!showNew) return;
    var key = notificationAccountKey();
    if (!key) return;
    var seen = notificationSeenIDs();
    var fresh = [];
    followNotificationItems.forEach(function (item) {
      if (!item.id || seen[item.id]) return;
      seen[item.id] = true; fresh.push(item);
    });
    saveNotificationSeenIDs(seen);
    fresh.forEach(function (item) { notificationPopupQueue.push(item); });
    flushNotificationPopup();
  }
  function notificationCheck(force) {
    if (!notificationAccountKey() || notificationCheckBusy || applicationHidden() || applicationInBackground) return Promise.resolve(false);
    var now = Date.now();
    if (!force && now - notificationLastCheck < 10 * 60 * 1000) { flushNotificationPopup(); return Promise.resolve(false); }
    notificationLastCheck = now; notificationCheckBusy = true;
    return fetchData('/api/v1/notifications').then(function (data) {
      var key = notificationAccountKey(); var first = notificationKnownKey !== key; notificationKnownKey = key;
      if (first) {
        // An existing account should not receive a toast for every old item on
        // first launch. Future server-generated IDs will still be surfaced.
        var seen = notificationSeenIDs(); (data.items || []).forEach(function (item) { if (item.id) seen[item.id] = true; }); saveNotificationSeenIDs(seen);
      }
      acceptNotificationData(data, !first);
      return true;
    }).catch(function (error) { if (followNotificationViewOpen) showNotice(uiText('ui.followReadFailed', '更新提醒暂时读取失败')); return false; })
      .then(function (ok) { notificationCheckBusy = false; flushNotificationPopup(); return ok; });
  }
  function openFollowNotifications() {
    followNotificationReturnFocus = document.activeElement;
    followNotificationViewOpen = true;
    if (followActions) followActions.classList.add('is-hidden');
    followListView.classList.add('is-hidden'); followNotificationView.classList.remove('is-hidden');
    renderFollowNotifications();
    notificationCheck(true);
    goFocus(firstNotificationFocus());
  }
  function closeFollowNotifications() {
    followNotificationViewOpen = false; followNotificationView.classList.add('is-hidden'); followListView.classList.remove('is-hidden'); if (followActions) followActions.classList.remove('is-hidden');
    var target = followNotificationReturnFocus; followNotificationReturnFocus = null;
    goFocus(target && document.contains(target) && !target.disabled ? target : document.getElementById('follow-notifications-open'));
  }
  function markNotificationRead(id, row) {
    if (!id) return;
    var target = row && row.dataset.focus;
    fetchData('/api/v1/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) }).then(function (data) {
      acceptNotificationData(data, false);
      if (target && followNotificationViewOpen) goFocus(document.querySelector('[data-focus="' + target.replace(/"/g, '') + '"]') || document.getElementById('follow-notifications-back'));
    }).catch(function () { showNotice(uiText('ui.followMarkFailed', '更新提醒暂时无法标记')); });
  }

  function isPlaybackPage() { return pageMode() === 'recommend' || pageMode() === 'player'; }
  function scheduleControlsHide() {
    clearTimeout(controlsTimer);
    var video = document.getElementById('hero-video');
    if (!isPlaybackPage() || (typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) || shell.classList.contains('is-controls-hidden') || video.paused || video.ended || detailModalOpen || (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) || confirmOpen || playerOptionsOpen || discussionOpen || ['sidebar', 'channels'].indexOf(zoneOf(document.activeElement)) >= 0) return;
    controlsTimer = setTimeout(function () { hideControls(); }, 4000);
  }
  function revealControls() {
    controlsManuallyHidden = false;
    shell.classList.remove('is-controls-hidden');
    scheduleControlsHide();
  }
  function hideControls() {
    clearTimeout(controlsTimer);
    if (!isPlaybackPage() || (typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) || detailModalOpen || (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) || confirmOpen || playerOptionsOpen || discussionOpen || zoneOf(document.activeElement) === 'sidebar') return;
    shell.classList.add('is-controls-hidden');
    goFocus(document.getElementById('hero-feed-focus'));
  }
  function setPlayerStatus(message, failed) {
    var panel = document.getElementById('player-status');
    var hero = document.getElementById('hero');
    if (failed && autoCinemaCandidate) cancelPendingAutoCinema();
    if (failed && activePlayback && activePlayback.presentation) activePlayback.presentation.failed = true;
    var preparing = hero.classList.contains('is-preparing-video') || activePlayback && (activePlayback.continuationPending || !activePlayback.started);
    var transition = !!(message && !failed && preparing);
    if (failed) clearEpisodeCover();
    hero.classList.toggle('is-transition-loading', transition);
    panel.classList.toggle('is-loading', !!(message && !failed));
    // The complete poster provides the title. All normal starts and switches
    // keep only the spinner and target episode over it, without a panel.
    var title = document.getElementById('player-status-title');
    title.textContent = '';
    title.classList.add('is-hidden');
    // On affected older TV WebViews, revealing this panel in the same render
    // commit as the catalog-to-player layout change can crash the renderer.
    // Let that layout paint first, then reveal the loading state.
    if (message && !failed) {
      if (panel.classList.contains('is-hidden')) {
        if (typeof requestAnimationFrame === 'function') {
          var revealTicket = (setPlayerStatus.revealTicket = (setPlayerStatus.revealTicket || 0) + 1);
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              if (revealTicket === setPlayerStatus.revealTicket) panel.classList.remove('is-hidden');
            });
          });
        } else {
          panel.classList.remove('is-hidden');
        }
      }
    } else {
      setPlayerStatus.revealTicket = (setPlayerStatus.revealTicket || 0) + 1;
      panel.classList.toggle('is-hidden', !message);
    }
    // The ellipsis keeps loading active while the target episode is unknown.
    // Its spinner already conveys loading; do not invent an episode number.
    var text = document.getElementById('player-status-text');
    var copy = message === '…' ? '' : message || '';
    text.textContent = copy;
    text.classList.toggle('is-hidden', !copy);
    panel.querySelector('.player-spinner').classList.toggle('is-hidden', !!failed);
    document.getElementById('player-retry').classList.toggle('is-hidden', !failed);
    document.getElementById('player-failure-diagnostics').classList.toggle('is-hidden', !failed);
    if (failed) {
      clearLastPlaybackFrame();
      revealControls();
      if (zoneOf(document.activeElement) === 'feed') goFocus(document.getElementById('player-retry'));
    }
  }
  function episodeLoadingText(episode) { return episode > 0 ? uiText('content.episodeNumber', '第{episode}集', { episode: episode }) : '…'; }
  function setControlIcon(action, label, icon) {
    var button = document.querySelector('[data-action="' + action + '"]');
    var text = button.querySelector('.control-label');
    if (text.textContent !== label) text.textContent = label;
    button.setAttribute('aria-label', label);
    var use = button.querySelector('use');
    if (use.getAttribute('href') !== '#' + icon) {
      use.setAttribute('href', '#' + icon);
      use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + icon);
    }
  }
  function playbackSpeedAvailable() {
    var audio = webosShell && window.HongguoWebOSAudio;
    return !webosShell || !!(audio && audio.supported && audio.isEnabled());
  }
  function updatePlaybackControls() {
    var video = document.getElementById('hero-video');
    var duration = Number.isFinite(video.duration) ? video.duration : 0;
    var position = Math.min(duration, Number(video.currentTime) || 0);
    var progress = document.getElementById('control-progress');
    document.querySelector('.time-label').textContent = clockText(position) + ' / ' + clockText(duration);
    progress.disabled = !duration;
    progress.setAttribute('aria-valuemax', String(Math.floor(duration)));
    progress.setAttribute('aria-valuenow', String(Math.floor(position)));
    progress.setAttribute('aria-valuetext', clockText(position) + ' / ' + clockText(duration));
    progress.querySelector('span').style.width = (duration ? position / duration * 100 : 0) + '%';
    var paused = video.paused || video.ended;
    setControlIcon('pause', paused ? uiText('ui.play', '播放') : uiText('ui.pause', '暂停'), paused ? 'icon-play' : 'icon-pause');
    var speedLabel = video.playbackRate + 'x';
    if (webosShell && window.HongguoWebOSAudio && window.HongguoWebOSAudio.isEnabled()) {
      var audioState = window.HongguoWebOSAudio.diagnostics();
      speedLabel = audioState.actual_video_rate + 'x' + (audioState.phase === 'preparing' || audioState.phase === 'aligning' ? '…' : '');
    }
    var speedButton = document.querySelector('[data-action="speed"]');
    if (speedButton) {
      var speedHidden = !playbackSpeedAvailable();
      speedButton.classList.toggle('is-hidden', speedHidden);
      if (speedHidden) {
        speedButton.tabIndex = -1;
        speedButton.setAttribute('aria-hidden', 'true');
      } else {
        speedButton.removeAttribute('aria-hidden');
        speedButton.removeAttribute('tabindex');
      }
    }
    setControlIcon('speed', speedLabel, 'icon-speed');
    var muted = (playbackAudioHold ? playbackAudioHold.muted : video.muted) || !video.volume;
    setControlIcon('volume', muted ? uiText('ui.mute', '静音') : uiText('ui.volume', '音量') + ' ' + Math.round(video.volume * 100) + '%', muted ? 'icon-volume-muted' : 'icon-volume');
    setControlIcon('quality', playbackQuality ? (playbackPreferences.quality ? '' : uiText('diagnostic.auto', '自动') + ' · ') + playbackQuality : uiText('ui.quality', '清晰度'), 'icon-quality');
    var cinema = shell.classList.contains('is-cinema');
    setControlIcon('fullscreen', cinema ? uiText('ui.exitFullscreen', '退出全屏') : uiText('ui.fullscreen', '全屏'), cinema ? 'icon-fullscreen-exit' : 'icon-fullscreen');
  }
  function savePlaybackPreferences() {
    try {
      var value = JSON.stringify(playbackPreferences);
      if (androidShell && window.HongguoTVPreferences) window.HongguoTVPreferences.write(value);
      else localStorage.setItem('hongguo-tv-playback', value);
      return true;
    } catch (error) { showNotice(uiText('ui.playbackSettingsSaveFailed', '播放设置未保存')); return false; }
  }
  function restorePlaybackPreferences() {
    try {
      var value = androidShell && window.HongguoTVPreferences ? window.HongguoTVPreferences.read() : localStorage.getItem('hongguo-tv-playback');
      var saved = JSON.parse(value || '{}');
      if (playbackSpeeds.indexOf(saved.speed) >= 0) playbackPreferences.speed = saved.speed;
      if (Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 100) playbackPreferences.volume = saved.volume;
      if (/^[1-9][0-9]{2,3}P$/.test(saved.quality || '')) playbackPreferences.quality = saved.quality;
      playbackPreferences.prefetch_mode = HongguoEpisodePrefetch.normalizePrefetchMode(saved.prefetch_mode);
      danmakuEnabled = saved.danmaku === true; playbackPreferences.danmaku = danmakuEnabled;
    } catch (error) { /* Invalid preferences fall back to normal playback. */ }
    var fullPrefetchSupported = typeof HongguoEpisodePrefetchSettings !== 'undefined' && HongguoEpisodePrefetchSettings &&
      typeof HongguoEpisodePrefetchSettings.supports === 'function' && typeof episodePrefetchPlatform === 'function' &&
      HongguoEpisodePrefetchSettings.supports(episodePrefetchPlatform());
    if (!fullPrefetchSupported) playbackPreferences.prefetch_mode = 'range';
    // Keep native webOS playback at audible 1x unless the user has opted in.
    // An enabled experiment restores its saved speed through the audio controller.
    if (!playbackSpeedAvailable()) playbackPreferences.speed = 1;
    var video = document.getElementById('hero-video');
    document.querySelector('[data-action="volume"]').classList.toggle('is-hidden', androidShell);
    if (androidShell) {
      playbackPreferences.volume = 100;
      savePlaybackPreferences();
    }
    video.playbackRate = playbackPreferences.speed;
    video.defaultPlaybackRate = playbackPreferences.speed;
    video.volume = playbackPreferences.volume / 100;
    setPlaybackMuted(playbackPreferences.volume === 0);
    updateDanmakuButton();
    updatePlaybackControls();
  }
  function cancelDiagnosticRead() {
    ++diagnosticEpoch;
    if (diagnosticRequest) diagnosticRequest.abort();
    diagnosticRequest = null;
  }
  function diagnosticNumber(value) { return typeof value === 'number' && isFinite(value) ? Math.max(0, value) : 0; }
  function readDiagnosticEnvironment() {
    var screen = window.screen || {};
    var width = window.innerWidth, height = window.innerHeight, dpr = window.devicePixelRatio;
    var userAgent = typeof navigator.userAgent === 'string' ? navigator.userAgent.replace(/[\x00-\x1f\x7f]/g, ' ') : '';
    function valid(value) { return typeof value === 'number' && isFinite(value) && value > 0; }
    function dimensions(w, h) { return valid(w) && valid(h) ? w + ' × ' + h : uiText('ui.notObtained', '未取得'); }
    var pixels = valid(width) && valid(height) && valid(dpr) ? dimensions(Math.round(width * dpr), Math.round(height * dpr)) : uiText('ui.notObtained', '未取得');
    return { userAgent: userAgent, rows: [
      { label: uiText('ui.viewportSize', '视口尺寸'), value: dimensions(width, height) },
      { label: uiText('ui.screenSize', '屏幕尺寸'), value: dimensions(screen.width, screen.height) },
      { label: 'DPR', value: valid(dpr) ? String(dpr) : uiText('ui.notObtained', '未取得') },
      { label: uiText('ui.pixelEstimate', '像素估算'), value: pixels },
      { label: 'User Agent', value: userAgent || uiText('ui.notObtained', '未取得'), wide: true }
    ] };
  }
  function readDiagnosticVideo(video) {
    var api = window.HongguoPlaybackDiagnostics;
    if (api && typeof api.readVideo === 'function') {
      try { return api.readVideo(video); } catch (ignored) {}
    }
    var result = { position: diagnosticNumber(video.currentTime), duration: diagnosticNumber(video.duration), width: diagnosticNumber(video.videoWidth), height: diagnosticNumber(video.videoHeight), ready: diagnosticNumber(video.readyState), network: diagnosticNumber(video.networkState), paused: !!video.paused, ended: !!video.ended, seeking: !!video.seeking, muted: !!video.muted, volume: diagnosticNumber(video.volume), buffered: 0, error: video.error ? diagnosticNumber(video.error.code) : 0, decoded: null };
    try {
      for (var i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= result.position && video.buffered.end(i) >= result.position) { result.buffered = video.buffered.end(i) - result.position; break; }
      }
    } catch (ignoredBuffer) {}
    return result;
  }
  function diagnosticFallbackReport(snapshot, reason) {
    var video = snapshot.video || {}, flags = snapshot.flags || {}, device = snapshot.device || {};
    var current = snapshot.episode > 0 ? uiText('content.episodeNumber', '第{episode}集', { episode: diagnosticNumber(snapshot.episode) }) : uiText('ui.episodeUnknown', '集数尚未确定');
    var state = video.ended ? uiText('diagnostic.ended', '已结束') : video.paused ? uiText('diagnostic.paused', '暂停') : uiText('diagnostic.playing', '播放中');
    if (flags.preparing) state += ' · ' + uiText('ui.preparing', '准备中');
    if (flags.failed) state = uiText('ui.playbackPrepareFailed', '播放准备失败');
    var size = diagnosticNumber(video.width) + ' × ' + diagnosticNumber(video.height);
    var deviceName = (typeof device.manufacturer === 'string' ? device.manufacturer : '') + ' ' + (typeof device.model === 'string' ? device.model : '');
    return { summary: reason ? uiText('ui.basicDiagnostics', '基础诊断已显示；完整诊断组件未加载') : uiText('ui.basicPlaybackState', '基础播放状态'), rows: [
      { label: uiText('diagnostic.currentVideo', '当前视频'), value: current },
      { label: uiText('diagnostic.deviceModel', '设备型号'), value: deviceName.replace(/^\s+|\s+$/g, '') || uiText('diagnostic.deviceUnavailable', '设备信息未取得') },
      { label: uiText('diagnostic.videoPicture', '视频画面'), value: size },
      { label: uiText('diagnostic.playbackClock', '播放时钟'), value: Math.floor(diagnosticNumber(video.position)) + ' 秒 / ' + (video.duration ? Math.floor(diagnosticNumber(video.duration)) + ' 秒' : uiText('diagnostic.durationUnknown', '未知时长')) },
      { label: uiText('diagnostic.playbackState', '播放状态'), value: state },
      { label: uiText('diagnostic.recentError', '最近错误'), value: reason ? uiText('ui.updateStateDefault', '请更新应用后重试') : uiText('ui.read', '已读取') }
    ].concat(snapshot.environmentRows || []), capturedAt: snapshot.capturedAt || '—' };
  }
  function moveDiagnosticFocus(current, direction) {
    var scroll = document.getElementById('player-diagnostics-scroll');
    var refresh = document.getElementById('player-diagnostics-refresh');
    var close = document.getElementById('player-diagnostics-close');
    if (current === scroll) {
      if (direction === 'right') return refresh;
      var bottom = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      if (direction === 'down' && scroll.scrollTop >= bottom - 1) return refresh;
      if (direction === 'up' || direction === 'down') {
        var step = Math.max(60, Math.round(scroll.clientHeight * .7));
        scroll.scrollTop = Math.max(0, Math.min(bottom, scroll.scrollTop + (direction === 'down' ? step : -step)));
      }
      return null;
    }
    if (direction === 'up') return scroll;
    if (direction === 'left') return current === close ? refresh : scroll;
    if (direction === 'right' && current === refresh) return close;
    return null;
  }
  function renderPlaybackDiagnostics(snapshot) {
    var scroll = document.getElementById('player-diagnostics-scroll');
    var scrollTop = scroll.scrollTop;
    var report, api = window.HongguoPlaybackDiagnostics;
    try {
      if (!api || typeof api.report !== 'function') throw new Error('diagnostic component unavailable');
      report = api.report(snapshot);
      if (!report || !report.rows || !report.rows.length) throw new Error('diagnostic report empty');
    } catch (error) {
      report = diagnosticFallbackReport(snapshot, error);
    }
    document.getElementById('player-diagnostics-summary').textContent = report.summary;
    var rows = document.getElementById('player-diagnostics-rows'); rows.innerHTML = '';
    report.rows.forEach(function (item) {
      var row = document.createElement('div'); row.className = 'diagnostic-row' + (item.wide ? ' diagnostic-row-wide' : '');
      var label = document.createElement('span'); label.className = 'diagnostic-label'; label.textContent = item.label;
      var value = document.createElement('span'); value.className = 'diagnostic-value'; value.textContent = item.value;
      row.appendChild(label); row.appendChild(value); rows.appendChild(row);
    });
    document.getElementById('player-diagnostics-time').textContent = uiText('ui.snapshot', '快照 {value}', { value: report.capturedAt });
    // Clearing the rows can temporarily clamp scrollTop to zero. Restore it
    // after both the synchronous snapshot and the asynchronous core report.
    scroll.scrollTop = scrollTop;
  }
  function refreshPlaybackDiagnostics() {
    if (!playerOptionsOpen || !document.getElementById('player-options').classList.contains('is-diagnostics')) return;
    cancelDiagnosticRead();
    var epoch = diagnosticEpoch, video = document.getElementById('hero-video'), hero = document.getElementById('hero');
    var device = desktopShell ? { app_version: window.HongguoDesktop.version } : {};
    try { if (window.HongguoTVDiagnostics) device = JSON.parse(window.HongguoTVDiagnostics.readDevice()); } catch (ignored) {}
    var native = {};
    try { if (window.HongguoNativePlayer && window.HongguoNativePlayer.diagnostics) native = JSON.parse(window.HongguoNativePlayer.diagnostics()); } catch (ignoredNative) {}
    var playbackRoute = null;
    try {
      var playbackAdapter = window.HongguoNativePlaybackAdapter;
      if (playbackAdapter && typeof playbackAdapter.diagnostics === 'function') playbackRoute = playbackAdapter.diagnostics();
    } catch (ignoredRoute) {}
    // native-player.js replaces getElementById('hero-video') with a media
    // proxy on Android. The proxy exposes media properties, but it is not a
    // DOM Element and old WebViews throw when getComputedStyle receives it.
    // Keep media reads on the proxy while reading visibility from the real
    // video node, with a visible fallback so diagnostics always renders.
    var style = { visibility: 'visible', display: 'block', opacity: '1' };
    try {
      var styleNode = document.querySelector('#hero-video');
      if (styleNode && window.getComputedStyle) style = window.getComputedStyle(styleNode);
    } catch (ignoredStyle) {}
    var now = new Date();
    var environment = readDiagnosticEnvironment();
    var presentation = activePlayback && activePlayback.presentation;
    var source = video.getAttribute('src') || '';
    if (desktopShell && window.HongguoDesktop.mediaBase && source.indexOf(window.HongguoDesktop.mediaBase + '/') === 0) source = source.slice(window.HongguoDesktop.mediaBase.length);
    var activeTiming = activePlayback && activePlayback.timing;
    var timingSnapshot = activeTiming ? Object.assign({}, activeTiming) : (playbackTiming.length ? Object.assign({}, playbackTiming[playbackTiming.length - 1]) : null);
    if (timingSnapshot && activeTiming) {
      var timingNow = Date.now();
      timingSnapshot.source_ready_ms = timingSnapshot.ready_at ? Math.max(0, timingSnapshot.ready_at - timingSnapshot.started_at) : null;
      timingSnapshot.native_frame_ms = presentation && presentation.frame_at && timingSnapshot.ready_at ? Math.max(0, presentation.frame_at - timingSnapshot.ready_at) : null;
      timingSnapshot.total_ms = Math.max(0, timingNow - timingSnapshot.started_at);
      if (timingSnapshot.handoff_started_at && timingSnapshot.handoff_wait_ms === null)
        timingSnapshot.handoff_wait_ms = Math.max(0, timingNow - timingSnapshot.handoff_started_at);
      if (timingSnapshot.foreground_resolve_started_at && timingSnapshot.foreground_resolve_ms === null)
        timingSnapshot.foreground_resolve_ms = Math.max(0, timingNow - timingSnapshot.foreground_resolve_started_at);
    }
    var snapshot = {
      device: device || {}, userAgent: environment.userAgent, environmentRows: environment.rows,
      native: native || {},
      playbackRoute: playbackRoute,
      timing: timingSnapshot,
      capturedAt: ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2) + ':' + ('0' + now.getSeconds()).slice(-2),
      video: readDiagnosticVideo(video),
      episode: activePlayback && activePlayback.episode || playbackRequest && playbackRequest.episode || 0,
      quality: playbackQuality,
      flags: { preparing: hero.classList.contains('is-preparing-video'), resolving: !!playbackInfoRequest,
        loading: !document.getElementById('player-status').classList.contains('is-hidden'),
        rangeFallback: activePlayback && activePlayback.rangeFallback || '',
        playbackMode: activePlayback && activePlayback.mode || '', rangeRequested: rangePlaybackEnabled(),
        source: !!source, waiting: !!(presentation && presentation.waiting), audioHeld: !!playbackAudioHold,
        failed: !!(presentation && presentation.failed) || !document.getElementById('player-retry').classList.contains('is-hidden'),
        videoVisible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0,
        background: applicationInBackground || applicationHidden() }
    };
    renderPlaybackDiagnostics(snapshot);
    // Read local status only. webOS can still hold the previous src while the
    // next episode is preparing; query the current foreground job in that case.
    var path = /^\/minireel-proxy\/media\/[a-f0-9]{24}\.mp4$/.test(source) ? source : '';
    if (window.HongguoWebOS && typeof window.HongguoWebOS.mediaPath === 'function') {
      path = snapshot.flags.preparing && !snapshot.flags.playbackMode ? '' : window.HongguoWebOS.mediaPath(source);
    }
    var request = new XMLHttpRequest(); diagnosticRequest = request;
    request.open('GET', '/api/v1/player/diagnostics?media=' + encodeURIComponent(path), true); request.timeout = 2500;
    function finish(core) {
      if (epoch !== diagnosticEpoch || diagnosticRequest !== request || !playerOptionsOpen) return;
      diagnosticRequest = null; snapshot.core = core; renderPlaybackDiagnostics(snapshot);
    }
    request.onload = function () {
      try {
        var result = JSON.parse(request.responseText);
        if (request.status !== 200 || !result.ok || !result.data) throw new Error('unavailable');
        finish(result.data);
      } catch (ignoredResponse) { finish({ unavailable: true }); }
    };
    request.onerror = request.ontimeout = function () { finish({ unavailable: true }); };
    request.send();
  }
  function closePlayerOptions(restoring) {
    if (typeof danmakuScanOpen !== 'undefined' && danmakuScanOpen) closeDanmakuScan(false);
    cancelDiagnosticRead();
    document.getElementById('player-options').classList.remove('is-diagnostics');
    document.getElementById('player-diagnostics').classList.add('is-hidden');
    document.getElementById('player-diagnostics-shade').classList.add('is-hidden');
    cancelQualitySwitch();
    ++composeEpoch;
    if (composeSession) storeDraft(danmakuDrafts, draftKey(composeSession), document.getElementById('player-compose-input').value);
    if (composeRequest) composeRequest.abort(); composeRequest = null; composeBusy = false; composeSession = null;
    document.getElementById('player-compose-input').readOnly = false; document.getElementById('player-compose-send').removeAttribute('aria-busy');
    playerOptionsOpen = false;
    document.getElementById('player-options').classList.add('is-hidden');
    var target = playerOptionsReturn;
    playerOptionsReturn = null;
    if (restoring !== false) goFocus(target && document.contains(target) ? target : document.getElementById('hero-feed-focus'));
    scheduleControlsHide();
  }
  function cancelQualitySwitch() {
    ++qualityEpoch;
    if (qualityRequest) qualityRequest.abort(); qualityRequest = null;
    var old = qualityPrevious; qualityPrevious = null;
    if (old && activePlayback === old.playback) {
      setPlayerStatus('');
      if (old.playing && !applicationHidden() && !applicationInBackground) playMedia(document.getElementById('hero-video')).catch(function () {});
    }
  }
  function switchQuality(value) {
    if (qualityPrevious || !activePlayback) return;
    episodePrefetch.cancel();
    if (value === playbackQuality || value === playbackPreferences.quality) {
      playbackPreferences.quality = value; savePlaybackPreferences(); updatePlaybackControls(); closePlayerOptions(); return;
    }
    var video = document.getElementById('hero-video'); var playback = activePlayback;
    var epoch = ++qualityEpoch; var generation = feedGeneration;
    qualityPrevious = { playback: playback, playing: !video.paused && !video.ended };
    var previous = qualityPrevious; var position = video.currentTime;
    clearRangeStallTimer();
    video.pause(); document.getElementById('player-options-message').textContent = uiText('ui.preparingQuality', '正在准备 {quality}…', { quality: value || uiText('ui.autoQuality', '自动清晰度') });
    qualityRequest = typeof AbortController === 'function' ? new AbortController() : null;
    var q = new URLSearchParams({ series_id: playback.item.series_id, vid: playback.vid, quality: value });
    q.set('codec_mode', typeof playbackCodecMode === 'function' ? playbackCodecMode() : 'default');
    if (rangePlaybackEnabled()) q.set('mode', 'range');
    fetchData('/api/v1/play/info?' + q, qualityRequest ? { signal: qualityRequest.signal } : {}).then(function (data) {
      if (epoch !== qualityEpoch || generation !== feedGeneration || activePlayback !== playback || !playerOptionsOpen) return;
      if (!data.path) throw new Error(uiText('ui.mediaUrlMissing', '服务没有返回视频地址'));
      qualityPrevious = null; qualityRequest = null;
      playback.position = position; playback.started = false; playback.completed = false;
      playbackQuality = data.quality || ''; playbackQualities = data.qualities || [];
      playback.mode = data.mode || 'full';
      playback.rangeFallback = data.range_fallback || '';
      playbackPreferences.quality = value; savePlaybackPreferences();
      if (playbackRequest) playbackRequest.position = position;
      bindPlaybackPresentation(playback, data.path);
      video.src = data.path; stageNativePlaybackStartPosition(position); video.load(); updatePlaybackControls(); closePlayerOptions();
      setPlayerStatus(episodeLoadingText(playback.episode));
      if (previous.playing && !applicationHidden() && !applicationInBackground) playMedia(video).catch(function () { setPlayerStatus(''); revealControls(); });
    }).catch(function (error) {
      if (epoch !== qualityEpoch || generation !== feedGeneration) return;
      qualityPrevious = null; qualityRequest = null;
      document.getElementById('player-options-message').textContent = localizedError(error, 'content.switchFailed', '切换失败') + uiText('ui.originalRetained', '，原视频保留');
      if (previous.playing && !applicationHidden() && !applicationInBackground) playMedia(video).catch(function () {});
    });
  }
  function sendDanmaku() {
    var input = document.getElementById('player-compose-input'); var message = document.getElementById('player-options-message');
    if (composeBusy || !composeSession || needPlayerLogin(message)) return;
    var text = input.value.trim(); if (!text || Array.from(text).length > 100) { message.textContent = uiText('content.danmakuLimit', '请输入 1～100 字的弹幕'); goFocus(input); return; }
    var epoch = composeEpoch; var session = Object.assign({}, composeSession); delete session.episode; session.action = 'danmaku'; session.text = text;
    composeBusy = true; input.readOnly = true; document.getElementById('player-compose-send').setAttribute('aria-busy', 'true'); message.textContent = uiText('common.submitting', '正在发送…');
    composeRequest = typeof AbortController === 'function' ? new AbortController() : null;
    writePlayerAction(session, composeRequest && composeRequest.signal).then(function () {
      if (epoch !== composeEpoch) return;
      input.value = ''; delete danmakuDrafts[draftKey(composeSession)]; composeRequest = null;
      closePlayerOptions(); showNotice(uiText('content.danmakuSent', '弹幕已发送，审核通过后显示'));
    }).catch(function (error) { if (epoch === composeEpoch && error.name !== 'AbortError') message.textContent = localizedError(error, 'common.operationFailed', '操作未完成，请重试。'); })
      .then(function () { if (epoch === composeEpoch) { composeBusy = false; composeRequest = null; input.readOnly = false; document.getElementById('player-compose-send').removeAttribute('aria-busy'); } });
  }
  function openPlayerOptions(kind, entry) {
    if (!isPlaybackPage()) return;
    if (kind === 'speed' && !playbackSpeedAvailable()) return;
    if (kind === 'quality' && (!activePlayback || !document.getElementById('hero-video').getAttribute('src'))) { showNotice(uiText('ui.selectQualityHint', '视频准备好后可选择清晰度')); return; }
    if (kind === 'send-danmaku' && !playbackSnapshot()) { showNotice(uiText('ui.sendDanmakuHint', '开始播放后可发送弹幕')); return; }
    if (playerOptionsOpen) closePlayerOptions(false);
    revealControls(); clearTimeout(controlsTimer);
    playerOptionsReturn = entry;
    playerOptionsOpen = true;
    document.getElementById('player-options').classList.toggle('is-diagnostics', kind === 'diagnostics');
    document.getElementById('player-diagnostics').classList.toggle('is-hidden', kind !== 'diagnostics');
    document.getElementById('player-diagnostics-shade').classList.toggle('is-hidden', kind !== 'diagnostics');
    if (kind === 'diagnostics') {
      document.getElementById('player-options').classList.remove('is-composer');
      document.getElementById('player-options-title').textContent = uiText('ui.playbackDiagnostics', '播放诊断');
      document.getElementById('player-options-list').classList.add('is-hidden');
      document.getElementById('player-compose').classList.add('is-hidden');
      document.getElementById('player-options-message').textContent = '';
      document.getElementById('player-options').classList.remove('is-hidden');
      document.getElementById('player-diagnostics-scroll').scrollTop = 0;
      refreshPlaybackDiagnostics();
      goFocus(document.getElementById('player-diagnostics-scroll'));
      return;
    }
    var video = document.getElementById('hero-video');
    var values = kind === 'speed' ? playbackSpeeds : kind === 'quality' ? [''].concat(playbackQualities) : [0, 25, 50, 75, 100];
    var selected = kind === 'speed' ? video.playbackRate : kind === 'quality' ? playbackPreferences.quality : (playbackAudioHold ? playbackAudioHold.muted : video.muted) ? 0 : Math.round(video.volume * 100);
    document.getElementById('player-options-title').textContent = ({ speed: uiText('ui.playbackSpeed', '播放倍速'), volume: uiText('ui.volume', '音量'), quality: uiText('ui.quality', '清晰度'), 'send-danmaku': uiText('player.sendDanmaku', '发弹幕') })[kind];
    document.getElementById('player-options-message').textContent = kind === 'quality' ? uiText('ui.continueFromCurrent', '切换后从当前时间继续播放') : '';
    document.getElementById('player-options').classList.toggle('is-composer', kind === 'send-danmaku');
    document.getElementById('player-compose').classList.toggle('is-hidden', kind !== 'send-danmaku');
    var list = document.getElementById('player-options-list'); list.innerHTML = '';
    list.classList.toggle('is-hidden', kind === 'send-danmaku');
    if (kind === 'send-danmaku') {
      composeSession = playbackSnapshot(); composeSession.offset_ms = Math.floor(video.currentTime * 1000); ++composeEpoch;
      document.getElementById('player-compose-label').textContent = uiText('content.episodeNumber', '第{episode}集', { episode: composeSession.episode }) + ' · ' + clockText(video.currentTime);
      document.getElementById('player-compose-input').value = danmakuDrafts[draftKey(composeSession)] || '';
      document.getElementById('player-options').classList.remove('is-hidden'); goFocus(document.getElementById('player-compose-input')); return;
    }
    values.forEach(function (value, index) {
      var option = document.createElement('button');
      option.className = 'player-option' + (value === selected ? ' is-selected' : '');
      option.dataset.focus = 'player-option-' + index;
      option.textContent = kind === 'speed' ? value + 'x' : kind === 'quality' ? value || uiText('ui.auto', '自动') : value === 0 ? uiText('ui.mute', '静音') : value + '%';
      option.addEventListener('click', function () {
        if (kind === 'quality') { switchQuality(value); return; }
        try {
          if (kind === 'speed') {
            if (!(webosShell && window.HongguoWebOSAudio && window.HongguoWebOSAudio.chooseSpeed(value))) { video.playbackRate = value; video.defaultPlaybackRate = value; }
            playbackPreferences.speed = value;
          }
          else { video.volume = value / 100; setPlaybackMuted(value === 0); playbackPreferences.volume = value; }
          updatePlaybackControls(); savePlaybackPreferences(); closePlayerOptions();
        } catch (error) { showNotice(kind === 'speed' ? uiText('ui.speedUnsupported', '设备不支持这个倍速') : uiText('ui.remoteVolume', '请用遥控器音量键调整音量')); }
      });
      list.appendChild(option);
    });
    document.getElementById('player-options').classList.remove('is-hidden');
    goFocus(list.querySelector('.is-selected') || list.querySelector('.player-option'));
  }
  function seekTo(position, reveal) {
    var video = document.getElementById('hero-video');
    if (!activePlayback || !Number.isFinite(position) || !Number.isFinite(video.duration) || video.duration <= 0) return false;
    video.currentTime = Math.max(0, Math.min(position, Math.max(0, video.duration - .25)));
    updatePlaybackControls(); if (reveal !== false) revealControls();
    return true;
  }
  function seekBy(delta, reveal) {
    var changed = seekTo(document.getElementById('hero-video').currentTime + delta, reveal);
    if (changed && delta) showPlaybackFeedback(delta < 0 ? 'back' : 'forward');
    return changed;
  }
  function syncNativePlayerBounds() {
    var adapter = window.HongguoNativePlaybackAdapter;
    if (adapter && typeof adapter.syncBounds === 'function') adapter.syncBounds();
    layoutLastPlaybackFrame();
  }
  function setCinema(enabled) {
    shell.classList.toggle('is-cinema', enabled);
    updatePlaybackControls();
    // CSS cinema mode does not resize the Android WebView. Read the new
    // layout explicitly, including after the browser fullscreen callback.
    syncNativePlayerBounds();
    setTimeout(syncNativePlayerBounds, 0);
    setTimeout(syncNativePlayerBounds, 120);
  }
  function cancelPendingAutoCinema() {
    autoCinemaCandidate = false;
    autoCinemaSession = null;
    autoCinemaGeneration = 0;
  }
  function finishAutoCinema(playback) {
    if (!autoCinemaCandidate || autoCinemaSession !== playback) return false;
    var focusedOnPlayer = document.activeElement === document.getElementById('hero-feed-focus');
    var shouldEnter = window.HongguoAutoCinema.shouldEnter({
      platform: autoCinemaPlatform,
      enabled: autoCinemaEnabled,
      page: pageMode(),
      initialCardLaunch: true,
      firstFrame: true,
      focusedOnPlayer: focusedOnPlayer,
      userExited: false
    });
    cancelPendingAutoCinema();
    if (!shouldEnter) return false;
    setCinema(true);
    revealControls();
    return true;
  }
  function exitCinema(keepHidden) {
    fullscreenExitKeepsHidden = !!keepHidden;
    setCinema(false);
    if (desktopShell && window.go && window.go.main) window.go.main.desktopApp.SetFullscreen(false);
    else if (document.fullscreenElement && document.exitFullscreen) Promise.resolve(document.exitFullscreen()).catch(function () {});
  }
  function toggleCinema() {
    cancelPendingAutoCinema();
    if (shell.classList.contains('is-cinema')) exitCinema();
    else {
      setCinema(true);
      // Android already fills the display. Keep the CSS layout if the browser
      // Fullscreen API is unavailable; never fullscreen the video alone.
      if (desktopShell && window.go && window.go.main) window.go.main.desktopApp.SetFullscreen(true);
      else if (shell.requestFullscreen) Promise.resolve(shell.requestFullscreen()).catch(function () {});
    }
    revealControls();
  }
  function desktopFullscreenChanged(enabled) {
    if (!desktopShell) return;
    nativeFullscreen = !!enabled;
    setCinema(enabled);
    if (!enabled && fullscreenExitKeepsHidden) hideControls();
    fullscreenExitKeepsHidden = false;
  }
  function handleBack() {
    var current = typeof androidShell !== 'undefined' && androidShell ? remoteFocusTarget() || document.activeElement : document.activeElement;
    if (coreConnectionModalOpen) { closeCoreConnectionModal(true); return true; }
    if (autoCinemaCandidate) cancelPendingAutoCinema();
    if (endRecommendations && endRecommendations.close(true)) return true;
    if (searchSuggestionOpen) { closeSearchSuggestions(true); return true; }
    if (searchScanOpen) { closeSearchScan(true); return true; }
    if (typeof danmakuScanOpen !== 'undefined' && danmakuScanOpen) { closeDanmakuScan(true); return true; }
    if (accountCountryModalOpen) { closeAccountCountryModal(false); return true; }
    if (accountKeypadOpen()) { numericKeypad.close('back'); return true; }
    if (supportModalOpen) { closeSupportQR(); return true; }
    var playbackHint = document && typeof document.getElementById === 'function' ? document.getElementById('playback-menu-hint') : null;
    if (playbackHint && !playbackHint.classList.contains('is-hidden')) { if (typeof closePlaybackMenuHint === 'function') closePlaybackMenuHint(); return true; }
    if (followNotificationViewOpen) { closeFollowNotifications(); return true; }
    if (rankFilterOpen) { closeRankFilter(true); return true; }
    if (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) { closeActorWorks(true); return true; }
    if (detailCastOpen) { closeDetailCast(true); return true; }
    if (typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) { if (typeof closePlaybackCommandMenu === 'function') closePlaybackCommandMenu(true); return true; }
    if (confirmOpen) closeConfirmation();
    else if (playerOptionsOpen) closePlayerOptions();
    else if (detailModalOpen) closeDetail();
    else if (discussionOpen) closeDiscussion();
    else if (pageMode() === 'account' && accountQR && accountQR.snapshot().active) { cancelAccountQR(true); }
    else if (pageMode() === 'account' && accountData && accountData.phase === 'mfa') { cancelAccountVerification(true); }
    else if (shell.classList.contains('is-cinema')) {
      exitCinema(false);
      revealControls();
      goFocus(activeSidebar());
    }
    else if (isPlaybackPage() && zoneOf(current) !== 'sidebar' && !shell.classList.contains('is-controls-hidden')) hideControls();
    else if (pageMode() === 'player') leavePlayer();
    else if (zoneOf(current) !== 'sidebar') goFocus(activeSidebar());
    else return false;
    return true;
  }
  function handleMediaCommand(command) {
    if (endRecommendations && endRecommendations.isOpen()) return true;
    var video = document.getElementById('hero-video');
    if (applicationInBackground || !isPlaybackPage() || !video.getAttribute('src')) return false;
    if (command === 'toggle') toggleVideo();
    else if (command === 'play') playMedia(video).catch(function () { showNotice(uiText('ui.confirmToPlay', '请按确认键开始播放')); });
    else if (command === 'pause') video.pause();
    else if (command === 'forward') seekBy(10);
    else if (command === 'rewind') seekBy(-10);
    else return false;
    revealControls();
    return true;
  }
  function pauseForBackground() {
    if (accountQR && accountQR.snapshot().active) cancelAccountQR(false);
    if (typeof closePlaybackCommandMenu === 'function') closePlaybackCommandMenu(false);
    if (typeof closePlaybackMenuHint === 'function') closePlaybackMenuHint();
    if (searchScanOpen) closeSearchScan(true);
    if (typeof danmakuScanOpen !== 'undefined' && danmakuScanOpen) closeDanmakuScan(false);
    if (accountKeypadOpen()) numericKeypad.close('background');
    if (smsVerification) smsVerification.stop();
    var video = document.getElementById('hero-video');
    var preparing = playbackInfoRequest || playbackPrefetchHandoff || activePlayback && !video.getAttribute('src');
    applicationInBackground = true;
    resetEndRecommendations();
    clearLastPlaybackFrame();
    episodePrefetch.cancel();
    cancelPlaybackPreparation();
    cancelQualitySwitch();
    cancelSeasonSwitch();
    ++continuationGeneration;
    // An ended source may have started its detail request just before the
    // app was backgrounded. Keep that completed session eligible for one
    // foreground retry after the stale request settles.
    if (activePlayback && activePlayback.continuationPending && activePlayback.completed) activePlayback.endedPending = true;
    if (activePlayback && activePlayback.continuationPending) setPlayerStatus('');
    saveProgress(true);
    video.pause();
    if (preparing) setPlayerStatus(uiText('ui.playbackPausedRetry', '视频准备已暂停，请重试'), true);
    clearTimeout(controlsTimer);
  }
  function resumeFromBackground() {
    applicationInBackground = false;
    updatePlaybackControls();
    resumePendingContinuation(activePlayback);
    if (pageMode() === 'account' && document.activeElement && document.activeElement.closest('#account-keypad-modal')) goFocus(firstContentFocus());
    notificationCheck(false);
    flushNotificationPopup();
  }
  function resetPlayerUI() {
    cancelPendingAutoCinema();
    resetEndRecommendations();
    episodePrefetch.cancel(); cancelPlaybackPreparation();
    if (document.getElementById('hero-video').paused) releasePlaybackAudio();
    clearRangeTransitionHint();
    clearLastPlaybackFrame();
    document.getElementById('hero').classList.remove('is-range-transition');
    closeDiscussion(false); resetDanmaku();
    closePlayerOptions(false); clearTimeout(controlsTimer);
    shell.classList.remove('is-controls-hidden'); exitCinema();
    setPlayerStatus('');
  }
  function canShowAppUpdate() {
    var current = document.activeElement;
    return !applicationInBackground && !applicationHidden() && !isPlaybackPage() && !supportModalOpen && !detailModalOpen && !(typeof actorWorksOpen !== 'undefined' && actorWorksOpen) && !discussionOpen && !confirmOpen && !playerOptionsOpen && !accountBusy && !accountKeypadOpen() && !(current && /INPUT|TEXTAREA/.test(current.tagName));
  }
  // Old native IME callbacks are irrelevant to the app-owned numeric keypad.
  function openHomeProgram(program) {
    if (typeof program === 'string') {
      try { program = JSON.parse(program); } catch (error) { return false; }
    }
    var seriesID = String(program && program.series_id || '').trim();
    if (!/^[0-9]{1,32}$/.test(seriesID) || seriesID === '0') return false;
    var title = String(program && program.title || '').trim();
    if (!accountStatusInitialized) {
      pendingAccountHomeProgram = { series_id: seriesID, title: title.slice(0, 120), cardLaunch: true };
      pollAccount();
      return true;
    }
    startPlayer({ series_id: seriesID, title: title.slice(0, 120), intro: '', cover: '' }, null, { cardLaunch: true });
    return true;
  }
  function startPendingAccountHomeProgram() {
    if (!accountStatusInitialized || !pendingAccountHomeProgram) return;
    var program = pendingAccountHomeProgram;
    pendingAccountHomeProgram = null;
    startPlayer({ series_id: program.series_id, title: program.title, intro: '', cover: '' }, null, { cardLaunch: !!program.cardLaunch });
  }
  window.HongguoTV = { prepareExit: function () { pauseForBackground(); return libraryQueue.catch(function () {}); }, remoteKey: remoteKey, requestBack: handleBack, mediaCommand: handleMediaCommand, togglePlaybackCommandMenu: togglePlaybackCommandMenu, pauseForBackground: pauseForBackground, resumeFromBackground: resumeFromBackground, desktopFullscreenChanged: desktopFullscreenChanged, canShowAppUpdate: canShowAppUpdate, finishAccountEditing: function () {}, finishSearchEditing: function () { var current = typeof androidShell !== 'undefined' && androidShell ? remoteFocusTarget() || document.activeElement : document.activeElement; if (current === searchInput) goFocus(searchSuggestionOpen ? firstVisible('.search-suggestion') || firstSearchAction() || firstSearchFilter() : firstSearchAction() || firstSearchFilter()); }, openHomeProgram: openHomeProgram };

  function isLibraryPage() { return ['history', 'favorites', 'likes'].indexOf(pageMode()) >= 0; }
  function libraryEntry(id) { return libraryData.entries.filter(function (entry) { return entry.drama.series_id === id; })[0] || null; }
  function libraryTime(entry, kind) { return entry[({ history: 'last_played_at', favorites: 'favorite_at', likes: 'liked_at' })[kind]] || 0; }
  function resumeEpisode(entry, item) {
    if (!entry || !entry.last_played_at || !entry.episode) return 1;
    if (!entry.completed) return entry.episode;
    return item.episode_count && entry.episode >= item.episode_count ? 1 : entry.episode + 1;
  }
  function clockText(value) { value = Math.max(0, Math.floor(value || 0)); return Math.floor(value / 60) + ':' + ('0' + value % 60).slice(-2); }
  function likedEpisodeSummary(entry, drama) {
    var seen = {};
    var episodes = (entry && entry.liked_videos || []).map(function (liked) { return Number(liked && liked.episode) || 0; }).filter(function (episode) {
      if (episode < 1 || seen[episode]) return false;
      seen[episode] = true;
      return true;
    }).sort(function (a, b) { return a - b; });
    if (!episodes.length) return uiText('ui.liked', '已点赞');
    var shown = episodes.length > 4 ? episodes.slice(0, 3).join('、') + '等' + episodes.length + uiText('ui.episodesSuffix', '集') : episodes.join('、') + uiText('ui.episodesSuffix', '集');
    return uiText('ui.likeSummary', '赞了第{value}', { value: shown });
  }
  function basicDrama(item) {
    var result = {};
    ['series_id', 'title', 'cover', 'cover_fallback', 'intro', 'score', 'episode_count', 'tags', 'season_index', 'is_multi_season', 'content_type', 'video_category_type', 'following_update', 'followed', 'follow_count', 'show_update_frequency', 'latest_watched_episode', 'has_watched_latest_episode', 'series_status'].forEach(function (key) { if (item[key] !== undefined) result[key] = item[key]; });
    return result;
  }
  function followState(item) {
    var status = String(item && item.series_status !== undefined ? item.series_status : '').trim().toLowerCase();
    // The official model uses 0 for updating and 1 for completed. Text
    // values are accepted as a forward-compatible fallback for web payloads.
    if (status === '1' || /ended|finished|complete|completed|已完结|完结|已结束/.test(status)) return 'ended';
    if (status === '0' || /ongoing|serial|updating|连载|更新中/.test(status)) return 'ongoing';
    return 'unknown';
  }
  function followIsActive(item) {
    return !!(item && (item.following_update || item.followed));
  }
  function updateFollowButton() {
    var button = document.querySelector('.round-action[data-action="follow"]');
    if (!button) return;
    var active = followIsActive(featuredItem);
    var ended = followState(featuredItem) === 'ended';
    var wasFocused = document.activeElement === button;
    // A completed drama has no future episodes to follow. Hide the action
    // entirely so it does not consume space or remain in the TV focus chain.
    button.classList.toggle('is-hidden', ended);
    button.disabled = false;
    button.classList.toggle('is-disabled', false);
    button.setAttribute('aria-disabled', 'false');
    button.setAttribute('aria-hidden', String(ended));
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', ended ? uiText('ui.ended', '已完结') : active ? uiText('ui.followed', '已追更') : uiText('ui.follow', '追更'));
    var copy = button.querySelector('small');
    if (copy) copy.textContent = active ? uiText('ui.followed', '已追更') : uiText('ui.follow', '追更');
    if (ended && wasFocused) {
      var fallback = button.nextElementSibling || button.previousElementSibling;
      button.blur();
      if (fallback && typeof goFocus === 'function' && !fallback.disabled && !fallback.classList.contains('is-hidden')) goFocus(fallback);
    }
  }
  function updateSavedButtons() {
    var entry = featuredItem && libraryEntry(featuredItem.series_id);
    ['favorite', 'like'].forEach(function (kind) {
      var button = document.querySelector('.round-action[data-action="' + kind + '"]');
      var saved = kind === 'favorite' ? !!(entry && entry.favorite_at) : currentVideoLiked(featuredItem);
      button.classList.toggle('is-saved', saved);
      button.setAttribute('aria-pressed', String(saved));
      updateActionLabel(kind);
    });
    var follow = document.querySelector('.round-action[data-action="follow"]');
    if (follow) { var following = followIsActive(featuredItem); follow.classList.toggle('is-saved', following); }
    updateFollowButton();
  }
  function updateActionLabel(kind) {
    var button = document.querySelector('.round-action[data-action="' + kind + '"]');
    var saved = button.getAttribute('aria-pressed') === 'true';
    var label = kind === 'favorite' ? saved ? uiText('ui.favorited', '已收藏') : uiText('ui.favorite', '收藏') : kind === 'like' ? saved ? uiText('ui.liked', '已点赞') : uiText('ui.likes', '点赞') : uiText('ui.reviews', '评论');
    button.setAttribute('aria-label', label + ' · ' + button.querySelector('.action-count').textContent);
  }
  function currentVideoLiked(item) {
    var entry = item && libraryEntry(item.series_id);
    var session = playbackSnapshot();
    return !!(entry && session && item && session.series_id === item.series_id && (entry.liked_videos || []).some(function (liked) { return liked.video_id === session.vid; }));
  }
  function loadLibrary() {
    var ownerEpoch = accountEpoch;
    libraryError = '';
    return fetch('/api/v1/library')
      .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
      .then(function (payload) {
        if (ownerEpoch !== accountEpoch) return false;
        if (!payload.ok || !payload.data) throw new Error(apiError(payload, 200, 'ui.recordInvalid', '记录响应无效'));
        libraryData = payload.data;
        libraryLoaded = true;
        updateSavedButtons();
        updateDetailProgress();
        if (isLibraryPage()) renderLibrary(true);
        return true;
      }).catch(function (error) { libraryError = localizedError(error, 'ui.recordInvalid', '记录读取失败'); if (isLibraryPage()) renderLibrary(true); return false; });
  }
  function changeLibrary(change, quiet) {
    change.owner_id = libraryData.owner_id || '';
    var ownerEpoch = accountEpoch;
    var ready = libraryReady;
    var operation = libraryQueue.catch(function () {}).then(function () { return ready; }).then(function () {
      if (ownerEpoch !== accountEpoch) return false;
      return fetch('/api/v1/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
        .then(function (response) {
          return response.json().then(function (payload) { if (!response.ok || !payload.ok || !payload.data) throw new Error(apiError(payload, response.status, 'ui.recordSaveFailed', '记录保存失败')); return payload; });
        }).then(function (payload) {
          if (ownerEpoch !== accountEpoch || (payload.data.owner_id || '') !== (libraryData.owner_id || '')) return false;
          libraryData = payload.data;
          libraryLoaded = true;
          updateSavedButtons();
          var changedSeriesID = change.drama && change.drama.series_id || change.series_id;
          if (detailModalOpen && currentDetail && currentDetail.series_id === changedSeriesID) updateDetailActions();
          updateDetailProgress();
          if (isLibraryPage()) renderLibrary(!!quiet);
          return true;
        });
    });
    libraryQueue = operation;
    return operation.catch(function (error) { if (ownerEpoch === accountEpoch) showNotice(uiText(change.action === 'like' ? 'ui.likeFailed' : 'ui.localRecordFailed', change.action === 'like' ? '点赞未完成：{error}' : '本机记录未保存：{error}', { error: localizedError(error, 'common.operationFailed', '操作未完成，请重试。') })); return false; });
  }
  function toggleSaved(item, kind, button) {
    if (!item || !item.series_id || !libraryLoaded || button.disabled) return;
    var session = playbackSnapshot();
    if (kind === 'like') {
      if (!accountData || !accountData.logged_in) { showNotice(uiText('content.loginRequired', '请先到“我的 / 登录”登录红果账号')); return; }
      if (!session || session.series_id !== item.series_id) { showNotice(uiText('ui.chooseEpisodeToLike', '请先选择要点赞的播放集')); return; }
    }
    var entry = libraryEntry(item.series_id);
    var saved = kind === 'favorite' ? !!(entry && entry.favorite_at) : currentVideoLiked(item);
    var ownerEpoch = accountEpoch;
    var wasFocused = document.activeElement === button;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    var change = { action: kind, drama: basicDrama(item), value: !saved };
    if (kind === 'like') { change.video_id = session.vid; change.episode = session.episode; }
    changeLibrary(change).then(function (ok) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      var current = playbackSnapshot();
      var same = ownerEpoch === accountEpoch && featuredItem && featuredItem.series_id === item.series_id && (kind !== 'like' || current && current.vid === session.vid);
      if (same && wasFocused && document.activeElement === document.body && button.getClientRects().length) goFocus(button);
      if (ok && same) {
        if (session) engagement.adjust(kind, saved ? -1 : 1, session);
        showNotice(saved ? kind === 'favorite' ? uiText('ui.favoriteRemoved', '已取消收藏') : uiText('ui.episodeLikeRemoved', '已取消第{episode}集点赞', { episode: session.episode }) : kind === 'favorite' ? uiText('ui.favoriteAdded', '已收藏到本机') : uiText('ui.episodeLiked', '已点赞第{episode}集', { episode: session.episode }));
      }
    });
  }
  function toggleFollow(item, button) {
    if (!item || !item.series_id || !button || button.disabled) return;
    if (!accountData || !accountData.logged_in) { showNotice(uiText('ui.loginSimple', '请先到“我的”登录红果账号')); return; }
    if (followState(item) === 'ended' && !followIsActive(item)) { showNotice(uiText('ui.followEnded', '这部剧已经完结，不能新增追更')); return; }
    var enabled = button.getAttribute('aria-pressed') !== 'true';
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    fetchData('/api/v1/follow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ series_id: item.series_id, enabled: enabled }) }).then(function () {
      if (featuredItem && featuredItem.series_id === item.series_id) { featuredItem.following_update = enabled; featuredItem.followed = enabled; updateSavedButtons(); }
      if (currentDetail && currentDetail.series_id === item.series_id) {
        currentDetail.following_update = enabled;
        currentDetail.followed = enabled;
        updateDetailActions();
      }
      followPager.loaded = false; if (pageMode() === 'follows' && followView === 'follow') followPager.reset({});
      showNotice(enabled ? uiText('ui.followAdded', '已加入追更') : uiText('ui.followRemoved', '已取消追更'));
    }).catch(function (error) { showNotice(uiText('ui.followFailed', '追更操作未完成：{error}', { error: localizedError(error, 'common.operationFailed', '操作未完成，请重试。') })); }).then(function () { button.disabled = false; button.removeAttribute('aria-busy'); });
  }
  function libraryFinished(entry) {
    var total = Number(entry.drama && entry.drama.episode_count) || 0;
    // Mac history marks a drama finished once its saved episode reaches the last one.
    // completed is only for episode resume/auto-next and is absent in cloud history.
    return !!(entry.last_played_at && total > 0 && Number(entry.episode) >= total);
  }

  function visibleLibraryEntries(kind, filter) {
    var activeTypeFilter = typeof libraryTypeFilter === 'undefined' ? 'all' : libraryTypeFilter;
    var entries = libraryData.entries.filter(function (entry) {
      if (libraryTime(entry, kind) <= 0) return false;
      if (kind !== 'history' && activeTypeFilter !== 'all' && dramaType(entry.drama) !== activeTypeFilter) return false;
      if (kind !== 'history' || filter === 'all') return true;
      return libraryFinished(entry) === (filter === 'finished');
    });
    return entries.sort(function (a, b) { return libraryTime(b, kind) - libraryTime(a, kind); });
  }

  function selectHistoryFilter(value) {
    if (pageMode() !== 'history' || ['all', 'unfinished', 'finished'].indexOf(value) < 0) return;
    var changed = historyFilter !== value;
    historyFilter = value;
    renderLibrary(!changed);
    if (changed) libraryPage.scrollTop = 0;
    goFocus(firstVisible('.history-filter.is-active'));
    queueTailCheck();
  }

  function dramaType(item) {
    var value = String(item && (item.video_category_type || item.content_type) || '').toLowerCase();
    if (value.indexOf('ai') >= 0) return 'ai';
    if (value.indexOf('comic') >= 0 || value.indexOf('漫') >= 0) return 'comic';
    if (value.indexOf('real') >= 0 || value.indexOf('真人') >= 0) return 'real';
    return '';
  }
  function selectLibraryType(value) {
    if (!isLibraryPage() || ['all', 'real', 'comic', 'ai'].indexOf(value) < 0) return;
    libraryTypeFilter = value;
    document.querySelectorAll('.library-type-filter').forEach(function (button) {
      var selected = button.dataset.libraryType === value;
      button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected));
    });
    renderLibrary(false);
    goFocus(firstVisible('.library-type-filter.is-active'));
  }

  function renderLibrary(restoring) {
    var kind = pageMode();
    if (!isLibraryPage()) return;
    var label = ({ history: uiText('ui.history', '历史'), favorites: uiText('ui.favorite', '收藏'), likes: uiText('ui.likes', '点赞') })[kind];
    document.getElementById('library-title').textContent = kind === 'history' ? uiText('ui.watchHistory', '观看历史') : label;
    var libraryTabs = document.getElementById('library-tabs');
    if (libraryTabs) {
      var libraryTabbed = kind === 'favorites' || kind === 'likes';
      libraryTabs.classList.toggle('is-hidden', !libraryTabbed);
      libraryTabs.querySelectorAll('.library-tab').forEach(function (tab) {
        var selected = tab.dataset.libraryView === kind;
        tab.classList.toggle('is-active', selected);
        tab.setAttribute('aria-selected', String(selected));
      });
    }
    var storageLabel = libraryData.owner_id ? uiText('ui.accountCloud', '当前账号 · 云同步') : uiText('ui.localOnly', '保存在本机');
    document.getElementById('library-hint').textContent = storageLabel + (kind === 'history' ? uiText('ui.autoSaveProgress', ' · 自动记住集数和进度') : '');
    var filter = kind === 'history' ? historyFilter : 'all';
    document.getElementById('history-filters').classList.toggle('is-hidden', kind !== 'history');
    document.getElementById('library-type-filters').classList.toggle('is-hidden', kind === 'history');
    document.querySelectorAll('.history-filter').forEach(function (button) {
      var selected = button.dataset.historyFilter === filter;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    document.querySelectorAll('.library-type-filter').forEach(function (button) { button.classList.toggle('is-active', button.dataset.libraryType === libraryTypeFilter); });
    var grid = document.getElementById('library-grid');
    var entries = visibleLibraryEntries(kind, filter);
    var existing = {};
    Array.prototype.forEach.call(grid.children, function (tile, index) { existing[tile.dataset.seriesId] = { tile: tile, index: index }; });
    if (restoring) entries.sort(function (a, b) { return (existing[a.drama.series_id] ? existing[a.drama.series_id].index : 10000) - (existing[b.drama.series_id] ? existing[b.drama.series_id].index : 10000); });
    var totalEntries = entries.length;
    var sameView = libraryPager.params.kind === kind && libraryPager.params.filter === filter;
    var count = sameView ? Math.max(20, libraryPager.items.length) : 20;
    if (!sameView) libraryPager.cancel();
    libraryPager.params.kind = kind; libraryPager.params.filter = filter;
    libraryPager.local(entries.map(function (entry) { return entry.drama; }), count);
    entries = entries.slice(0, count);
    var current = document.activeElement;
    var currentTile = current.closest && current.closest('.library-tile');
    var priorIndex = currentTile && existing[currentTile.dataset.seriesId] ? existing[currentTile.dataset.seriesId].index : 0;
    var keep = {};
    entries.forEach(function (entry, index) {
      var id = entry.drama.series_id;
      var tile = existing[id] ? existing[id].tile : document.createElement('div');
      if (!existing[id]) {
        tile.className = 'library-tile';
        tile.dataset.seriesId = id;
        var card = document.createElement('button');
        card.className = 'library-card';
        card.dataset.focus = 'library-' + id;
        var image = document.createElement('img'); image.loading = 'lazy';
        var poster = dramaPoster(image, entry.drama);
        var likeBadge = document.createElement('span'); likeBadge.className = 'library-card-like-badge'; likeBadge.setAttribute('aria-hidden', 'true'); poster.appendChild(likeBadge);
        card.appendChild(poster);
        ['title', 'meta', 'time'].forEach(function (name) { var span = document.createElement('span'); span.className = 'library-card-' + name; card.appendChild(span); });
        var progress = document.createElement('span'); progress.className = 'library-progress'; progress.appendChild(document.createElement('span')); card.appendChild(progress);
        card.addEventListener('click', function () { if (libraryEditing) goFocus(tile.querySelector('.library-remove')); else startPlayer(tile.__entry.drama, card); });
        card.addEventListener('focus', function () { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
        tile.appendChild(card);
        var remove = document.createElement('button'); remove.className = 'library-remove'; remove.dataset.focus = 'library-remove-' + id; remove.textContent = uiText('ui.remove', '移除');
        remove.addEventListener('click', function () {
          var kind = pageMode();
          var index = Array.prototype.indexOf.call(grid.children, tile);
          var wasFocused = document.activeElement === remove;
          remove.disabled = true;
          changeLibrary({ action: 'remove', kind: kind, series_id: id }).then(function (ok) {
            remove.disabled = false;
            if (ok && wasFocused && pageMode() === kind && document.activeElement === document.body) {
              var cards = focusables('.library-card');
              goFocus(cards[Math.min(index, cards.length - 1)] || firstVisible('[data-action="library-discover"]'));
            }
          });
        });
        tile.appendChild(remove);
      }
      tile.__entry = entry;
      keep[id] = true;
      var card = tile.querySelector('.library-card');
      if (card.querySelector('img').alt !== entry.drama.title) setCover(card.querySelector('img'), entry.drama);
      updatePosterSeason(card.querySelector('.drama-poster'), entry.drama);
      var likeBadge = card.querySelector('.library-card-like-badge');
      likeBadge.classList.toggle('is-hidden', kind !== 'likes');
      if (kind === 'likes') likeBadge.textContent = likedEpisodeSummary(entry, entry.drama);
      card.querySelector('.library-card-title').textContent = entry.drama.title;
      card.querySelector('.library-card-meta').textContent = entry.last_played_at ? libraryFinished(entry) ? uiText('ui.watchedAll', '已看完 · 全{count}集', { count: entry.drama.episode_count }) : uiText('ui.continueEpisode', '继续第{episode}集', { episode: resumeEpisode(entry, entry.drama) }) + (!entry.completed && entry.position ? ' · ' + clockText(entry.position) : '') : entry.drama.episode_count ? uiText('content.episodeCount', '全{count}集', { count: entry.drama.episode_count }) : uiText('ui.startFirstEpisode', '从第一集播放');
      card.querySelector('.library-card-time').textContent = new Date(libraryTime(entry, kind)).toLocaleDateString();
      card.querySelector('.library-progress').classList.toggle('is-hidden', !entry.last_played_at || !entry.duration);
      card.querySelector('.library-progress > span').style.width = Math.min(100, entry.duration ? entry.position / entry.duration * 100 : 0) + '%';
      tile.querySelector('.library-remove').classList.toggle('is-hidden', !libraryEditing);
      if (grid.children[index] !== tile) grid.insertBefore(tile, grid.children[index] || null);
    });
    Array.prototype.slice.call(grid.children).forEach(function (tile) { if (!keep[tile.dataset.seriesId]) tile.remove(); });
    document.getElementById('library-count').textContent = totalEntries ? uiText('ui.libraryCount', '{total} 部 · 已显示 {shown} 部', { total: totalEntries, shown: entries.length }) : '';
    document.getElementById('library-manage').textContent = libraryError ? uiText('common.retry', '重试') : libraryEditing ? uiText('ui.done', '完成') : uiText('ui.manage', '管理');
    document.getElementById('library-manage').disabled = !libraryError && !entries.length;
    document.getElementById('library-clear').disabled = !entries.length;
    document.getElementById('library-empty').classList.toggle('is-hidden', entries.length > 0);
    document.getElementById('library-empty-title').textContent = libraryError ? uiText('ui.libraryReadFailed', '读取本机记录失败') : !libraryLoaded ? uiText('ui.readingLocalLibrary', '正在读取本机记录…') : kind === 'history' ? filter === 'finished' ? uiText('ui.noFinished', '还没有已看完的短剧') : filter === 'unfinished' ? uiText('ui.noUnfinished', '没有未看完的短剧') : uiText('ui.noHistory', '还没有观看记录') : uiText('ui.noLibraryItems', '还没有{label}的短剧', { label: label });
    document.getElementById('library-empty-copy').textContent = libraryError || (kind === 'history' ? filter === 'finished' ? uiText('ui.libraryFinishedHint', '看到最后一集的短剧会显示在这里') : filter === 'unfinished' ? uiText('ui.libraryUnfinishedHint', '可以切换到“全部”查看观看记录') : uiText('ui.libraryStartHint', '开始播放后，会自动保存集数和进度') : uiText('ui.libraryActionHint', '在播放页点{label}，以后可从这里继续观看', { label: label }));
    if (currentTile && !document.contains(current)) {
      var cards = focusables('.library-card');
      goFocus(cards[Math.min(priorIndex, cards.length - 1)] || firstVisible('.history-filter.is-active') || firstVisible('[data-action="library-discover"]'));
    } else if (currentTile && document.activeElement !== current) {
      goFocus(current);
    }
  }
  function closeConfirmation() {
    ++confirmationGeneration;
    confirmOpen = false;
    confirmOperation = null;
    document.getElementById('confirm-modal').classList.add('is-hidden');
    document.getElementById('confirm-modal').setAttribute('aria-hidden', 'true');
    document.getElementById('confirm-accept').classList.remove('confirm-reserve');
    document.getElementById('confirm-accept').classList.add('confirm-danger');
    document.getElementById('confirm-cancel').textContent = uiText('common.cancel', '取消');
    var target = confirmReturnFocus;
    confirmReturnFocus = null;
    var afterClose = confirmAfterClose;
    confirmAfterClose = null;
    goFocus(target && focusables().indexOf(target) >= 0 ? target : firstContentFocus());
    if (afterClose) afterClose();
    flushEndRecommendations();
  }
  function confirmClearLibrary() {
    ++confirmationGeneration;
    var kind = pageMode();
    var label = ({ history: uiText('ui.history', '历史'), favorites: uiText('ui.favorite', '收藏'), likes: uiText('ui.likes', '点赞') })[kind];
    confirmReturnFocus = document.activeElement;
    confirmOperation = function () { return changeLibrary({ action: 'clear', kind: kind }); };
    confirmOpen = true;
    document.getElementById('confirm-title').textContent = uiText('ui.clearAll', '清空全部{label}？', { label: label });
    document.getElementById('confirm-accept').textContent = uiText('ui.clear', '清空');
    document.getElementById('confirm-copy').textContent = kind === 'history' ? uiText('content.clearLibraryHistoryCopy', '观看进度也会移除，收藏和点赞会保留。') : uiText('content.clearLibraryCopy', '只清空本机{label}，观看历史和其它记录会保留。', { label: label });
    document.getElementById('confirm-modal').classList.remove('is-hidden');
    document.getElementById('confirm-modal').setAttribute('aria-hidden', 'false');
    goFocus(document.getElementById('confirm-cancel'));
  }

  function setCatalogHeading(text) {
    document.getElementById('catalog-heading').textContent = text || uiText('ui.hotDrama', '热播短剧');
  }

  function acceptAccountStatus(data) {
    var previous = accountData;
    var wasInitialized = accountStatusInitialized;
    var owner = data.profile && data.profile.uid || '';
    var previousOwner = previous && previous.profile && previous.profile.uid || '';
    accountData = data;
    accountStatusInitialized = true;
    if (data.country_code) setAccountPhoneCountry(data.country_code, false);
    updateFollowNotificationAccess();
    if (smsVerification) smsVerification.setSession(!data.logged_in && data.phase === 'mfa' && data.mfa_expires_at ? { key: String(data.mfa_expires_at) + ':' + (data.sms_number || '') + ':' + (data.sms_content || ''), expiresAt: data.mfa_expires_at } : null);
    accountCountdownUntil = Date.now() + (data.retry_after || 0) * 1000;
    if (owner !== previousOwner || owner !== (libraryData.owner_id || '')) {
      ++accountEpoch;
      resetEndRecommendations();
      notificationKnownKey = '';
      notificationLastCheck = 0;
      notificationPopupQueue = [];
      if (typeof notificationHidePopup === 'function') notificationHidePopup();
      recommendationSession = null;
      if (engagement) engagement.resetAccount();
      episodePrefetch.cancel();
      var interruptedPlayback = playbackInfoRequest || playbackPrefetchHandoff || activePlayback && document.getElementById('hero').classList.contains('is-preparing-video');
      cancelPlaybackPreparation();
      if (interruptedPlayback && pageMode() === 'player') { document.getElementById('hero-video').pause(); setPlayerStatus(uiText('ui.accountChangedRetry', '账号已切换，请重试播放'), true); }
      resetSeasonCatalog();
      reservationOverrides = Object.create(null);
      reservationCounts = { online: null, upcoming: null }; updateReservationCounts({});
      resetSeriesPanel();
      if (detailModalOpen && detailTab === 'series') { loadSeriesSeasons(); goFocus(document.getElementById('detail-tab-series')); }
      if (confirmOpen) closeConfirmation();
      closePlayerOptions(false);
      allPagers.forEach(function (pager) { pager.cancel(); pager.loaded = false; pager.items = []; pager.buffer = []; if (pager.container) pager.container.innerHTML = ''; });
      closeDiscussion(false); resetDanmaku();
      discussionDrafts = {}; danmakuDrafts = {};
      calendarSchema = null;
      if (pageMode() === 'follows' && followView === 'reservations') renderReservations(reservationMode);
      else if (pageMode() === 'follows') {
        if (data.logged_in) followPager.reset({});
        else renderMessage(followGrid, 'list-empty', uiText('ui.followLogin', '登录红果账号后查看追更。'));
      }
      else if (pageMode() === 'new') { if (newMode === 'calendar') loadCalendar(); else loadNew(); }
      else if (pageMode() === 'rank') loadRank();
      else if (pageMode() === 'search') { if (searchKind === 'keyword') submitSearch(); else loadBrowse(false, !filterRows.length); }
      else if (pageMode() === 'recommend') loadCatalog(activeChannel().textContent);
      historyFilter = 'all';
      libraryData = { entries: [], owner_id: owner };
      libraryLoaded = false;
      libraryReady = libraryQueue.catch(function () {}).then(loadLibrary);
      updateSavedButtons();
      updateDetailProgress();
    } else if (data.logged_in && data.sync && previous && previous.sync && data.sync.last_sync !== previous.sync.last_sync) {
      libraryQueue.catch(function () {}).then(loadLibrary);
    }
    renderAccount();
    if (!wasInitialized) startPendingAccountHomeProgram();
  }
  function renderAccount() {
    var data = accountData || { phase: 'phone', logged_in: false, sync: { state: 'local' } };
    if (accountKeypadOpen() && (data.logged_in || data.phase !== accountKeypadPhase || accountBusy)) numericKeypad.close('context');
    var logged = !!data.logged_in;
    var mfa = !logged && data.phase === 'mfa';
    var canSubmitAppCode = !!data.app_code_available;
    var codePhase = data.phase === 'code' || canSubmitAppCode;
    var verification = smsVerification ? smsVerification.snapshot() : { state: 'idle', remaining: 0 };
    var mfaExpired = mfa && (verification.state === 'expired' || data.mfa_expires_at && Date.now() >= data.mfa_expires_at);
    document.getElementById('account-login-form').classList.toggle('is-hidden', logged || mfa);
    document.getElementById('account-profile').classList.toggle('is-hidden', !logged);
    document.getElementById('account-mfa').classList.toggle('is-hidden', !mfa);
    document.getElementById('account-code-field').classList.toggle('is-hidden', !codePhase);
    document.getElementById('account-login').classList.toggle('is-hidden', !codePhase);
    document.getElementById('account-change-phone').classList.toggle('is-hidden', !codePhase);
    var phoneInput = document.getElementById('account-phone');
    document.querySelectorAll('.account-input').forEach(function (node) { node.disabled = accountBusy; renderAccountNumber(node); });
    document.getElementById('account-country').disabled = accountBusy || codePhase;
    phoneInput.disabled = accountBusy || codePhase && accountPhoneValid(phoneInput.value) && !(accountKeypadOpen() && numericKeypad.snapshot().kind === 'phone');
    document.querySelectorAll('#account-page .account-action').forEach(function (node) { node.disabled = accountBusy; });
    document.getElementById('account-cancel').disabled = false;
    document.getElementById('account-verify').disabled = accountBusy || mfaExpired || verification.state === 'waiting';
    document.getElementById('account-verify').textContent = verification.state === 'waiting' ? uiText('ui.waitingConfirm', '等待确认…') : verification.state === 'timeout' ? uiText('ui.queryAgain', '再次查询') : uiText('ui.sent', '我已发送');
    document.getElementById('account-cancel').textContent = mfaExpired ? uiText('ui.getCodeAgain', '重新获取验证码') : uiText('ui.cancelVerification', '取消验证');
    document.getElementById('account-mfa-session').textContent = mfaExpired ? uiText('ui.verificationExpired', '本机验证等待时间已结束，请重新获取验证码。') : mfa && data.mfa_expires_at ? uiText('ui.verificationRemaining', '本机验证等待剩余 {value}，红果也可能提前要求重新验证。', { value: clockText(Math.ceil((data.mfa_expires_at - Date.now()) / 1000)) }) : '';
    document.getElementById('account-mfa-wait').textContent = verification.state === 'waiting' ? uiText('ui.smsWaiting', '正在等待短信确认 · 本轮剩余 {value} 秒', { value: verification.remaining }) : verification.state === 'timeout' ? uiText('ui.smsWaitEnded', '本轮等待已结束。会话仍有效时可以再次查询，无需重复发送短信。') : '';
    document.getElementById('account-change-phone').disabled = false;
    var remaining = Math.max(0, Math.ceil((accountCountdownUntil - Date.now()) / 1000));
    var send = document.getElementById('account-send-code');
    send.disabled = accountBusy || remaining > 0;
    send.textContent = remaining > 0 ? (codePhase && data.sms_state === 'sent' ? uiText('ui.resendIn', '{value} 秒后重发', { value: remaining }) : uiText('ui.retryIn', '{value} 秒后可重试', { value: remaining })) : codePhase ? canSubmitAppCode ? uiText('ui.retryGetCode', '重新获取验证码') : uiText('ui.resend', '重新发送') : uiText('ui.getCode', '获取验证码');
    document.getElementById('account-sync').disabled = !logged || accountBusy || data.sync && data.sync.state === 'syncing';
    var guestHistory = data.guest_history || {};
    document.getElementById('account-import-history').disabled = !logged || accountBusy || !(guestHistory.available > 0);
    document.getElementById('account-import-detail').textContent = !logged ? uiText('ui.mergeLocalHistory', '登录后可将本机观看历史合并到当前账号。') : guestHistory.available > 0 ? uiText('ui.mergeAvailable', '有 {value} 部登录前观看的短剧可合并。', { value: guestHistory.available }) : guestHistory.total > 0 ? uiText('ui.mergeNone', '没有待合并的新记录；已合并、删除或较旧的进度不会重复加入。') : uiText('ui.noGuestHistory', '本机暂无登录前的观看历史。');
    if (logged) {
      document.getElementById('account-name').textContent = data.profile.name;
      document.getElementById('account-phone-mask').textContent = data.profile.phone || '';
    }
    document.getElementById('account-sms-number').textContent = data.sms_number || '';
    document.getElementById('account-sms-content').textContent = data.sms_content || '';
    var smsImage = document.getElementById('account-sms-qr-image');
    var smsQR = !desktopShell && mfa && !mfaExpired && /^data:image\/png;base64,/.test(data.sms_qr || '') ? data.sms_qr : '';
    if (smsImage.getAttribute('src') !== smsQR) {
      if (smsQR) smsImage.setAttribute('src', smsQR); else smsImage.removeAttribute('src');
    }
    document.getElementById('account-sms-qr').classList.toggle('is-hidden', !smsQR);
    document.getElementById('account-sms-qr-help').classList.toggle('is-hidden', !smsQR);
    document.getElementById('account-sms-qr').disabled = false;
    if (supportModalOpen && supportReturnFocus && supportReturnFocus.id === 'account-sms-qr' && !smsQR) closeSupportQR();
    var sync = data.sync || {};
    var syncLabel = !logged ? uiText('ui.notLoggedInLocal', '未登录 · 记录保存在本机') : ({ syncing: uiText('ui.syncing', '正在同步…'), pending: uiText('ui.syncPending', '等待同步'), error: uiText('ui.syncIncomplete', '同步暂未完成'), idle: sync.last_sync ? uiText('ui.synced', '已同步') : uiText('ui.notSynced', '尚未同步') })[sync.state] || uiText('ui.syncPending', '等待同步');
    document.getElementById('account-sync-state').textContent = syncLabel;
    document.getElementById('account-sync-detail').textContent = sync.error ? localizedError(sync.error, 'ui.syncIncomplete', '同步暂未完成') : (logged ? (sync.pending ? uiText('ui.pendingRecords', '{value} 项记录待同步。', { value: sync.pending }) : uiText('ui.autoSync', '收藏、点赞与观看进度会自动同步。')) + (sync.last_sync ? uiText('ui.lastSync', ' 最近同步：{value}', { value: new Date(sync.last_sync).toLocaleTimeString() }) : '') : uiText('ui.loginSyncCopy', '收藏、点赞、观看历史和播放进度会与红果账号同步。'));
    renderAccountQR();
    renderAccountMessages(data, canSubmitAppCode);
    document.querySelector('.side-item[data-page="account"] span:last-child').textContent = uiText('nav.account', '我的');
    if (pageMode() === 'account') document.getElementById('page-context').textContent = uiText('nav.account', '我的');
    var current = document.activeElement;
    if (!accountKeypadOpen() && !accountBusy && pageMode() === 'account' && current && current.closest('#account-keypad-modal')) goFocus(firstContentFocus());
    if (!accountBusy && !confirmOpen && pageMode() === 'account' && current && /accountInputs|accountActions/.test(zoneOf(current)) && focusables().indexOf(current) < 0) goFocus(firstContentFocus());
  }
  function renderAccountQR() {
    var data = accountData || {}, qr = accountQR ? accountQR.snapshot() : { active: false };
    var available = !webosShell && !!data.qr_login_available && !data.logged_in;
    var visible = available && accountLoginMethod === 'qr';
    document.getElementById('account-login-methods').classList.toggle('is-hidden', !available);
    document.getElementById('account-qr-panel').classList.toggle('is-hidden', !visible);
    if (visible) { document.getElementById('account-login-form').classList.add('is-hidden'); document.getElementById('account-mfa').classList.add('is-hidden'); }
    ['phone', 'qr'].forEach(function (method) {
      var node = document.getElementById('account-method-' + method), selected = method === 'qr' ? visible : !visible;
      node.classList.toggle('is-active', selected); node.setAttribute('aria-pressed', selected ? 'true' : 'false'); node.disabled = accountBusy;
    });
    var image = document.getElementById('account-login-qr-image');
    var source = visible && /^data:image\/png;base64,/.test(qr.image || '') ? qr.image : '';
    if (image.getAttribute('src') !== source) { if (source) image.src = source; else image.removeAttribute('src'); }
    image.classList.toggle('is-hidden', !source);
    var keys = { idle: 'qrPreparing', preparing: 'qrPreparing', pending: 'qrPending', scanned: 'qrScanned', processing: 'qrProcessing', expired: 'qrExpired', cancelled: 'qrCancelled', failed: 'qrFailed', signed_in: 'qrSignedIn' };
    document.getElementById('account-login-qr-status').textContent = visible ? uiText('account.' + (qr.error && qr.state !== 'failed' ? 'qrNetwork' : keys[qr.state] || 'qrPending')) : '';
    var seconds = Math.max(0, Math.ceil(((qr.expires_at || 0) - Date.now()) / 1000));
    document.getElementById('account-login-qr-expiry').textContent = visible && seconds && ['pending', 'scanned'].indexOf(qr.state) >= 0 ? uiText('account.qrExpiry', '', { value: seconds }) : '';
    document.getElementById('account-qr-cancel').disabled = false;
    document.getElementById('account-qr-refresh').disabled = false;
    // Get the first QR only when the user actually enters the account page.
    if (visible && qr.state === 'idle' && pageMode() === 'account') startAccountQR();
  }
  function cancelAccountQR(restoreFocus) {
    if (accountQR) accountQR.cancel();
    renderAccount();
    if (restoreFocus && pageMode() === 'account') goFocus(document.getElementById(accountLoginMethod === 'qr' ? 'account-method-qr' : 'account-method-phone'));
  }
  function startAccountQR() {
    if (!accountQR || accountBusy || webosShell || !accountData || !accountData.qr_login_available || accountData.logged_in) return;
    if (smsVerification) smsVerification.stop();
    if (accountKeypadOpen()) numericKeypad.close('context');
    accountLoginMethod = 'qr';
    ++accountRequestGeneration; accountBusy = false; accountNotice = '';
    accountQR.start();
    goFocus(document.getElementById('account-qr-refresh'));
  }
  function accountFailureText(error) {
    var detail = error && typeof error === 'object' ? error.message : error;
    return detail ? uiText('ui.accountErrorDetail', '错误详情（原文）：{detail}', { detail: String(detail) }) : uiText('ui.accountRequestFailed', '账号请求失败');
  }
  function renderAccountMessages(data, canSubmitAppCode) {
    document.getElementById('account-message').textContent = accountBusy ? uiText('ui.connectingAccount', '正在连接红果，请稍候…') : accountNotice ? (accountNoticeIsError ? accountFailureText(accountNotice) : accountNotice) : data.error ? accountFailureText(data.error) : '';
    var showHelp = canSubmitAppCode && !data.logged_in && data.phase !== 'mfa';
    var prehint = document.getElementById('account-app-code-prehint');
    var showPrehint = accountPhoneCountryCode !== '+86' && !data.logged_in && data.phase !== 'mfa' && !showHelp;
    prehint.classList.toggle('is-hidden', !showPrehint);
    prehint.textContent = showPrehint ? uiText('ui.appCodePrehint', '境外号码若无法收取验证码，可尝试用手机红果 App 获取。') : '';
    var help = document.getElementById('account-app-code-help');
    help.classList.toggle('is-hidden', !showHelp);
    document.getElementById('account-app-code-title').textContent = showHelp ? uiText('ui.appCodeFallbackTitle', '用红果短剧 App 获取验证码') : '';
    document.getElementById('account-app-code-step-1').textContent = showHelp ? uiText('ui.appCodeFallbackStep1', '打开手机上的「红果短剧」App，进入登录页，选择相同区号，输入本页同一手机号并获取验证码。如需滑块验证，请在手机 App 内完成。') : '';
    document.getElementById('account-app-code-step-2').textContent = showHelp ? uiText('ui.appCodeFallbackStep2', '收到短信后不要在手机 App 内填写验证码；回到本应用，在上方“验证码”框输入并点“登录”。') : '';
    document.getElementById('account-app-code-step-3').textContent = showHelp ? uiText('ui.appCodeFallbackStep3', '验证码通常几分钟内有效；过期后在手机 App 重新获取。') : '';
    var feedback = document.getElementById('account-feedback');
    var target = document.getElementById(data.logged_in ? 'account-profile' : data.phase === 'mfa' ? 'account-mfa' : 'account-login-form');
    // Above the code field, the instructions stay visible when TV focus
    // scrolls that field into view. MFA/profile feedback follows its own form.
    if (feedback.parentNode !== target) target.insertBefore(feedback, !data.logged_in && data.phase !== 'mfa' ? document.getElementById('account-code-field') : null);
    feedback.classList.toggle('is-hidden', !document.getElementById('account-message').textContent && !showHelp);
  }
  function setAccountMessage(message, isError) { accountNotice = message; accountNoticeIsError = !!isError; renderAccount(); }
  if (window.HongguoI18n && typeof window.HongguoI18n.onChange === 'function') window.HongguoI18n.onChange(function () {
    renderAccountMessages(accountData || {}, !!(accountData && accountData.app_code_available));
  });
  function pollAccount() {
    if (accountPollBusy || accountBusy) return Promise.resolve();
    accountPollBusy = true;
    var epoch = accountEpoch;
    var generation = accountRequestGeneration;
    return fetch('/api/v1/account').then(function (response) { return response.json(); }).then(function (payload) {
      if (epoch !== accountEpoch || generation !== accountRequestGeneration || accountBusy) return;
      if (!payload.ok || !payload.data) throw new Error(apiError(payload, 200, 'ui.accountStateFailed', '账号状态读取失败'));
      acceptAccountStatus(payload.data);
      notificationCheck(false);
    }).catch(function (error) { if (pageMode() === 'account') setAccountMessage(localizedError(error, 'ui.accountStateFailed', '账号状态读取失败')); })
      .then(function () { accountPollBusy = false; });
  }
  function accountRequest(action, value, signal) {
    if (accountBusy && action !== 'cancel') return Promise.resolve(false);
    var returnFocus = document.activeElement;
    function restoreRequestFocus() {
      if (pageMode() === 'account' && !confirmOpen && document.activeElement === document.body) goFocus(focusables().indexOf(returnFocus) >= 0 ? returnFocus : firstContentFocus());
    }
    accountBusy = true;
    accountNotice = '';
    accountNoticeIsError = false;
    var generation = ++accountRequestGeneration;
    var accountHTTPStatus = 0;
    function aborted() {
      if (generation !== accountRequestGeneration) return;
      ++accountRequestGeneration; accountBusy = false; renderAccount(); restoreRequestFocus();
    }
    if (signal) signal.addEventListener('abort', aborted);
    renderAccount();
    return fetch('/api/v1/account/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value || {}), signal: signal })
      .then(function (response) { accountHTTPStatus = response.status; return response.json(); }).then(function (payload) {
        if (generation !== accountRequestGeneration) return false;
        accountBusy = false;
        if (payload.data) acceptAccountStatus(payload.data);
        restoreRequestFocus();
        if (!payload.ok) throw new Error(typeof payload.error === 'string' && payload.error ? payload.error : apiError(payload, accountHTTPStatus, 'ui.accountRequestFailed', '账号请求失败'));
        if (action === 'import-history' && payload.import_history && payload.data && payload.data.profile && payload.data.profile.uid === value.owner_id) {
          var imported = payload.import_history;
          setAccountMessage(imported.imported > 0 ? uiText('ui.merged', '已合并 {value} 部短剧。', { value: imported.imported }) + (imported.remaining > 0 ? uiText('ui.mergeRemaining', '还有 {value} 部待合并，请完成同步后再试。', { value: imported.remaining }) : uiText('ui.mergeWillRetry', '将自动同步到当前账号，网络恢复后会重试。')) : uiText('ui.noMergeNeeded', '没有需要合并的新记录。'));
        }
        return true;
      }).catch(function (error) {
        if (generation !== accountRequestGeneration) return false;
        accountBusy = false; renderAccount();
        setAccountMessage(error.message || uiText('ui.accountRequestFailed', '账号请求失败'), true);
        restoreRequestFocus();
        return false;
      }).then(function (ok) { if (signal) signal.removeEventListener('abort', aborted); return ok; });
  }
  function accountSendCode() {
    var phone = document.getElementById('account-phone').value.trim();
    if (!accountPhoneValid(phone)) { setAccountMessage(uiText('content.phoneInvalid', '请输入正确的{country}手机号', { country: phoneCountryName(accountPhoneCountry()) })); goFocus(document.getElementById('account-phone')); return; }
    accountRequest('send-code', { phone: phone, country_code: accountPhoneCountryCode }).then(function (ok) {
      if (pageMode() === 'account') goFocus(ok || accountData && accountData.app_code_available ? document.getElementById('account-code') : firstVisible('.account-input'));
    });
  }
  function accountLogin() {
    var phone = document.getElementById('account-phone').value.trim();
    var code = document.getElementById('account-code').value.trim();
    if (!/^\d{4,8}$/.test(code)) { setAccountMessage(uiText('ui.smsCodeRequired', '请输入短信验证码')); goFocus(document.getElementById('account-code')); return; }
    accountRequest('login', { phone: phone, country_code: accountPhoneCountryCode, code: code }).then(function (ok) {
      if (!ok) { if (pageMode() === 'account') goFocus(document.getElementById('account-code')); return; }
      document.getElementById('account-code').value = '';
      renderAccountNumber(document.getElementById('account-code'));
      if (pageMode() === 'account') goFocus(accountData.logged_in ? document.getElementById('account-logout') : document.getElementById('account-verify'));
    });
  }
  function cancelAccountVerification(returnToSidebar) {
    if (smsVerification) smsVerification.stop();
    return accountRequest('cancel').then(function () {
      document.getElementById('account-code').value = '';
      renderAccountNumber(document.getElementById('account-code'));
      if (pageMode() === 'account') goFocus(returnToSidebar === true ? activeSidebar() : document.getElementById('account-phone'));
    });
  }
  function verifyAccountSMS() {
    if (accountBusy) return;
    if (smsVerification) smsVerification.start();
  }
  function confirmAccountLogout() {
    ++confirmationGeneration;
    confirmReturnFocus = document.activeElement;
    confirmOperation = function () {
      if (smsVerification) smsVerification.stop();
      return accountRequest('logout').then(function (ok) {
        if (ok) document.querySelectorAll('.account-input').forEach(function (field) { field.value = ''; renderAccountNumber(field); });
        return ok;
      });
    };
    confirmOpen = true;
    document.getElementById('confirm-title').textContent = uiText('ui.logoutTitle', '退出当前账号？');
    document.getElementById('confirm-accept').textContent = uiText('ui.logout', '退出');
    document.getElementById('confirm-copy').textContent = uiText('ui.logoutCopy', '云端记录会保留。待同步记录留在当前账号的本机目录，再次登录这个账号后继续同步。退出后显示登录前的本机记录。');
    document.getElementById('confirm-modal').classList.remove('is-hidden');
    document.getElementById('confirm-modal').setAttribute('aria-hidden', 'false');
    goFocus(document.getElementById('confirm-cancel'));
  }

  function catalogMeta(item) {
    var values = [];
    if (item.episode_count) values.push(uiText('content.episodeCount', '全{count}集', { count: item.episode_count }));
    if (item.score) values.push(item.score + ' ' + uiText('ui.scoreSuffix', '分'));
    return values.join(' · ') || uiText('app.name', '红果短剧');
  }

  function setCover(image, item) {
    image.alt = item.title || '';
    var source = item.cover_fallback || item.cover || '';
    if (image.getAttribute('src') === source && image.complete && image.naturalWidth) return;
    var generation = image.__coverGeneration = (image.__coverGeneration || 0) + 1;
    image.classList.remove('is-empty');
    image.classList.add('is-cover-pending');
    image.onload = function () {
      // Let the reserved poster box settle before showing decoded pixels.
      requestAnimationFrame(function () {
        if (image.__coverGeneration === generation) image.classList.remove('is-cover-pending');
      });
    };
    image.onerror = function () {
      image.removeAttribute('src'); image.alt = ''; image.classList.add('is-empty');
    };
    if (source) image.src = source;
    else image.onerror();
  }

  function clearBackdrop(backdrop, poster) {
    if (!backdrop) return;
    backdrop.__coverLoader = null;
    backdrop.__coverSource = '';
    [backdrop, poster].filter(Boolean).forEach(function (layer) {
      layer.style.backgroundImage = 'none';
      layer.classList.add('is-cover-pending');
    });
  }
  function setBackdrop(backdrop, item, poster, retainPrevious) {
    var source = item.cover_fallback || item.cover || '';
    if (backdrop.__coverSource === source) return;
    backdrop.__coverSource = source;
    var layers = poster ? [backdrop, poster] : [backdrop];
    // During a same-series switch the previous poster is already a valid
    // loading surface. Keep it visible while the target image is fetched and
    // decoded; clearing the CSS background here creates a black paint gap.
    retainPrevious = retainPrevious !== false && layers.some(function (layer) {
      return layer.style.backgroundImage && layer.style.backgroundImage !== 'none';
    });
    var loader = new Image();
    backdrop.__coverLoader = loader;
    layers.forEach(function (layer) {
      if (!retainPrevious) layer.classList.add('is-cover-pending');
      if (!retainPrevious) layer.style.backgroundImage = 'none';
    });
    loader.onload = function () {
      if (backdrop.__coverLoader !== loader) return;
      // Decode once and reveal both layers together. contain keeps the complete
      // poster; cover fills the sides, including on old Android WebViews.
      layers.forEach(function (layer) { layer.style.backgroundImage = 'url(' + JSON.stringify(loader.src) + ')'; });
      requestAnimationFrame(function () {
        if (backdrop.__coverLoader === loader) layers.forEach(function (layer) { layer.classList.remove('is-cover-pending'); });
      });
    };
    loader.onerror = function () {
      if (backdrop.__coverLoader !== loader) return;
      if (!retainPrevious) layers.forEach(function (layer) { layer.style.backgroundImage = 'none'; });
      layers.forEach(function (layer) { layer.classList.remove('is-cover-pending'); });
    };
    if (source) loader.src = source;
    else loader.onerror();
  }

  function setFeatured(item, waitingForProgress, transitionKind) {
    if (!item || !item.series_id) return;
    featuredItem = item;
    var backdrop = document.getElementById('hero-backdrop');
    var title = document.querySelector('.hero-title');
    var episode = document.querySelector('.hero-episode');
    var summary = document.querySelector('.hero-summary');
    var topTitle = document.getElementById('hero-top-title');
    var topEpisode = document.getElementById('hero-top-episode');
    var placeholderTitle = document.getElementById('hero-placeholder-title');
    var placeholderSummary = document.getElementById('hero-placeholder-summary');
    if (backdrop && transitionKind !== 'refresh') {
      var poster = document.getElementById('hero-loading-poster');
      if (transitionKind === 'episode' && desktopShell) clearBackdrop(backdrop, poster);
      else if (transitionKind === 'series' && androidShell) {
        clearBackdrop(backdrop, poster);
        setBackdrop(backdrop, item, poster, false);
      } else setBackdrop(backdrop, item, poster);
    }
    if (title) title.textContent = item.title || uiText('app.name', '红果短剧');
    if (episode) episode.textContent = waitingForProgress ? item.episode_count ? uiText('content.episodeCount', '全{count}集', { count: item.episode_count }) : '' : uiText('content.episodeNumber', '第{episode}集', { episode: item.start_episode || 1 }) + (item.episode_count ? ' · ' + uiText('content.episodeCount', '全{count}集', { count: item.episode_count }) : '');
    if (summary) summary.textContent = item.intro || '';
    if (topTitle) topTitle.textContent = item.title || uiText('app.name', '红果短剧');
    if (topEpisode) topEpisode.textContent = waitingForProgress ? '' : uiText('content.episodeNumber', '第{episode}集', { episode: item.start_episode || 1 });
    if (placeholderTitle) placeholderTitle.textContent = item.title || uiText('app.name', '红果短剧');
    if (placeholderSummary) placeholderSummary.textContent = item.intro || '';
    updateSavedButtons();
    if (engagement) engagement.select(activePlayback && activePlayback.item.series_id === item.series_id ? { series_id: item.series_id, vid: activePlayback.vid } : null);
    setControlIcon('episodes', uiText('content.episodeCount', '全{count}集', { count: item.episode_count || '--' }), 'icon-episodes');
    updateSeasonControl(item);
  }

  function updateFeedCounter() {
    var counter = document.getElementById('hero-top-count');
    if (!counter) return;
    var count = feedItems.length;
    var current = count ? Math.max(1, Math.min(feedIndex + 1, count)) : 0;
    var hasMore = count > 0 && feedPager.hasMore();
    counter.textContent = count ? current + ' / ' + count + (hasMore ? '+' : '') : '0 / 0';
    var label = count ? uiText(hasMore ? 'ui.feedPositionAtLeast' : 'ui.feedPositionTotal', hasMore ? '第{current}部，已加载至少{count}部' : '第{current}部，共{count}部', { current: current, count: count }) : '0 / 0';
    counter.setAttribute('aria-label', label);
    counter.title = label;
  }

  function recommendationChannel() {
    var channel = activeChannel();
    return ({ 'channel-follow': '45', 'channel-comic': '36', 'channel-real': '39', 'channel-recommend': '16' })[channel && channel.dataset.focus] || '16';
  }

  function progressFingerprint(entry) {
    return entry && entry.last_played_at ? JSON.stringify([entry.last_played_at, entry.episode, entry.position || 0, entry.duration || 0, !!entry.completed, entry.video_id || '']) : '';
  }

  function lastAutoRecommendationSeries() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        var stored = window.localStorage.getItem('hongguo.lastAutoRecommendationSeries');
        if (stored) return String(stored);
      }
    } catch (ignored) {}
    return lastAutoRecommendationSeriesMemory;
  }

  function rememberAutoRecommendationSeries(seriesID) {
    if (!seriesID) return;
    lastAutoRecommendationSeriesMemory = String(seriesID);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('hongguo.lastAutoRecommendationSeries', lastAutoRecommendationSeriesMemory);
      }
    } catch (ignored) {}
  }

  function pickRecommendationStartIndex(items) {
    var list = items || [];
    if (!list.length) return -1;
    var previous = lastAutoRecommendationSeries();
    if (!previous) return 0;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].series_id) !== previous) return i;
    }
    // A single-item (or all-identical) recommendation response must still
    // start playback instead of becoming an empty recommendation page.
    return 0;
  }

  function newRecommendationOrientationContext() {
    var direction = typeof recommendationDirectionSettings !== 'undefined' && recommendationDirectionSettings ? recommendationDirectionSettings.mode() : 'all';
    return direction === 'all' ? null : { direction: direction, checked: 0, limit: recommendationOrientationCheckLimit };
  }

  function maybeSkipRecommendationOrientation(playback, width, height) {
    var context = playback && playback.orientationContext;
    var direction = window.HongguoRecommendationDirection;
    if (!context || playback.orientationChecked || !direction) return false;
    var matches = direction.matches(context.direction, width || playback.videoWidth, height || playback.videoHeight);
    if (matches === null) return false;
    playback.orientationChecked = true;
    if (matches) return false;
    var nextChecked = context.checked + 1;
    var next = direction.nextCandidateIndex(feedIndex, feedItems.length, nextChecked, context.limit);
    context.checked = nextChecked;
    if (next < 0) return false;
    playFeedItem(next, undefined, undefined, null, null, null, context);
    return true;
  }

  function rememberRecommendation() {
    if (pageMode() !== 'recommend' || feedIndex < 0 || !feedItems[feedIndex] || !feedPager.loaded) return null;
    var item = feedItems[feedIndex], playback = activePlayback, video = document.getElementById('hero-video');
    var checkpoint = null;
    if (playback && playback.owner === accountEpoch && playback.generation === feedGeneration && playback.item.series_id === item.series_id) {
      checkpoint = { episode: playback.episode, position: playback.started ? Math.max(0, Number(video.currentTime) || 0) : playback.position || 0, completed: !!playback.completed };
    } else if (playbackRequest && playbackRequest.index === feedIndex && playbackRequest.episode) {
      checkpoint = { episode: playbackRequest.episode, position: playbackRequest.position || 0, completed: false };
    }
    if (checkpoint) {
      checkpoint.history = progressFingerprint(libraryEntry(item.series_id));
      checkpoint.ready = Promise.resolve();
    }
    // Only keep this channel in memory; the single-drama player may replace
    // feedItems, but must never replace the saved recommendation list.
    recommendationSession = { owner: accountEpoch, channel: recommendationChannel(), items: feedItems.slice(), index: feedIndex, checkpoint: checkpoint };
    return recommendationSession;
  }

  function settleRecommendationSave(session, save) {
    if (!session || !session.checkpoint) return;
    session.checkpoint.pending = true;
    session.checkpoint.ready = Promise.all([Promise.resolve(save).catch(function () {}), libraryQueue.catch(function () {})]).then(function () {
      if (recommendationSession !== session || session.owner !== accountEpoch) return;
      // Include our own queued departure write in the baseline. A later
      // history change then means the same drama was watched elsewhere.
      session.checkpoint.history = progressFingerprint(libraryEntry(session.items[session.index].series_id));
      session.checkpoint.pending = false;
    });
  }

  function recommendationResume(checkpoint, entry, item) {
    if (!checkpoint || !checkpoint.episode) return null;
    if (!checkpoint.pending && entry && entry.last_played_at && entry.episode && progressFingerprint(entry) !== checkpoint.history) {
      var episode = resumeEpisode(entry, item);
      return { episode: episode, position: !entry.completed && episode === entry.episode ? entry.position || 0 : 0 };
    }
    var captured = { last_played_at: 1, episode: checkpoint.episode, completed: checkpoint.completed };
    return { episode: resumeEpisode(captured, item), position: checkpoint.completed ? 0 : checkpoint.position || 0 };
  }

  function restoreRecommendation() {
    var session = recommendationSession;
    if (!session || session.owner !== accountEpoch || session.channel !== recommendationChannel() || !session.items[session.index] || !feedPager.loaded) return false;
    feedItems = session.items.slice();
    feedIndex = session.index;
    setCatalogHeading(activeChannel().textContent);
    playFeedItem(feedIndex, undefined, undefined, null, session.checkpoint);
    return true;
  }

  function showRecommendationPlaceholder(title, summary) {
    var hero = document.getElementById('hero');
    clearTimeout(controlsTimer);
    shell.classList.remove('is-controls-hidden');
    hero.classList.add('is-catalog-loading');
    document.getElementById('hero-placeholder-title').textContent = title;
    var copy = document.getElementById('hero-placeholder-summary');
    copy.textContent = summary || '';
    copy.classList.toggle('is-hidden', !summary);
    document.getElementById('hero-placeholder').classList.remove('is-hidden');
    setPlayerStatus('');
  }

  function switchRecommendation(step) {
    if (pageMode() !== 'recommend' || detailModalOpen || playerOptionsOpen || confirmOpen || discussionOpen || applicationInBackground || applicationHidden() || feedIndex < 0) return;
    playFeedItem(feedIndex + step);
  }

  function installRecommendationGestures() {
    var surface = document.querySelector('.hero-media');
    var touch = null;
    var suppressClickUntil = 0;
    var wheelAt = 0, wheelDelta = 0, wheelConsumed = false;
    function allowed(target) {
      return pageMode() === 'recommend' && feedIndex >= 0 && !detailModalOpen && !playerOptionsOpen && !confirmOpen && !discussionOpen && !applicationInBackground && !applicationHidden() && !target.closest('button, input, textarea, a');
    }
    surface.addEventListener('touchstart', function (event) {
      touch = null;
      if (event.touches.length !== 1 || !allowed(event.target)) return;
      var point = event.touches[0];
      touch = { x: point.clientX, y: point.clientY, at: Date.now(), generation: feedGeneration };
    }, false);
    surface.addEventListener('touchmove', function (event) {
      if (!touch || event.touches.length !== 1) { touch = null; return; }
      var point = event.touches[0];
      if (Math.abs(point.clientY - touch.y) > 8 && Math.abs(point.clientY - touch.y) > Math.abs(point.clientX - touch.x)) event.preventDefault();
    }, false);
    surface.addEventListener('touchend', function (event) {
      var start = touch;
      touch = null;
      if (!start || start.generation !== feedGeneration || !allowed(event.target) || !event.changedTouches.length) return;
      var point = event.changedTouches[0];
      var dy = point.clientY - start.y, dx = point.clientX - start.x;
      if (Date.now() - start.at > 1500 || Math.abs(dy) < 60 || Math.abs(dy) < Math.abs(dx) * 1.2) return;
      event.preventDefault();
      suppressClickUntil = Date.now() + 400;
      switchRecommendation(dy < 0 ? 1 : -1);
      goFocus(document.getElementById('hero-feed-focus'));
    }, false);
    surface.addEventListener('touchcancel', function () { touch = null; });
    surface.addEventListener('click', function (event) {
      if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    surface.addEventListener('wheel', function (event) {
      if (!allowed(event.target) || event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      var now = Date.now();
      if (now - wheelAt > 200) { wheelDelta = 0; wheelConsumed = false; }
      wheelAt = now;
      if (wheelConsumed) return; // One switch per gesture; ignore trackpad inertia.
      var delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1);
      if (wheelDelta * delta < 0) wheelDelta = 0;
      wheelDelta += delta;
      if (Math.abs(wheelDelta) < 60) return;
      wheelConsumed = true;
      switchRecommendation(wheelDelta > 0 ? 1 : -1);
      goFocus(document.getElementById('hero-feed-focus'));
    }, false);
  }

  function firstVid(item) {
    if (!item) return '';
    if (item.vid) return item.vid;
    if (item.vid_list && item.vid_list.length) return item.vid_list[0];
    return '';
  }

  function getDetail(item, signal) {
    if (detailCache[item.series_id]) return Promise.resolve(detailCache[item.series_id]);
    return fetch('/api/v1/series/detail?series_id=' + encodeURIComponent(item.series_id), signal ? { signal: signal } : undefined)
      .then(function (response) { if (!response.ok) throw new Error(uiText('ui.detailHttp', '详情 HTTP {status}', { status: response.status })); return response.json(); })
      .then(function (payload) {
        if (!payload.ok || !payload.data) throw new Error(apiError(payload, 200, 'ui.detailInvalid', '详情响应无效'));
        var keys = Object.keys(detailCache);
        if (keys.length >= 24) delete detailCache[keys[0]];
        detailCache[item.series_id] = payload.data;
        return payload.data;
      });
  }

  function saveProgress(force, completed) {
    var playback = activePlayback;
    if (!playback || !playback.started) return Promise.resolve(false);
    var video = document.getElementById('hero-video');
    var now = Date.now();
    if (!force && now - playback.lastWrite < 10000) return Promise.resolve(false);
    playback.lastWrite = now;
    if (completed) playback.completed = true;
    return changeLibrary({ action: 'progress', drama: basicDrama(playback.item), episode: playback.episode, video_id: playback.vid,
      position: Math.max(0, Number(video.currentTime) || 0), duration: Number.isFinite(video.duration) ? video.duration : 0, completed: !!playback.completed }, true);
  }

  function resetEndRecommendations() {
    if (typeof endRecommendations === 'undefined' || !endRecommendations) return;
    var restore = endRecommendations.isOpen() && document.activeElement && document.activeElement.closest('#end-recommendations');
    endRecommendations.reset();
    if (restore && isPlaybackPage()) goFocus(document.getElementById('hero-feed-focus'));
  }
  function flushEndRecommendations() { if (typeof endRecommendations !== 'undefined' && endRecommendations) endRecommendations.flush(); }
  function offerEndRecommendations(playback, detail) {
    if (pageMode() !== 'player' || !endRecommendations || !HongguoEndRecommendations.itemsFor(detail.related, playback.item.series_id).length) return false;
    endRecommendations.offer(playback, detail.related);
    return true;
  }
  function offerFollowAtEnd(playback, detail, after) {
    if (!playback || !detail || !canContinuePlayback(playback) || pageMode() !== 'player' ||
        playback.owner !== accountEpoch || followState(playback.item) !== 'ongoing' || followIsActive(playback.item)) return false;
    if (!accountData || !accountData.logged_in || confirmOpen) return false;
    ++confirmationGeneration;
    var generation = confirmationGeneration;
    var epoch = accountEpoch;
    var title = playback.item.title || uiText('app.name', '红果短剧');
    confirmReturnFocus = document.getElementById('hero-feed-focus');
    confirmAfterClose = after || null;
    confirmOpen = true;
    document.getElementById('confirm-title').textContent = uiText('content.followOnEndTitle', '追更这部短剧？');
    document.getElementById('confirm-copy').textContent = uiText('content.followOnEndCopy', '《{title}》仍在更新。追更后可在“我的 → 追更”中查看更新。', { title: title });
    var accept = document.getElementById('confirm-accept');
    accept.textContent = uiText('ui.follow', '追更');
    accept.classList.add('confirm-reserve'); accept.classList.remove('confirm-danger');
    document.getElementById('confirm-cancel').textContent = uiText('content.followOnEndLater', '暂不追更');
    document.getElementById('confirm-modal').classList.remove('is-hidden');
    document.getElementById('confirm-modal').setAttribute('aria-hidden', 'false');
    confirmOperation = function () {
      if (epoch !== accountEpoch || playback.owner !== accountEpoch || activePlayback !== playback || !isPlaybackPage()) {
        document.getElementById('confirm-copy').textContent = uiText('content.followOnEndStateChanged', '追更未确认成功：播放或账号状态已变化，请重试。');
        return Promise.resolve(false);
      }
      return fetchData('/api/v1/follow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ series_id: playback.item.series_id, enabled: true }) }).then(function () {
        if (epoch !== accountEpoch || generation !== confirmationGeneration) return false;
        playback.item.following_update = true; playback.item.followed = true;
        if (featuredItem && featuredItem.series_id === playback.item.series_id) { featuredItem.following_update = true; featuredItem.followed = true; }
        if (currentDetail && currentDetail.series_id === playback.item.series_id) { currentDetail.following_update = true; currentDetail.followed = true; updateDetailActions(); }
        followPager.loaded = false;
        if (pageMode() === 'follows' && followView === 'follow') followPager.reset({});
        showNotice(uiText('ui.followAdded', '已加入追更'));
        return true;
      }).catch(function (error) {
        if (epoch === accountEpoch && generation === confirmationGeneration && confirmOpen) {
          document.getElementById('confirm-copy').textContent = uiText('content.followOnEndFailed', '追更未完成：{error}。可以重试，或选择暂不追更。', { error: localizedError(error, 'common.operationFailed', '操作未完成，请重试。') });
        }
        return false;
      });
    };
    goFocus(document.getElementById('confirm-cancel'));
    return true;
  }
  function cancelEndRecommendationAutoplay() { if (typeof endRecommendations !== 'undefined' && endRecommendations) endRecommendations.cancelAutoplay(); }
  function renderEndRecommendationCountdown(seconds) {
    var badge = document.getElementById('end-recommendation-countdown');
    if (!badge) return;
    badge.classList.toggle('is-hidden', seconds === null);
    badge.querySelector('.end-countdown-value').textContent = seconds === null ? '' : String(seconds);
    if (seconds === null) badge.removeAttribute('aria-label');
    else badge.setAttribute('aria-label', uiText('ui.autoplayIn', '{seconds}秒后自动播放', { seconds: seconds }));
  }
  function prepareEndRecommendationCountdown(panel, image, animation) {
    var body = panel.querySelector('.end-recommendations-panel');
    var coverReady = !image || image.complete || !image.getAttribute('src'), fadeReady = false, queued = false, disposed = false;
    var coverTimer = null, fadeTimer = null;
    function cleanup() {
      disposed = true; clearTimeout(coverTimer); clearTimeout(fadeTimer);
      if (image) { image.removeEventListener('load', coverSettled); image.removeEventListener('error', coverSettled); }
      body.removeEventListener('transitionend', transitioned);
      if (endRecommendationReadyCleanup === cleanup) endRecommendationReadyCleanup = null;
    }
    function maybeReady() {
      if (disposed || queued || !coverReady || !fadeReady) return;
      queued = true;
      // setCover also uses a paint callback; let its pixels/fallback appear
      // before starting the user's thirty seconds.
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        if (disposed) return;
        cleanup();
        if (animation === endRecommendationAnimation && panel.classList.contains('is-open') && endRecommendations.isOpen()) endRecommendations.ready();
      }); });
    }
    function coverSettled() { coverReady = true; maybeReady(); }
    function fadeSettled() { fadeReady = true; maybeReady(); }
    function transitioned(event) { if (event.target === body && (event.propertyName === 'opacity' || event.propertyName === 'transform')) fadeSettled(); }
    if (image && !coverReady) {
      image.addEventListener('load', coverSettled); image.addEventListener('error', coverSettled);
      // A missing/slow cover keeps its reserved poster placeholder usable.
      coverTimer = setTimeout(coverSettled, 2500);
    }
    body.addEventListener('transitionend', transitioned);
    endRecommendationReadyCleanup = cleanup;
    return function () { fadeTimer = setTimeout(fadeSettled, 220); };
  }
  function showEndRecommendations(items) {
    if (endRecommendationReadyCleanup) endRecommendationReadyCleanup();
    var panel = document.getElementById('end-recommendations');
    var track = document.getElementById('end-recommendations-track');
    var animation = ++endRecommendationAnimation;
    track.innerHTML = ''; track.scrollLeft = 0; endRecommendationIndex = 0;
    items.forEach(function (item, index) {
      var card = document.createElement('button');
      card.className = 'end-recommendation-card'; card.dataset.focus = 'end-related-' + item.series_id;
      var image = document.createElement('img'); setCover(image, item);
      var title = document.createElement('strong'); title.textContent = item.title;
      var meta = document.createElement('small'); meta.textContent = item.episode_count ? uiText('content.episodeCount', '全{count}集', { count: item.episode_count }) : uiText('app.name', '红果短剧');
      var poster = dramaPoster(image, item);
      if (index === 0) {
        var badge = document.createElement('span'); badge.id = 'end-recommendation-countdown'; badge.className = 'end-recommendation-countdown is-hidden';
        var seconds = document.createElement('span'); seconds.className = 'end-countdown-value';
        badge.appendChild(seconds); poster.appendChild(badge); card.setAttribute('aria-describedby', badge.id);
      }
      card.appendChild(poster); card.appendChild(title); card.appendChild(meta);
      card.addEventListener('click', function () { endRecommendations.choose(index); });
      track.appendChild(card);
    });
    clearTimeout(controlsTimer);
    document.getElementById('hero').classList.add('has-end-recommendations');
    panel.classList.remove('is-hidden', 'is-closing', 'is-open'); panel.setAttribute('aria-hidden', 'false');
    document.getElementById('end-recommendations-close').tabIndex = 0;
    // Focus the first card immediately; the two paints only animate the sheet.
    goFocus(track.children[0]);
    var opened = prepareEndRecommendationCountdown(panel, track.children[0].querySelector('img'), animation);
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      if (animation === endRecommendationAnimation && endRecommendations.isOpen()) { panel.classList.add('is-open'); opened(); }
    }); });
  }
  function hideEndRecommendations(restoreFocus, animate) {
    if (endRecommendationReadyCleanup) endRecommendationReadyCleanup();
    var panel = document.getElementById('end-recommendations');
    if (!panel) return;
    var animation = ++endRecommendationAnimation;
    panel.classList.remove('is-open'); panel.setAttribute('aria-hidden', 'true');
    panel.querySelectorAll('button').forEach(function (button) { button.tabIndex = -1; });
    document.getElementById('hero').classList.remove('has-end-recommendations');
    function finish() {
      if (animation !== endRecommendationAnimation) return;
      panel.classList.add('is-hidden'); panel.classList.remove('is-closing');
      document.getElementById('end-recommendations-track').innerHTML = '';
    }
    if (animate && !panel.classList.contains('is-hidden')) { panel.classList.add('is-closing'); setTimeout(finish, 180); }
    else finish();
    if (restoreFocus && isPlaybackPage()) {
      revealControls();
      goFocus(firstVisible('.playback-buttons [data-action="episodes"]') || firstVisible('.playback-buttons .control-button') || document.getElementById('hero-feed-focus'));
    }
  }
  function scrollEndRecommendationIntoView(card) {
    if (!card || !card.classList.contains('end-recommendation-card')) return;
    var track = document.getElementById('end-recommendations-track');
    endRecommendationIndex = Array.prototype.indexOf.call(track.children, card);
    var box = track.getBoundingClientRect(), rect = card.getBoundingClientRect();
    if (rect.left < box.left + 4) track.scrollLeft -= box.left + 4 - rect.left;
    else if (rect.right > box.right - 4) track.scrollLeft += rect.right - box.right + 4;
  }
  function handleEndRecommendationKey(key, repeat) {
    if (!endRecommendations || !endRecommendations.isOpen()) return false;
    if (key === 'Escape' || key === 'Backspace') { if (!repeat) endRecommendations.close(true); return true; }
    if (key === 'Enter' || key === 'Tab' || /^Arrow/.test(key) || key === ' ' || /^Media/.test(key)) endRecommendations.cancelAutoplay();
    var track = document.getElementById('end-recommendations-track');
    var close = document.getElementById('end-recommendations-close');
    var current = document.activeElement;
    if (key === 'Enter') {
      if (!repeat) (current && current.closest('#end-recommendations') ? current : track.children[0]).click();
    } else if (key === 'ArrowUp') goFocus(close);
    else if (key === 'ArrowDown') goFocus(track.children[endRecommendationIndex] || track.children[0]);
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      var index = Array.prototype.indexOf.call(track.children, current);
      if (index >= 0) goFocus(track.children[index + (key === 'ArrowRight' ? 1 : -1)] || current);
    } else if (key === 'Tab') goFocus(current === close ? track.children[endRecommendationIndex] || track.children[0] : close);
    // Consume media shortcuts too: a focused recommendation must not replay,
    // seek or change an episode behind this sheet.
    return key === 'Enter' || key === 'Tab' || /^Arrow/.test(key) || key === ' ' || /^Media/.test(key);
  }

  function canContinuePlayback(playback) {
    return activePlayback === playback && playback.generation === feedGeneration && isPlaybackPage() &&
      (!playback.continuationToken || playback.continuationToken === continuationGeneration) && !applicationInBackground && !applicationHidden();
  }

  function deferContinuation(playback) {
    if (!playback || activePlayback !== playback || playback.generation !== feedGeneration || playback.owner !== accountEpoch ||
        !isPlaybackPage() || !applicationInBackground && !applicationHidden()) return false;
    playback.endedPending = true;
    return true;
  }

  function resumePendingContinuation(playback) {
    if (!playback || !playback.endedPending || playback.continuationPending || applicationInBackground || applicationHidden()) return false;
    if (!canContinuePlayback(playback)) return false;
    playback.endedPending = false;
    continueAfterEpisode(playback);
    return true;
  }

  function continueAfterEpisode(playback) {
    if (!canContinuePlayback(playback)) { deferContinuation(playback); return; }
    if (playback.continuationPending) { playback.endedPending = true; return; }
    // A user-initiated season switch owns this transition. Do not let an
    // episode boundary race it and start a different source underneath.
    if (seasonSwitchRequest) return;
    // Android 6 WebViews can support Promise without Promise.finally.
    function finishContinuation() {
      playback.continuationPending = false;
      playback.continuationToken = 0;
      if (playback.endedPending && canContinuePlayback(playback)) {
        playback.endedPending = false;
        setTimeout(function () { if (activePlayback === playback) continueAfterEpisode(playback); }, 0);
      }
    }
    playback.continuationPending = true;
    playback.continuationToken = ++continuationGeneration;
    setPlayerStatus(episodeLoadingText(playback.item.episode_count > playback.episode ? playback.episode + 1 : 0));
    getDetail(playback.item).then(function (detail) {
      if (!canContinuePlayback(playback)) { deferContinuation(playback); return; }
      if (detail.vid_list && detail.vid_list[playback.episode]) {
        playFeedItem(feedIndex, playback.episode + 1, 0, playback);
        return;
      }
      // Missing/incomplete episode data must not be mistaken for season end.
      if (!detail.vid_list || !detail.vid_list.length || playback.episode < Math.max(detail.episode_count || 0, detail.vid_list.length)) {
        throw new Error(uiText('content.seriesIncomplete', '本季集列表不完整'));
      }
      setPlayerStatus(episodeLoadingText());
      var epoch = accountEpoch;
      return fetchData('/api/v1/series/seasons?series_id=' + encodeURIComponent(playback.item.series_id)).then(function (series) {
        if (!canContinuePlayback(playback)) { deferContinuation(playback); return; }
        if (epoch !== accountEpoch) return;
        if (!Array.isArray(series.items)) throw new Error(uiText('content.seriesInvalid', '系列剧响应无效'));
        if (!series.items.length) throw new Error(uiText('content.seriesInvalid', '系列剧响应无效'));
        var currentRows = series.items.filter(function (item) { return item.series_id === playback.item.series_id; });
        if (currentRows.length > 1) throw new Error(uiText('content.seasonMismatch', '系列季号不一致'));
        var current = currentRows[0];
        function continueFromSeason(season) {
          if (!canContinuePlayback(playback)) { deferContinuation(playback); return; }
          if (epoch !== accountEpoch) return;
          if (!(season > 0)) throw new Error(uiText('content.nextSeasonInvalid', '下一季数据无效'));
          var successors = series.items.filter(function (item) { return item.season_index === season + 1; });
          if (successors.length > 1) throw new Error(uiText('content.seasonConflict', '下一季关系存在冲突'));
          var successor = successors[0];
          // The complete same-series selector is authoritative: it includes
          // reservable seasons, so never jump over a missing/unavailable season
          // to a later playable result from the relationship endpoint.
          if (successor && successor.upcoming) {
            setPlayerStatus(''); revealControls();
            var reservationPrompt = successor.reservation_id && offerNextSeasonReservation(playback, successor, epoch);
            if (!successor.reservation_id) showNotice(uiText('content.nextSeasonOffline', '本季已播放完，下一季待上线，尚未开放预约'));
            var followThenRecommendations = function () {
              var followPrompt = offerFollowAtEnd(playback, detail, function () { offerEndRecommendations(playback, detail); });
              if (!followPrompt) offerEndRecommendations(playback, detail);
            };
            if (reservationPrompt) confirmAfterClose = followThenRecommendations;
            else followThenRecommendations();
            return;
          }
          if (successor && !successor.playable) {
            setPlayerStatus(''); revealControls(); showNotice(uiText('content.nextSeasonUnavailable', '下一季暂不可播放'));
            var followingPrompt = offerFollowAtEnd(playback, detail, function () { offerEndRecommendations(playback, detail); });
            if (!followingPrompt) offerEndRecommendations(playback, detail);
            return;
          }
          if (!successor && series.items.some(function (item) { return item.season_index > season + 1; })) {
            throw new Error(uiText('content.seriesListIncomplete', '系列剧季列表不完整'));
          }
          if (!successor && !(current && current.season_index > 0)) {
            throw new Error(uiText('content.seriesListIncomplete', '系列剧季列表不完整'));
          }
          if (successor) {
            if (!successor.series_id || successor.series_id === playback.item.series_id || !successor.vid || !(successor.episode_count > 0)) throw new Error(uiText('content.nextSeasonInvalid', '下一季数据无效'));
            feedItems[feedIndex] = successor;
            playFeedItem(feedIndex, 1, 0);
            refreshDetailAfterSeason(playback.item.series_id, successor);
            showNotice(uiText('content.continueSeason', '继续播放第{season}季', { season: successor.season_index }));
          } else {
            setPlayerStatus(''); revealControls();
            if (pageMode() === 'recommend' && feedItems.length > 1) playFeedItem(feedIndex + 1, undefined, undefined, null, null, null, newRecommendationOrientationContext());
            else {
              var recommendations = false;
              var followPrompt = offerFollowAtEnd(playback, detail, function () { offerEndRecommendations(playback, detail); });
              if (!followPrompt) recommendations = offerEndRecommendations(playback, detail);
              if (!followPrompt && !recommendations) showNotice(uiText('content.seriesFinished', '本剧已播放完，暂无可播放的下一季'));
            }
          }
        }
        if (current && current.season_index > 0) {
          continueFromSeason(current.season_index);
          return;
        }
        // Older/incomplete selector responses may omit the current season
        // number. Ask the relationship endpoint only to identify that number;
        // the successor itself must still come from the complete selector.
        return fetch('/api/v1/series/next-season?series_id=' + encodeURIComponent(playback.item.series_id))
          .then(function (response) { return response.json().then(function (payload) {
            if (!response.ok || !payload.ok || !payload.data || !Object.prototype.hasOwnProperty.call(payload.data, 'next')) throw new Error(apiError(payload, response.status, 'content.seasonInvalid', '季关系响应无效'));
            return payload.data;
          }); })
          .then(function (result) {
            if (!canContinuePlayback(playback)) { deferContinuation(playback); return; }
            if (epoch !== accountEpoch) return;
            continueFromSeason(current && current.season_index > 0 ? current.season_index : result.current_season);
          });
      });
    }).catch(function (error) {
      if (!canContinuePlayback(playback)) { deferContinuation(playback); return; }
      setPlayerStatus(''); revealControls();
      showNotice(uiText('content.continuationPaused', '连续播放已暂停：{error}', { error: localizedError(error, 'common.operationFailed', '操作未完成，请重试。') }));
    }).then(finishContinuation, finishContinuation);
  }

  function offerNextSeasonReservation(playback, item, epoch) {
    if (!canContinuePlayback(playback) || confirmOpen) return false;
    // A freshly confirmed reservation may not be reflected in the successor
    // object yet. Reapply the short-lived account-scoped state before deciding
    // whether a prompt is needed.
    applyReservationOverride(item);
    var label = item.label || uiText('content.episodeNumber', '第{episode}集', { episode: item.season_index }) .replace(/集$/, '季');
    if (item.reserved) { showNotice(uiText('content.nextSeasonReserved', '您已预约{label}，敬请期待', { label: label })); return false; }
    if (!accountData || !accountData.logged_in) { showNotice(uiText('content.nextSeasonLogin', '本季已播放完，{label}待上线。登录后可在“选集 → 系列剧”预约', { label: label })); return false; }
    ++confirmationGeneration; var generation = confirmationGeneration;
    confirmReturnFocus = document.activeElement; confirmOpen = true;
    document.getElementById('confirm-title').textContent = uiText('content.reserveNextTitle', '预约下一季？');
    document.getElementById('confirm-copy').textContent = uiText('content.reserveNextCopy', '本季已播放完，{title}尚未上线。确认后会在当前窗口提示预约结果。', { title: item.title });
    var accept = document.getElementById('confirm-accept');
    accept.textContent = uiText('content.reserve', '预约') + label; accept.classList.add('confirm-reserve'); accept.classList.remove('confirm-danger');
    document.getElementById('confirm-cancel').textContent = uiText('content.later', '稍后');
    document.getElementById('confirm-modal').classList.remove('is-hidden');
    document.getElementById('confirm-modal').setAttribute('aria-hidden', 'false');
    confirmOperation = function () {
      if (epoch !== accountEpoch || activePlayback !== playback || !isPlaybackPage()) {
        document.getElementById('confirm-copy').textContent = uiText('content.reserveStateChanged', '预约未确认成功：播放状态已变化，请重新打开预约提示后重试。');
        return Promise.resolve(false);
      }
      return writeReservation(item, true).then(function (result) {
        if (epoch !== accountEpoch) {
          document.getElementById('confirm-copy').textContent = uiText('content.reserveAccountChanged', '预约未确认成功：账号状态已变化，请重新打开预约提示后重试。');
          return false;
        }
        if (!result.confirmed) { showNotice(reservationPendingMessage()); return true; }
        item.reserved = true; rememberReservationOverride(item, true); reservationPager.loaded = false; calendarPager.loaded = false;
        // Keep a known count stable while the upstream subscription list
        // catches up. If no count is known, the next response adds the one
        // still-pending local confirmation instead of showing a false drop.
        if (reservationCounts.upcoming !== null && item.upcoming) reservationCounts.upcoming += 1;
        updateReservationCounts({});
        updateSeasonReservation(item.reservation_id, true);
        updateSeriesRows();
        showNotice(uiText('content.reserved', '已预约') + label);
        return true;
      }).catch(function (error) {
        if (epoch === accountEpoch && confirmOpen && generation === confirmationGeneration) document.getElementById('confirm-copy').textContent = uiText('content.reserveFailed', '预约未确认成功：{error}。可以重试，或选择稍后。', { error: localizedError(error, 'common.operationFailed', '操作未完成，请重试。') });
        return false;
      });
    };
    goFocus(document.getElementById('confirm-cancel'));
    return true;
  }

  function refreshDetailAfterSeason(previousID, next) {
    if (!detailModalOpen || detailSeriesID !== previousID) return;
    var focused = document.activeElement;
    var index = focused && focused.classList.contains('detail-episode') ? 0 : -1;
    var generation = ++detailGeneration;
    detailSeriesID = next.series_id;
    currentDetail = next;
    renderDetail(next);
    updateSeriesRows();
    if (index >= 0) { goFocus(currentDetailEpisode() || document.getElementById('detail-tab-episodes')); detailFocusPending = !currentDetailEpisode(); }
    getDetail(next).then(function (detail) {
      if (!detailModalOpen || generation !== detailGeneration || !currentDetail || currentDetail.series_id !== next.series_id) return;
      currentDetail = Object.assign({}, next, detail);
      renderDetail(currentDetail);
      focusLoadedDetailEpisode();
    }).catch(function () { if (detailModalOpen && generation === detailGeneration) showNotice(uiText('content.nextSeasonReadFailed', '下一季选集暂时读取失败，可关闭后重试')); });
  }

  function cancelPlaybackPreparation() {
    clearRangeTransitionHint();
    clearRangeStallTimer();
    clearEpisodeCover();
    if (playbackInfoRequest) playbackInfoRequest.abort(); playbackInfoRequest = null;
    if (playbackPrefetchHandoff) playbackPrefetchHandoff.cancel(); playbackPrefetchHandoff = null;
    interruptPlaybackPresentation(activePlayback);
  }
  function playbackEngineName() {
    try {
      return window.HongguoNativePlayer && window.HongguoNativePlayer.engine ? window.HongguoNativePlayer.engine() : '';
    } catch (ignored) { return ''; }
  }
  function playbackCodecMode() {
    try {
      var native = window.HongguoNativePlayer;
      if (!native || typeof native.engine !== 'function' || native.engine() !== 'mpv') return 'default';
      return typeof native.decoderMode === 'function' && native.decoderMode() === 'mpv_software' ? 'software' : 'auto';
    } catch (ignored) { return 'default'; }
  }
  function mpvInPlaceReplaceAvailable() {
    try {
      var native = window.HongguoNativePlayer;
      return !!(native && typeof native.engine === 'function' && native.engine() === 'mpv' &&
        typeof native.canReplaceInPlace === 'function' && native.canReplaceInPlace());
    } catch (ignored) { return false; }
  }

  function recommendationDirectionPlatform() {
    return webosShell ? 'webos' : androidShell ? 'android' : desktopShell ? 'desktop' : 'preview';
  }
  function nativePlaybackActive() {
    return document.documentElement.classList.contains('native-playback');
  }
  function isNativeMedia3PlaybackActive() {
    return nativePlaybackActive() && playbackEngineName() !== 'mpv';
  }
  function playbackDebug(message) {
    try { if (window.console && console.debug) console.debug(message); } catch (ignored) {}
  }
  function waitForPlaybackPrefetch(handoff, generation, signal) {
    if (!handoff || !handoff.promise) return Promise.resolve(null);
    var settled = false;
    return new Promise(function (resolve) {
      function finish(data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (generation !== feedGeneration || signal && signal.aborted) { resolve(null); return; }
        resolve(data && data.path ? data : null);
      }
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        // Range preparation is shared with the foreground resolver. A full
        // episode download is intentionally cancelled at the handoff budget:
        // it must never keep competing with the source that is about to play.
        if (handoff.prefetchMode === 'full') handoff.cancel();
        else if (generation === feedGeneration && !(signal && signal.aborted)) playbackDebug('[Preload] handoff timeout, use foreground resolver');
        resolve(null);
      }, 1200);
      handoff.promise.then(function (data) {
        if (settled) return;
        if (!data || !data.path || handoff.prefetchMode !== 'full') { finish(data); return; }
        fetch(data.path, { method: 'HEAD', signal: signal }).then(function (response) {
          finish(response && response.ok ? data : null);
        }, function () { finish(null); });
      }, function () {
        finish(null);
      });
    });
  }
  function recoverPlaybackAfterError(playback) {
    if (!playback || playback !== activePlayback || playback.generation !== feedGeneration) return false;
    var action = playbackRecovery.next({ native: playbackEngineName() });
    if (action !== 'refresh') return false;
    var video = document.getElementById('hero-video');
    var position = Math.max(0, Number(video.currentTime) || Number(playback.position) || 0);
    playback.recoveryAttempts = playbackRecovery.attempts();
    showNotice(uiText('content.sourceRefreshing', '正在刷新播放地址…'));
    playFeedItem(feedIndex, playback.episode, position, null, null, { recoveryAttempts: playback.recoveryAttempts });
    return true;
  }
  function recoverPlaybackPreparation(playback, error, generation) {
    if (typeof webosShell === 'undefined' || !webosShell || !playback || activePlayback !== playback ||
        playback.generation !== generation || generation !== feedGeneration ||
        applicationInBackground || applicationHidden() || !isPlaybackPage() || !error || error.name === 'AbortError') return false;
    var code = error.code || '';
    var temporary = [408, 425, 429, 500, 502, 503, 504].indexOf(Number(error.status)) >= 0;
    if (code === 'VIDEO_MODEL_HTTP' ? !temporary :
        ['VIDEO_MODEL_EMPTY', 'UPSTREAM_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET',
          'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'].indexOf(code) < 0) return false;
    if (playbackRecovery.next({ native: playbackEngineName() }) !== 'refresh') return false;
    // The visible video may still be the previous episode at its end. Retry
    // the pending episode's saved position, never that old video's timestamp.
    var position = Math.max(0, Number(playback.position) || 0);
    playFeedItem(feedIndex, playback.episode, position, null, null, { recoveryAttempts: playbackRecovery.attempts(), automaticNext: !!(playback.timing && playback.timing.automatic_next) });
    return true;
  }
  function clearRangeTransitionHint() {
    clearTimeout(rangeTransitionTimer);
    rangeTransitionTimer = null;
    document.getElementById('hero').classList.remove('is-range-transition-loading');
  }
  function scheduleRangeStallFallback(playback) {
    var video = document.getElementById('hero-video');
    if (!playback || playback !== activePlayback || playback.mode !== 'range' || playback.rangeFallbackAttempted ||
        playback.generation !== feedGeneration || video.paused || video.seeking || applicationInBackground || applicationHidden() || rangeStallTimer) return;
    var generation = playback.generation;
    var lastPosition = Math.max(0, Number(video.currentTime) || 0);
    // A webOS first-chunk stall is a preparation failure, not normal playback
    // buffering. Its old 45-second window allowed a failed transition to sit
    // behind two or more upstream Range timeouts. Once the timer fires,
    // fallbackRangePlayback keeps the previous frame/loading state and starts
    // the complete-file path. Other players retain their existing windows.
    var stallDelay = webosShell && !playback.started ? webOSRangeStallFallbackMs : playbackEngineName() === 'mpv' ? 40000 : 45000;
    rangeStallTimer = setTimeout(function () {
      rangeStallTimer = null;
      if (activePlayback !== playback || generation !== feedGeneration || playback.mode !== 'range' ||
          playback.rangeFallbackAttempted || video.paused || video.seeking || applicationInBackground || applicationHidden()) return;
      var position = Math.max(0, Number(video.currentTime) || 0);
      if (position > lastPosition + .25) {
        scheduleRangeStallFallback(playback);
        return;
      }
      fallbackRangePlayback(playback);
    }, stallDelay);
  }
  function maybePrefetchNextEpisode(video) {
    var playback = activePlayback;
    if (!playback) return;
    var mode = typeof effectiveEpisodePrefetchMode === 'function' ? effectiveEpisodePrefetchMode() : 'range';
    episodePrefetch.maybe({ item: playback.item, series_id: playback.item.series_id, vid: playback.vid,
      episode: playback.episode, quality: playbackPreferences.quality, generation: playback.generation, owner: accountEpoch,
      codec_mode: typeof playbackCodecMode === 'function' ? playbackCodecMode() : 'default',
      mode: (typeof rangePlaybackEnabled === 'function' && rangePlaybackEnabled()) ? 'range' : '',
      prefetch_mode: mode,
      prefetch_after_seconds: HongguoEpisodePrefetch.prefetchThreshold(mode, playbackEngineName()),
      duration: Number(video.duration), position: Number(video.currentTime), paused: video.paused, ended: video.ended,
      stable_seconds: playback.stableSince ? Math.max(0, Date.now() - playback.stableSince) / 1000 : 0,
      started: playback.started, active: playback.generation === feedGeneration && isPlaybackPage() && !applicationInBackground && !applicationHidden() && !qualityPrevious });
    var prepared = typeof episodePrefetch.peek === 'function' ? episodePrefetch.peek() : null;
    if (prepared && prepared.info && prepared.target && prepared.info.generation === playback.generation &&
        prepared.info.owner === accountEpoch && prepared.info.series_id === playback.item.series_id &&
        Number(prepared.info.episode) === Number(playback.episode) && engagement) {
      // Warm only the next episode's artwork. This shares the engagement
      // cache with the normal render and never changes the visible counts.
      var target = { series_id: prepared.target.series_id, vid: prepared.target.vid };
      var generation = playback.generation, owner = accountEpoch;
      engagement.prewarm(target).then(function (data) {
        var current = typeof episodePrefetch.peek === 'function' ? episodePrefetch.peek() : null;
        if (!data || activePlayback !== playback || playback.generation !== generation || generation !== feedGeneration ||
            accountEpoch !== owner || !current || !current.target || current.target.series_id !== target.series_id ||
            current.target.vid !== target.vid) return;
        prewarmEpisodeCover(target, data, playback);
      });
    }
  }
  function cancelFullEpisodePrefetchForPlayback(playback) {
    var video = document.getElementById('hero-video');
    if (!playback || !playback.started || playback.ended || playback.completed || video.ended ||
        (typeof effectiveEpisodePrefetchMode === 'function' ? effectiveEpisodePrefetchMode() : 'range') !== 'full') return;
    // Completed files are already local and harmless to keep for the upcoming
    // natural switch. Cancel only an in-flight speculative download.
    episodePrefetch.cancelPending('full');
  }
  function holdPlaybackAudio(generation) {
    var video = document.getElementById('hero-video');
    if (!playbackAudioHold) playbackAudioHold = { muted: video.muted, generation: generation };
    playbackAudioHold.generation = generation;
    video.muted = true;
  }
  function hasLastPlaybackFrame(item) {
    var canvas = document.getElementById('hero-last-frame');
    var held = canvas && canvas.__playbackFrame;
    return !!(item && held && held.series === item.series_id && held.owner === accountEpoch && canvas.classList.contains('is-visible'));
  }
  function clearLastPlaybackFrame() {
    var canvas = document.getElementById('hero-last-frame');
    if (!canvas) return;
    document.getElementById('hero').classList.remove('is-native-frame-revealing');
    canvas.classList.remove('is-visible');
    canvas.__playbackFrame = null;
    // Release the pixel buffer and reset any origin-tainted canvas state.
    canvas.width = 0; canvas.height = 0;
  }
  function clearEpisodeCover(playback) {
    if (playback && activePlayback && playback !== activePlayback) return;
    var hero = document.getElementById('hero');
    var cover = document.getElementById('hero-episode-cover');
    var current = playback || activePlayback;
    if (current && current.presentation && current.presentation.revealTimer) {
      clearTimeout(current.presentation.revealTimer);
      current.presentation.revealTimer = null;
    }
    if (current && current.presentation) current.presentation.revealing = false;
    episodeCoverLoader = null;
    if (cover) {
      cover.__coverLoader = null;
      cover.__coverSource = '';
      cover.style.backgroundImage = 'none';
      cover.classList.remove('is-ready');
    }
    if (hero) hero.classList.remove('is-episode-cover', 'is-native-frame-revealing', 'is-native-media3-episode-transition', 'is-native-mpv-episode-transition', 'is-native-mpv-source-unloaded');
  }
  function prewarmEpisodeCover(target, data, playback) {
    if (!target || !data || !data.episode_cover || activePlayback !== playback || playback.generation !== feedGeneration ||
        playback.owner !== accountEpoch || playback.item.series_id !== target.series_id) return;
    var source = String(data.episode_cover);
    var owner = accountEpoch;
    var key = String(accountEpoch) + ':' + target.series_id + ':' + target.vid;
    if (prewarmedEpisodeCover && prewarmedEpisodeCover.key === key && prewarmedEpisodeCover.source === source) return;
    var record = { key: key, source: source, image: new Image(), ready: false, failed: false, waiters: [] };
    prewarmedEpisodeCover = record;
    function isStillRelevant() {
      if (accountEpoch !== owner || !activePlayback || activePlayback.generation !== feedGeneration ||
          activePlayback.owner !== owner || activePlayback.item.series_id !== target.series_id) return false;
      if (activePlayback.vid === target.vid) return true;
      var prepared = typeof episodePrefetch.peek === 'function' ? episodePrefetch.peek() : null;
      return !!(prepared && prepared.info && prepared.target && prepared.info.generation === activePlayback.generation &&
        prepared.info.owner === owner && prepared.target.series_id === target.series_id && prepared.target.vid === target.vid);
    }
    function finish(ok) {
      if (prewarmedEpisodeCover !== record || !isStillRelevant() || String(accountEpoch) + ':' + target.series_id + ':' + target.vid !== key) return;
      record.ready = !!ok;
      record.failed = !ok;
      var waiters = record.waiters.slice();
      record.waiters = [];
      waiters.forEach(function (waiter) { waiter(record.ready); });
    }
    record.image.onload = function () {
      if (typeof record.image.decode === 'function') {
        try { record.image.decode().then(function () { finish(true); }, function () { finish(true); }); return; } catch (ignoredDecode) {}
      }
      finish(true);
    };
    record.image.onerror = function () { finish(false); };
    record.image.src = source;
  }
  function setEpisodeCover(target, data) {
    if (!target || !data || !data.episode_cover) return;
    var playback = activePlayback;
    var hero = document.getElementById('hero');
    var cover = document.getElementById('hero-episode-cover');
    if (!playback || playback.episodeCoverAllowed === false || !hero || !cover || !hero.classList.contains('is-preparing-video') ||
        playback.generation !== feedGeneration || playback.owner !== accountEpoch ||
        playback.item.series_id !== target.series_id || playback.vid !== target.vid ||
        playback.presentation && playback.presentation.rendered) return;
    var source = String(data.episode_cover);
    if (cover.__coverSource === source) {
      if (cover.__coverLoader === episodeCoverLoader && episodeCoverLoader) return;
      if (cover.classList.contains('is-ready')) {
        hero.classList.add('is-episode-cover');
        return;
      }
    }
    var prewarmed = prewarmedEpisodeCover && prewarmedEpisodeCover.key === String(accountEpoch) + ':' + target.series_id + ':' + target.vid &&
      prewarmedEpisodeCover.source === source && !prewarmedEpisodeCover.failed ? prewarmedEpisodeCover : null;
    var loader = prewarmed ? prewarmed.image : new Image();
    episodeCoverLoader = loader;
    cover.__coverLoader = loader;
    cover.__coverSource = source;
    function revealLoadedCover() {
      if (cover.__coverLoader !== loader || activePlayback !== playback || playback.generation !== feedGeneration ||
          playback.owner !== accountEpoch || playback.presentation && playback.presentation.rendered ||
          !hero.classList.contains('is-preparing-video')) return;
      cover.style.backgroundImage = 'url(' + JSON.stringify(loader.src) + ')';
      cover.classList.add('is-ready');
      hero.classList.add('is-episode-cover');
    }
    function decodeAndReveal() {
      // `load` is not a decoded-pixels guarantee on older WebViews. Use the
      // promise API where available, with a non-blocking load fallback.
      if (typeof loader.decode === 'function') {
        try { loader.decode().then(revealLoadedCover, revealLoadedCover); return; } catch (ignoredDecode) {}
      }
      revealLoadedCover();
    }
    function clearFailedCover() {
      if (cover.__coverLoader !== loader) return;
      cover.__coverLoader = null;
      cover.__coverSource = '';
      cover.style.backgroundImage = 'none';
      cover.classList.remove('is-ready');
    }
    if (prewarmed) {
      if (prewarmed.ready) revealLoadedCover();
      else {
        prewarmed.waiters.push(function (ok) { if (ok) revealLoadedCover(); else clearFailedCover(); });
      }
    } else {
      loader.onload = decodeAndReveal;
      loader.onerror = clearFailedCover;
      loader.src = source;
    }
  }
  function layoutLastPlaybackFrame() {
    var canvas = document.getElementById('hero-last-frame');
    if (!canvas || !canvas.__playbackFrame || !canvas.width || !canvas.height) return;
    var rect = canvas.parentNode.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    // Explicit contain geometry also works on WebViews without object-fit.
    var scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    canvas.style.width = (canvas.width * scale / rect.width * 100) + '%';
    canvas.style.height = (canvas.height * scale / rect.height * 100) + '%';
  }
  function captureLastPlaybackFrame(item) {
    // Rapid selections keep the last displayed frame, never an intermediate
    // source which is still loading behind the cover.
    if (hasLastPlaybackFrame(item)) return true;
    clearLastPlaybackFrame();
    var canvas = document.getElementById('hero-last-frame');
    var node = document.querySelector('#hero-video');
    // getElementById may return the native media proxy. drawImage needs the
    // actual HTML video, and its old pixels are invalid during native playback.
    if (!canvas || !node || document.documentElement.classList.contains('native-playback') ||
        node.readyState < 2 || !(node.videoWidth > 0) || !(node.videoHeight > 0)) return false;
    try {
      var width = node.videoWidth, height = node.videoHeight;
      var scale = Math.min(1, 1280 / Math.max(width, height), Math.sqrt(921600 / (width * height)));
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      var context = canvas.getContext('2d');
      if (!context) throw new Error('No frame canvas');
      context.drawImage(node, 0, 0, canvas.width, canvas.height);
      // A cross-origin/unsupported read must fail closed without data URLs,
      // files or a full-frame readback on memory-constrained TVs.
      if (context.getImageData(0, 0, 1, 1).data[3] !== 255) throw new Error('No captured frame');
      canvas.__playbackFrame = { series: item.series_id, owner: accountEpoch };
      layoutLastPlaybackFrame();
      canvas.classList.add('is-visible');
      return true;
    } catch (ignoredCapture) {
      clearLastPlaybackFrame();
      return false;
    }
  }
  function clearRangeStallTimer() {
    if (typeof rangeStallTimer === 'undefined') return;
    clearTimeout(rangeStallTimer);
    rangeStallTimer = null;
  }
  function setPlaybackMuted(muted) {
    if (playbackAudioHold) playbackAudioHold.muted = !!muted;
    document.getElementById('hero-video').muted = playbackAudioHold ? true : !!muted;
  }
  function releasePlaybackAudio(playback) {
    if (!playbackAudioHold || playback && playbackAudioHold.generation !== playback.generation) return;
    var muted = playbackAudioHold.muted;
    playbackAudioHold = null;
    document.getElementById('hero-video').muted = muted;
  }
  function bindPlaybackPresentation(playback, source) {
    playback.presentation = { source: source, position: Number(playback.position) || 0, epoch: 0, pending: false, waiting: false,
      rendered: false, progressed: false, revealing: false, revealTimer: null, frame_at: 0, failed: false };
  }
  function interruptPlaybackPresentation(playback) {
    if (!playback || !playback.presentation) return;
    var presentation = playback.presentation;
    presentation.epoch++;
    presentation.pending = false;
    presentation.audioPending = false;
    presentation.revealing = false;
    if (presentation.revealTimer) clearTimeout(presentation.revealTimer);
    presentation.revealTimer = null;
    document.getElementById('hero').classList.remove('is-native-frame-revealing');
  }
  function samePlaybackPresentationSource(actual, expected) {
    if (typeof window !== 'undefined' && window.HongguoWebOS && typeof window.HongguoWebOS.sameMediaSource === 'function') {
      return window.HongguoWebOS.sameMediaSource(actual, expected);
    }
    return actual === expected;
  }
  function currentPlaybackPresentation(playback, presentation, video) {
    return !!(playback && presentation && activePlayback === playback && playback.presentation === presentation &&
      playback.generation === feedGeneration && playback.owner === accountEpoch && isPlaybackPage() &&
      !applicationInBackground && !applicationHidden() && !presentation.failed &&
      video.classList.contains('has-source') && samePlaybackPresentationSource(video.getAttribute('src'), presentation.source));
  }
  function playbackVideoReady(playback, presentation, video) {
    var mpv = playbackEngineName() === 'mpv';
    var staticFrameCoreIdle = presentation && typeof presentation.nativeFrameCoreIdle === 'boolean' ?
      presentation.nativeFrameCoreIdle : presentation && presentation.nativeCoreIdle;
    var nativePausedReady = mpv && presentation && presentation.rendered && staticFrameCoreIdle !== true &&
      video.paused && !video.ended && !video.seeking && video.readyState >= 2 &&
      video.videoWidth > 0 && video.videoHeight > 0;
    var nativePlayingReady = !mpv || presentation && presentation.progressed && presentation.nativeCoreIdle !== true;
    return !!(currentPlaybackPresentation(playback, presentation, video) && !presentation.waiting &&
      // Media3 reports a frame when it reaches the native surface, before the
      // WebView can know that SurfaceFlinger has presented it. Wait for media
      // time to advance as well, so removing the cover cannot expose a blank surface.
      (nativePausedReady || (nativePlayingReady && (playback.started || presentation.rendered) && !video.paused && !video.ended && !video.seeking && video.readyState >= 2 &&
      video.videoWidth > 0 && video.videoHeight > 0)));
  }
  function releasePresentedAudio(playback, presentation, video) {
    if (!playbackAudioHold || presentation.audioPending || !playbackVideoReady(playback, presentation, video)) return;
    presentation.audioPending = true;
    var epoch = presentation.epoch;
    var frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (callback) { return setTimeout(callback, 16); };
    // The cover removal must get its own paint before sound is restored.
    frame(function () {
      if (playback.presentation !== presentation || presentation.epoch !== epoch) return;
      presentation.audioPending = false;
      if (!document.getElementById('hero').classList.contains('is-preparing-video') && playbackVideoReady(playback, presentation, video)) releasePlaybackAudio(playback);
    });
  }
  function waitForPlaybackPaint(generation, signal) {
    // The first animation callback runs before paint. The second lets the
    // black cover reach the compositor before touching Android's video layer.
    // This is a paint boundary, not a fixed loading-duration timer.
    return new Promise(function (resolve) {
      var frame = 0, finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        if (frame) cancelAnimationFrame(frame);
        if (signal) signal.removeEventListener('abort', abort);
        resolve(value);
      }
      function abort() { finish(false); }
      function current() { return generation === feedGeneration && !applicationInBackground && !applicationHidden() && !(signal && signal.aborted); }
      if (!current()) { finish(false); return; }
      if (signal) signal.addEventListener('abort', abort);
      frame = requestAnimationFrame(function () {
        if (!current()) { finish(false); return; }
        frame = requestAnimationFrame(function () { finish(current()); });
      });
    });
  }
  function finishPlaybackPreparation(playback) {
    var hero = document.getElementById('hero');
    var video = document.getElementById('hero-video');
    var presentation = playback && playback.presentation;
    if (!playbackVideoReady(playback, presentation, video)) return;
    if (typeof maybeSkipRecommendationOrientation === 'function' && maybeSkipRecommendationOrientation(playback, video.videoWidth, video.videoHeight)) return;
    clearRangeStallTimer();
    if (!hero.classList.contains('is-preparing-video')) {
      clearEpisodeCover(playback);
      releasePresentedAudio(playback, presentation, video);
      finishAutoCinema(playback);
      return;
    }
    if (presentation.pending) return;
    // Reveal the video underneath the opaque cover before removing that
    // cover. A canplay event alone must never expose an empty video surface.
    hero.classList.add('is-starting-video');
    presentation.pending = true;
    var epoch = presentation.epoch;
    waitForPlaybackPaint(playback.generation).then(function (painted) {
      if (playback.presentation !== presentation || presentation.epoch !== epoch) return;
      if (!painted || !playbackVideoReady(playback, presentation, video)) { presentation.pending = false; return; }
      function complete() {
        if (playback.presentation !== presentation || presentation.epoch !== epoch || !playbackVideoReady(playback, presentation, video)) {
          presentation.pending = false;
          presentation.revealing = false;
          hero.classList.remove('is-native-frame-revealing');
          return;
        }
        presentation.pending = false;
        presentation.revealing = false;
        presentation.revealTimer = null;
        if (typeof clearRangeTransitionHint === 'function') clearRangeTransitionHint();
        clearLastPlaybackFrame();
        clearEpisodeCover(playback);
        hero.classList.remove('is-preparing-video', 'is-starting-video', 'is-episode-transition', 'is-range-transition', 'is-range-source-reset', 'is-native-media3-episode-transition', 'is-native-mpv-episode-transition');
        setPlayerStatus('');
        releasePresentedAudio(playback, presentation, video);
        finishAutoCinema(playback);
      }
      var hasHeldFrame = document.getElementById('hero').classList.contains('is-episode-cover') ||
        document.getElementById('hero-last-frame').classList.contains('is-visible');
      // Standard HTML5 can show the captured previous frame underneath the
      // target episode cover. Let the real target frame paint first, then
      // fade that cover away. webOS keeps its own transition path because its
      // single HTML5 element is coordinated with the Luna/Range service.
      if ((typeof webosShell === 'undefined' || !webosShell) && !nativePlaybackActive() && hero.classList.contains('is-episode-transition') &&
          hero.classList.contains('is-episode-cover')) {
        presentation.revealing = true;
        hero.classList.add('is-native-frame-revealing');
        presentation.revealTimer = setTimeout(complete, 180);
        return;
      }
      if (isNativeMedia3PlaybackActive() && playback.preserveNativeTransition && hasHeldFrame && !presentation.progressed) {
        presentation.pending = false;
        return;
      }
      if (isNativeMedia3PlaybackActive() && playback.preserveNativeTransition && hasHeldFrame) {
        presentation.revealing = true;
        hero.classList.add('is-native-frame-revealing');
        presentation.revealTimer = setTimeout(complete, 200);
        return;
      }
      // MPV's native frame signal is obtained from libmpv's output state, not
      // from the WebView compositor. Keep a prepared episode cover for one
      // additional compositor boundary so a SurfaceView that is still being
      // latched cannot flash black underneath the cover. Unlike Media3, a
      // paused target is valid here because the native frame is already
      // rendered and no clock advance is required for a static first frame.
      if (hero.classList.contains('is-native-mpv-episode-transition') && hasHeldFrame) {
        presentation.revealing = true;
        hero.classList.add('is-native-frame-revealing');
        presentation.revealTimer = setTimeout(complete, 32);
        return;
      }
      complete();
    });
  }
  function markPlaybackStarted(playback) {
    var video = document.getElementById('hero-video');
    var presentation = playback && playback.presentation;
    if (applicationInBackground || applicationHidden()) { video.pause(); return; }
    if (!presentation || presentation.failed) return;
    if (!currentPlaybackPresentation(playback, presentation, video) || video.paused || video.ended || video.seeking || video.readyState < 2) return;
    if (typeof maybeSkipRecommendationOrientation === 'function' && maybeSkipRecommendationOrientation(playback, video.videoWidth, video.videoHeight)) return;
    clearRangeStallTimer();
    presentation.waiting = false;
    playback.started = true;
    playback.stableSince = Date.now();
    if (playback.autoRecommendation && !playback.autoRecommendationRecorded && playback.item && playback.item.series_id) {
      playback.autoRecommendationRecorded = true;
      rememberAutoRecommendationSeries(playback.item.series_id);
    }
    finishPlaybackPreparation(playback);
    if (!document.getElementById('hero').classList.contains('is-preparing-video')) setPlayerStatus('');
    if (playback.timing && !playback.timing.reported) {
      var timing = playback.timing;
      timing.reported = true;
      var nativeStopFenceMs = null;
      try {
        var nativeTiming = window.HongguoNativePlayer && window.HongguoNativePlayer.diagnostics ? JSON.parse(window.HongguoNativePlayer.diagnostics()) : null;
        if (nativeTiming && typeof nativeTiming.last_stop_fence_ms === 'number') nativeStopFenceMs = nativeTiming.last_stop_fence_ms;
      } catch (ignoredNativeTiming) {}
      timing.source_ready_ms = Math.max(0, timing.ready_at - timing.started_at);
      timing.native_frame_ms = presentation && presentation.frame_at ? Math.max(0, presentation.frame_at - timing.ready_at) : null;
      timing.native_stop_fence_ms = nativeStopFenceMs;
      timing.video_start_ms = Math.max(0, Date.now() - timing.ready_at);
      timing.total_ms = Math.max(0, Date.now() - timing.started_at);
      playbackTiming.push({ episode: timing.episode, automatic_next: timing.automatic_next, prefetch_mode: timing.prefetch_mode, prefetch_ms: timing.prefetch_ms,
        handoff_wait_ms: timing.handoff_wait_ms, foreground_resolve_ms: timing.foreground_resolve_ms,
        prepared_before_switch: timing.prepared_before_switch,
        source_ready_ms: Math.max(0, timing.ready_at - timing.started_at),
        native_frame_ms: presentation && presentation.frame_at ? Math.max(0, presentation.frame_at - timing.ready_at) : null,
        native_stop_fence_ms: nativeStopFenceMs,
        video_start_ms: Math.max(0, Date.now() - timing.ready_at), total_ms: Math.max(0, Date.now() - timing.started_at) });
      if (playbackTiming.length > 20) playbackTiming.shift();
    }
    updatePlaybackControls(); scheduleControlsHide(); saveProgress(true);
    if (typeof showPlaybackMenuHint === 'function') showPlaybackMenuHint(playback);
  }
  function checkPlaybackProgress(video) {
    var playback = activePlayback, presentation = playback && playback.presentation;
    if (!currentPlaybackPresentation(playback, presentation, video)) return;
    var position = Number(video.currentTime) || 0;
    var advancing = position > presentation.position + .001 && !video.seeking && !video.paused && !video.ended && video.readyState >= 2;
    presentation.position = position;
    if (advancing) {
      clearRangeStallTimer();
      presentation.waiting = false;
      presentation.progressed = true;
      if (!playback.started) markPlaybackStarted(playback);
      else if (!playback.stableSince) playback.stableSince = Date.now();
      if (!document.getElementById('hero').classList.contains('is-preparing-video')) setPlayerStatus('');
    }
    finishPlaybackPreparation(playback);
  }
  function fallbackRangePlayback(playback) {
    if (!playback || playback !== activePlayback || playback.mode !== 'range' || playback.rangeFallbackAttempted || playback.generation !== feedGeneration) return false;
    var video = document.getElementById('hero-video');
    var hero = document.getElementById('hero');
    var position = Math.max(0, Number(video.currentTime) || Number(playback.position) || 0);
    clearRangeStallTimer();
    var generation = playback.generation;
    var request = typeof AbortController === 'function' ? new AbortController() : null;
    playback.rangeFallbackAttempted = true;
    playback.rangeFallback = uiText('ui.rangePreparing', '分段读取失败，正在准备标准播放');
    playback.position = position;
    playback.started = false;
    playback.stableSince = 0;
    saveProgress(true);
    holdPlaybackAudio(generation);
    hero.classList.add('is-preparing-video');
    hero.classList.remove('is-starting-video');
    setPlayerStatus(episodeLoadingText(playback.episode));
    video.pause();
    var painted = waitForPlaybackPaint(generation, request && request.signal);
    var params = new URLSearchParams({ series_id: playback.item.series_id, vid: playback.vid, quality: playbackPreferences.quality, fallback: '1' });
    params.set('codec_mode', typeof playbackCodecMode === 'function' ? playbackCodecMode() : 'default');
    var preparing = fetchData('/api/v1/play/info?' + params, request ? { signal: request.signal } : {});
    playbackInfoRequest = request;
    Promise.all([painted, preparing]).then(function (values) {
      if (playback !== activePlayback || generation !== feedGeneration || !values[0] || !values[1] || !values[1].path) return;
      video.classList.remove('has-source');
      video.removeAttribute('src');
      video.load();
      playback.mode = values[1].mode || 'full';
      playback.rangeFallback = uiText('ui.rangeFallback', '分段读取失败，已回退标准播放');
      playback.videoWidth = Number(values[1].video_width) || 0;
      playback.videoHeight = Number(values[1].video_height) || 0;
      playback.position = position;
      playback.started = false;
      playbackQuality = values[1].quality || '';
      playbackQualities = values[1].qualities || [];
      playbackInfoRequest = null;
      playback.timing.ready_at = Date.now();
      bindPlaybackPresentation(playback, values[1].path);
      video.src = values[1].path;
      stageNativePlaybackStartPosition(position);
      video.classList.add('has-source');
      video.load();
      setPlayerStatus(episodeLoadingText(playback.episode));
      if (!applicationHidden() && !applicationInBackground) playMedia(video).catch(function () { setPlayerStatus(uiText('ui.standardPlaybackFailed', '标准播放也未能启动'), true); });
    }).catch(function () {
      if (playback !== activePlayback || generation !== feedGeneration) return;
      playbackInfoRequest = null;
      playback.rangeFallback = uiText('ui.allPlaybackFailed', '分段读取和标准播放准备均失败');
      setPlayerStatus(uiText('ui.episodePlaybackFailed', '这集未能正常播放'), true);
    });
    return true;
  }
  function playFeedItem(index, forcedEpisode, forcedPosition, continuation, resumeCheckpoint, recovery, orientationContext) {
    closePlayerOptions(false);
    closeDiscussion(false); resetDanmaku();
    if (!feedItems.length) return;
    if (index < 0) { showNotice(uiText('ui.firstRecommendation', '已经是第一条推荐')); return; }
    if (index >= feedItems.length && pageMode() === 'recommend') {
      var pendingIndex = feedIndex;
      var pendingGeneration = feedPager.generation;
      if (feedPager.error) { showNotice(uiText('ui.recommendationRetry', '推荐加载失败，请再按向下重试')); }
      if (feedPager.hasMore() || feedPager.error) {
        feedPager.load(!!feedPager.error).then(function () { if (pageMode() === 'recommend' && feedPager.generation === pendingGeneration && feedIndex === pendingIndex && index < feedItems.length) playFeedItem(index, undefined, undefined, null, null, null, orientationContext); });
      } else showNotice(uiText('ui.allRecommendations', '已浏览全部推荐'));
      return;
    }
    if (index >= feedItems.length) return;
    var item = feedItems[index];
    if (!item || !item.series_id) return;
    if (!recovery || !recovery.recoveryAttempts) playbackRecovery.reset();
    resetEndRecommendations();
    var autoRecommendation = pageMode() === 'recommend' && (recommendationAutoplayPending || !!orientationContext);
    recommendationAutoplayPending = false;
    var switchStartedAt = Date.now();
    var nativeAtSwitch = nativePlaybackActive();
    var sameSeries = !!((activePlayback && (activePlayback.started || activePlayback.presentation && activePlayback.presentation.rendered) &&
      activePlayback.owner === accountEpoch && activePlayback.item.series_id === item.series_id) || hasLastPlaybackFrame(item));
    var transitionKind = sameSeries ? 'episode' : activePlayback ? 'series' : 'initial';
    var fastContinuation = !!(continuation && continuation.completed && canContinuePlayback(continuation) &&
      continuation.owner === accountEpoch && continuation.item.series_id === item.series_id &&
      forcedEpisode === continuation.episode + 1 && forcedPosition === 0 && libraryLoaded);
    cancelPlaybackPreparation();
    var request = new AbortController();
    playbackInfoRequest = request;
    var playbackMode = (typeof rangePlaybackEnabled === 'function' && rangePlaybackEnabled()) ? 'range' : '';
    var prefetchMode = typeof effectiveEpisodePrefetchMode === 'function' ? effectiveEpisodePrefetchMode() : 'range';
    episodePrefetch.keepFor(item.series_id, forcedEpisode, playbackPreferences.quality, accountEpoch, playbackMode, prefetchMode,
      typeof playbackCodecMode === 'function' ? playbackCodecMode() : 'default');
    // ended has already queued the completed episode. Keep that write alive,
    // but do not queue it twice or make the next source wait for its fsync.
    if (!fastContinuation) saveProgress(true);
    activePlayback = null;
    if (typeof syncNativePlaybackPageState === 'function') syncNativePlaybackPageState();
    playbackRequest = { index: index, episode: forcedEpisode, position: forcedPosition };
    playbackQuality = '';
    playbackQualities = [];
    feedIndex = index;
    if (pageMode() === 'recommend' && feedIndex >= feedItems.length - 3 && !feedPager.error) feedPager.load();
    var hero = document.getElementById('hero');
    var video = document.getElementById('hero-video');
    var placeholder = document.getElementById('hero-placeholder');
    var mpvTransition = sameSeries && nativeAtSwitch && playbackEngineName() === 'mpv' && mpvInPlaceReplaceAvailable();
    var keepRangeFrame = sameSeries && playbackMode === 'range' && !!video.getAttribute('src') &&
      (!nativeAtSwitch || playbackEngineName() === 'mpv');
    var capturedLastFrame = false;
    if (keepRangeFrame) {
      capturedLastFrame = captureLastPlaybackFrame(item);
      // The standard Media3 Surface is not readable by the HTML canvas. Only
      // use the transparent frame transition when the previous frame really
      // was captured; otherwise keep the poster/episode cover over the reset.
      if (playbackEngineName() !== 'mpv' && !capturedLastFrame) keepRangeFrame = false;
    } else clearLastPlaybackFrame();
    var keepEpisodeCover = playbackEngineName() === 'mpv' || !sameSeries || nativeAtSwitch || !capturedLastFrame ||
      ((typeof webosShell === 'undefined' || !webosShell) && !nativeAtSwitch && capturedLastFrame);
    var generation = ++feedGeneration;
    if (autoCinemaCandidate && autoCinemaGeneration && generation !== autoCinemaGeneration) cancelPendingAutoCinema();
    holdPlaybackAudio(generation);
    clearTimeout(controlsTimer);
    hero.classList.add('is-feed', 'is-preparing-video');
    hero.classList.remove('is-catalog-loading', 'is-starting-video', 'is-range-source-reset');
    hero.classList.toggle('is-episode-transition', sameSeries);
    hero.classList.toggle('is-range-transition', keepRangeFrame);
    hero.classList.toggle('is-native-mpv-episode-transition', mpvTransition);
    hero.classList.toggle('is-native-media3-episode-transition', sameSeries && nativeAtSwitch && playbackEngineName() !== 'mpv');
    placeholder.classList.add('is-hidden');
    updateFeedCounter();
    var incomingResume = resumeCheckpoint && recommendationResume(resumeCheckpoint, libraryEntry(item.series_id), item);
    var incomingEpisode = forcedEpisode || (incomingResume ? incomingResume.episode : libraryLoaded ? resumeEpisode(libraryEntry(item.series_id), item) : 0);
    setFeatured(Object.assign({}, item, { start_episode: incomingEpisode }), !incomingEpisode, transitionKind);
    updateSeriesRows();
    setPlayerStatus(episodeLoadingText(incomingEpisode));
    if (keepRangeFrame) {
      rangeTransitionTimer = setTimeout(function () {
        if (generation === feedGeneration && hero.classList.contains('is-preparing-video') && hero.classList.contains('is-range-transition')) {
          hero.classList.add('is-range-transition-loading');
        }
      }, 320);
    }
    // Keep the cover painted during native source reset. CSS visibility alone
    // did not prevent a grey hardware-video flash on the user's Android 6 TV.
    if (!keepRangeFrame) video.classList.remove('has-source');
    var coveredReset = waitForPlaybackPaint(generation, request.signal).then(function (painted) {
      if (!painted) return false;
      video.pause();
      if (keepRangeFrame) {
        updatePlaybackControls();
        return true;
      }
      video.removeAttribute('src');
      video.load();
      updatePlaybackControls();
      return true;
    });
    var waitForLibrary = fastContinuation ? Promise.resolve() : Promise.resolve(libraryReady).then(function () { return libraryQueue.catch(function () {}); });
    if (resumeCheckpoint) waitForLibrary = Promise.all([waitForLibrary, resumeCheckpoint.ready]);
    Promise.all([waitForLibrary, coveredReset]).then(function (ready) {
      if (!ready[1] || generation !== feedGeneration || request.signal.aborted) return null;
      var entry = libraryEntry(item.series_id);
      var resumed = resumeCheckpoint && recommendationResume(resumeCheckpoint, entry, item);
      var episode = forcedEpisode || (resumed ? resumed.episode : resumeEpisode(entry, item));
      var position = forcedPosition !== undefined ? forcedPosition : resumed ? resumed.position : entry && episode === entry.episode && !entry.completed ? entry.position || 0 : 0;
      playbackRequest.episode = episode; playbackRequest.position = position;
      setFeatured(Object.assign({}, item, { start_episode: episode }), false, 'refresh');
      setPlayerStatus(episodeLoadingText(episode));
      var source = episode === 1 && firstVid(item) ? Promise.resolve(item) : getDetail(item, request.signal);
      return source.then(function (detail) {
        if (generation !== feedGeneration || request.signal.aborted) return null;
        var vid = episode === 1 ? firstVid(detail) : detail.vid_list && detail.vid_list[episode - 1];
        if (!vid) throw new Error(uiText('content.episodeNoVideo', '第{episode}集暂无视频数据', { episode: episode }));
        var playing = Object.assign({}, item, detail, { start_episode: episode, vid: vid });
        activePlayback = { item: playing, episode: episode, vid: vid, position: position, generation: generation, owner: accountEpoch, started: false, stableSince: 0, lastWrite: 0, completed: false,
          episodeCoverAllowed: keepEpisodeCover,
          preserveNativeTransition: sameSeries,
          endedPending: false,
          autoRecommendation: autoRecommendation, autoRecommendationRecorded: false,
          orientationContext: orientationContext || null, orientationChecked: !orientationContext,
          mode: '', rangeFallback: '', rangeFallbackAttempted: false, videoWidth: 0, videoHeight: 0,
          recoveryAttempts: recovery && recovery.recoveryAttempts || 0,
          timing: { episode: episode, automatic_next: fastContinuation || !!(recovery && recovery.automaticNext), prefetch_mode: prefetchMode, started_at: switchStartedAt, ready_at: 0,
            prefetch_started_at: 0, prefetch_ready_at: 0, prefetch_ms: null, handoff_wait_ms: null,
            foreground_resolve_started_at: 0, foreground_resolve_ms: null,
            prepared_before_switch: false, reported: false } };
        if (autoCinemaCandidate && generation === autoCinemaGeneration) autoCinemaSession = activePlayback;
        setFeatured(playing, false, 'refresh');
        updateDetailProgress();
        setPlayerStatus(episodeLoadingText(episode));
        var target = { series_id: item.series_id, vid: vid, episode: episode, quality: playbackPreferences.quality, owner: accountEpoch, mode: playbackMode,
          codec_mode: typeof playbackCodecMode === 'function' ? playbackCodecMode() : 'default', prefetch_mode: prefetchMode };
        var handoff = episodePrefetch.consume(target);
        playbackPrefetchHandoff = handoff;
        activePlayback.timing.handoff_started_at = Date.now();
        return waitForPlaybackPrefetch(handoff, generation, request.signal).then(function (prepared) {
          if (generation !== feedGeneration || request.signal.aborted || applicationInBackground || applicationHidden()) return null;
          activePlayback.timing.handoff_wait_ms = Math.max(0, Date.now() - activePlayback.timing.handoff_started_at);
          if (handoff && handoff.timing) {
            activePlayback.timing.prefetch_started_at = Number(handoff.timing.started_at) || 0;
            activePlayback.timing.prefetch_ready_at = Number(handoff.timing.ready_at) || 0;
            if (handoff.timing.ready_at) {
              activePlayback.timing.prefetch_ms = Math.max(0, handoff.timing.ready_at - handoff.timing.started_at);
              activePlayback.timing.prepared_before_switch = handoff.timing.ready_at <= switchStartedAt;
            }
          }
          if (prepared && prepared.path) {
            playbackPrefetchHandoff = null;
            activePlayback.timing.handoff_wait_ms = Math.max(0, Date.now() - activePlayback.timing.handoff_started_at);
            return prepared;
          }
          // Revalidate the prepared cache entry; the core reuses the same file
          // and retries a failed or timed-out speculative job through the
          // normal resolver. The 1.2s handoff budget keeps navigation responsive.
          activePlayback.timing.foreground_resolve_started_at = Date.now();
          var params = { series_id: item.series_id, vid: vid, quality: playbackPreferences.quality, fallback: '1', mode: playbackMode };
          params.codec_mode = typeof playbackCodecMode === 'function' ? playbackCodecMode() : 'default';
          return fetchData('/api/v1/play/info?' + new URLSearchParams(params), { signal: request.signal }).then(function (data) {
            playbackPrefetchHandoff = null;
            activePlayback.timing.foreground_resolve_ms = Math.max(0, Date.now() - activePlayback.timing.foreground_resolve_started_at);
            return data;
          });
        });
      });
    })
      .then(function (data) {
        if (generation !== feedGeneration || request.signal.aborted || (pageMode() !== 'recommend' && pageMode() !== 'player')) return;
        if (!data) return;
        playbackInfoRequest = null;
        if (!data.path) throw new Error(uiText('content.noSource', '播放服务没有返回地址'));
        activePlayback.videoWidth = Number(data.video_width) || 0;
        activePlayback.videoHeight = Number(data.video_height) || 0;
        if (typeof maybeSkipRecommendationOrientation === 'function' && maybeSkipRecommendationOrientation(activePlayback, activePlayback.videoWidth, activePlayback.videoHeight)) return;
        function attachPreparedSource() {
          if (generation !== feedGeneration || request.signal.aborted || !activePlayback) return;
          activePlayback.timing.ready_at = Date.now();
          activePlayback.mode = data.mode || 'full';
          activePlayback.rangeFallback = data.range_fallback || '';
          activePlayback.videoWidth = Number(data.video_width) || 0;
          activePlayback.videoHeight = Number(data.video_height) || 0;
          bindPlaybackPresentation(activePlayback, data.path);
          video.src = data.path;
          stageNativePlaybackStartPosition(activePlayback.position);
          playbackQuality = data.quality || '';
          playbackQualities = data.qualities || [];
          if (playbackPreferences.quality && playbackQuality !== playbackPreferences.quality) showNotice(uiText('content.qualityMissing', '本集没有 {quality}，使用 {fallback}', { quality: playbackPreferences.quality, fallback: playbackQuality || uiText('ui.autoQuality', '自动清晰度') }));
          updatePlaybackControls();
          video.classList.add('has-source');
          if (typeof syncNativePlaybackPageState === 'function') syncNativePlaybackPageState();
          placeholder.classList.add('is-hidden');
          video.load();
          setPlayerStatus(episodeLoadingText(activePlayback.episode));
          if (!applicationHidden() && !applicationInBackground) playMedia(video).catch(function () { setPlayerStatus(''); revealControls(); showNotice(uiText('content.videoReadyConfirm', '视频已准备好，请按确认键开始播放')); });
          else { setPlayerStatus(''); revealControls(); }
        }
        if (!keepRangeFrame) { attachPreparedSource(); return; }
        // Cover the source replacement before it reaches Android's video
        // compositor, and keep the cover until a frame from this source is ready.
        hero.classList.add('is-range-source-reset');
        return waitForPlaybackPaint(generation, request.signal).then(function (painted) {
          if (!painted || generation !== feedGeneration || request.signal.aborted) return;
          attachPreparedSource();
        });
      })
      .catch(function (error) {
        if (generation !== feedGeneration || (pageMode() !== 'recommend' && pageMode() !== 'player')) return;
        playbackInfoRequest = null; playbackPrefetchHandoff = null;
        if (recoverPlaybackPreparation(activePlayback, error, generation)) return;
        if (error.name !== 'AbortError') {
          clearRangeTransitionHint();
          hero.classList.remove('is-range-transition');
          video.classList.remove('has-source');
          if (typeof syncNativePlaybackPageState === 'function') syncNativePlaybackPageState();
          setPlayerStatus(uiText('ui.cannotPlayEpisode', '暂时无法播放这集'), true);
        }
      });
  }

  function syncHomeChannel(items) {
    var bridge = typeof window !== 'undefined' ? window.HongguoTVHome : null;
    if (recommendationChannel() !== '16' || !bridge || typeof bridge.syncRecommendations !== 'function') return;
    var programs = (items || []).slice(0, 20).map(function (item) {
      return { series_id: item.series_id, title: item.title || '', intro: item.intro || '', cover: item.cover || '', cover_fallback: item.cover_fallback || '' };
    });
    try { bridge.syncRecommendations(JSON.stringify(programs)); } catch (error) { /* Browser previews have no native TV provider. */ }
  }

  function renderFeed(items) {
    recommendationAutoplayPending = false;
    feedItems = (items || []).filter(function (item) { return item && item.series_id; });
    syncHomeChannel(feedItems);
    feedIndex = feedItems.length ? 0 : -1;
    updateFeedCounter();
    if (!feedItems.length) {
      featuredItem = null;
      updateSeasonControl(null);
      showRecommendationPlaceholder(feedPager.hasMore() ? uiText('ui.readingRecommendations', '正在读取推荐') : uiText('ui.noRecommendations', '暂时没有推荐内容'));
      return;
    }
    armPlaybackMenuHint();
    var startIndex = pickRecommendationStartIndex(feedItems);
    if (startIndex >= 0) {
      recommendationAutoplayPending = true;
      playFeedItem(startIndex, undefined, undefined, null, null, null, newRecommendationOrientationContext());
    }
  }

  function isAutoCinemaCardLaunch(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('.catalog-card, .search-result-card, .library-card, .rank-row, .radar-official-row, .radar-growth-row, .new-card, .calendar-row, .reservation-row, .follow-card, .actor-work-card');
  }

  function shouldAutoCinemaForLaunch(currentPage, returnFocus, startOptions) {
    return currentPage !== 'player' && (!!(startOptions && startOptions.cardLaunch) || currentPage !== 'recommend' && isAutoCinemaCardLaunch(returnFocus));
  }

  function startPlayer(item, returnFocus, startOptions) {
    if (!item || !item.series_id) return;
    if (typeof closePlaybackCommandMenu === 'function') closePlaybackCommandMenu(false);
    if (typeof closePlaybackMenuHint === 'function') closePlaybackMenuHint();
    var menuHintCandidate = typeof playbackMenuHintAvailable !== 'undefined' && playbackMenuHintAvailable && pageMode() === 'recommend' && (typeof playbackMenuHintPreviewForced !== 'undefined' && playbackMenuHintPreviewForced || !!returnFocus && isAutoCinemaCardLaunch(returnFocus));
    var launchFromCard = shouldAutoCinemaForLaunch(pageMode(), returnFocus, startOptions);
    if (typeof notificationHidePopup === 'function') notificationHidePopup();
    var recommendation = rememberRecommendation();
    allPagers.forEach(function (pager) { pager.cancel(); });
    if (!isPlaybackPage()) resetPlayerUI();
    if (pageMode() !== 'player') {
      playerReturnPage = pageMode();
      playerReturnFocus = returnFocus || document.activeElement;
    }
    shell.dataset.mode = 'player';
    shell.classList.add('is-player');
    if (typeof syncNativePlaybackPageState === 'function') syncNativePlaybackPageState();
    document.getElementById('page-context').disabled = false;
    mainSurface.classList.remove('has-search', 'has-placeholder', 'has-workspace');
    hideWorkspacePages();
    searchPage.classList.add('is-hidden');
    pagePlaceholder.classList.add('is-hidden');
    document.getElementById('page-context').textContent = uiText('ui.back', '← 返回');
    document.getElementById('hero').classList.add('is-feed');
    feedItems = [item];
    feedIndex = 0;
    cancelPendingAutoCinema();
    playbackMenuHintCandidate = menuHintCandidate;
    autoCinemaCandidate = autoCinemaEnabled && launchFromCard;
    playFeedItem(0, item.__explicitEpisode ? item.start_episode : undefined, item.__explicitEpisode ? 0 : undefined);
    if (autoCinemaCandidate) autoCinemaGeneration = feedGeneration;
    if (recommendation) settleRecommendationSave(recommendation, libraryQueue);
    goFocus(document.getElementById('hero-feed-focus'));
  }

  function leavePlayer() {
    var page = playerReturnPage || 'search';
    var target = playerReturnFocus;
    playerReturnPage = null;
    playerReturnFocus = null;
    var item = document.querySelector('.side-item[data-page="' + page + '"]');
    if (!item) item = document.querySelector('.side-item[data-page="recommend"]');
    if (item) activatePage(item, true);
    if (pageMode() === 'recommend') goFocus(firstContentFocus());
    else if (target && document.contains(target)) goFocus(target);
    else goFocus(firstContentFocus());
  }

  function handlePlayerContextClick() {
    if (pageMode() !== 'player') return false;
    leavePlayer();
    return true;
  }

  function posterSeasonLabel(item) {
    var season = Number(item && item.season_index);
    if (season > 0 && season <= 999 && Math.floor(season) === season) return uiText('ui.seasonNumber', '第{season}季', { season: season });
    var match = String(item && item.title || '').match(/第\s*([0-9０-９零〇一二两三四五六七八九十百]+)\s*季/);
    if (!match) return '';
    var text = match[1].replace(/[０-９]/g, function (digit) { return String(digit.charCodeAt(0) - 65296); });
    var digits = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (/^[0-9]+$/.test(text)) season = Number(text);
    else if (/[0-9]/.test(text)) return '';
    else if (!/[十百]/.test(text)) season = Number(text.split('').map(function (digit) { return digits[digit]; }).join(''));
    else {
      season = 0; var digit = 0;
      text.split('').forEach(function (character) {
        var unit = character === '百' ? 100 : character === '十' ? 10 : 0;
        if (unit) { season += (digit || 1) * unit; digit = 0; }
        else digit = digits[character];
      });
      season += digit;
    }
    return season > 0 && season <= 999 && Math.floor(season) === season ? uiText('ui.seasonNumber', '第{season}季', { season: season }) : '';
  }

  // Normal posters share one decoration. Compact catalog/series/calendar
  // thumbnails deliberately do not call this helper or gain focus targets.
  function updatePosterSeason(poster, item) {
    var label = posterSeasonLabel(item); var badge = poster.querySelector('.poster-season-badge');
    if (!label) { if (badge) badge.remove(); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'poster-season-badge'; poster.appendChild(badge); }
    badge.textContent = label;
  }
  function dramaPoster(image, item) {
    var poster = document.createElement('span'); poster.className = 'drama-poster';
    poster.appendChild(image); updatePosterSeason(poster, item); return poster;
  }

  function renderCatalog(items) {
    var track = document.getElementById('catalog-track');
    document.getElementById('hero-placeholder').classList.remove('is-hidden');
    track.innerHTML = '';
    var visibleItems = (items || []).slice(0, 9);
    visibleItems.forEach(function (item) {
      if (!item || !item.series_id) return;
      var card = document.createElement('button');
      card.className = 'catalog-card';
      card.dataset.seriesId = item.series_id;
      card.dataset.focus = 'catalog-' + item.series_id;
      var image = document.createElement('img');
      image.className = 'catalog-card-image';
      setCover(image, item);
      var title = document.createElement('span');
      title.className = 'catalog-card-title';
      title.textContent = item.title || uiText('ui.unnamedDrama', '未命名短剧');
      var meta = document.createElement('span');
      meta.className = 'catalog-card-meta';
      meta.textContent = catalogMeta(item);
      card.appendChild(image);
      card.appendChild(title);
      card.appendChild(meta);
      card.addEventListener('click', function () { startPlayer(item, card); });
      card.addEventListener('focus', function () {
        setFeatured(item);
        try { card.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (ignore) { card.scrollIntoView(false); }
      });
      track.appendChild(card);
    });
    if (visibleItems.length) setFeatured(visibleItems[0]);
  }

  function renderSearchResults(items, append) {
    if (!append) { searchResults.innerHTML = ''; searchItems = []; }
    var seen = {};
    searchItems.forEach(function (item) { seen[item.series_id] = true; });
    var list = (items || []).filter(function (item) {
      if (!item || !item.series_id || seen[item.series_id]) return false;
      seen[item.series_id] = true;
      return true;
    });
    searchItems = searchItems.concat(list);
    document.getElementById('search-result-count').textContent = searchItems.length ? uiText('ui.loadedCount', '已加载 {count} 部', { count: searchItems.length }) : '';
    if (!searchItems.length) {
      var empty = document.createElement('div');
      empty.className = 'search-result-empty';
      empty.textContent = searchKind === 'browse' ? uiText('ui.searchEmptyBrowse', '没有符合这些条件的短剧，试试放宽筛选。') : uiText('ui.searchEmptyQuery', '没有找到匹配的短剧，换个关键词试试。');
      searchResults.appendChild(empty);
      return;
    }
    list.forEach(function (item) {
      var card = document.createElement('button');
      card.className = 'search-result-card';
      card.dataset.seriesId = item.series_id;
      card.dataset.focus = 'search-result-' + item.series_id;
      var image = document.createElement('img');
      image.className = 'search-result-card-image';
      image.loading = 'lazy';
      setCover(image, item);
      var title = document.createElement('span');
      title.className = 'search-result-card-title';
      title.textContent = item.title || uiText('ui.unnamedDrama', '未命名短剧');
      var meta = document.createElement('span');
      meta.className = 'search-result-card-meta';
      meta.textContent = catalogMeta(item);
      card.appendChild(dramaPoster(image, item));
      card.appendChild(title);
      card.appendChild(meta);
      card.addEventListener('click', function () { startPlayer(item, card); });
      card.addEventListener('focus', function () {
        try { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (ignore) { card.scrollIntoView(false); }
      });
      searchResults.appendChild(card);
    });
    return list;
  }

  function searchSuggestionType(kind) {
    var labels = {
      short_play_name: uiText('search.suggestionDrama', '短剧'),
      short_play_actor: uiText('search.suggestionActor', '演员'),
      short_play_role: uiText('search.suggestionRole', '角色'),
      album: uiText('search.suggestionAlbum', '专辑'),
      title: uiText('search.suggestionTitle', '标题'),
      common_query: uiText('search.suggestionKeyword', '热词')
    };
    return labels[kind] || labels.common_query;
  }

  function createSearchSuggestionIcon(kind) {
    var namespace = 'http://www.w3.org/2000/svg';
    var shapes = {
      short_play_actor: [
        ['circle', { cx: '12', cy: '8', r: '3.2' }],
        ['path', { d: 'M5 20a7 7 0 0 1 14 0' }]
      ],
      short_play_role: [
        ['circle', { cx: '10', cy: '7.5', r: '2.8' }],
        ['path', { d: 'M4.5 17.5a5.5 5.5 0 0 1 11 0M18 14.5l1 1.8 2 .3-1.5 1.4.4 2-1.9-.9-1.8.9.3-2-1.4-1.4 2-.3z' }]
      ],
      album: [
        ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }],
        ['path', { d: 'M8 8h8M8 12h8M8 16h5' }]
      ],
      title: [
        ['path', { d: 'M7 3h7l4 4v14H7zM14 3v5h5M10 12h5M10 16h5' }]
      ],
      common_query: [
        ['circle', { cx: '10.5', cy: '10.5', r: '5.8' }],
        ['path', { d: 'm15 15 5 5' }]
      ]
    };
    var wrapper = document.createElement('span');
    wrapper.className = 'search-suggestion-icon';
    wrapper.setAttribute('aria-hidden', 'true');
    var svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('focusable', 'false');
    var elements = shapes[kind] || shapes.common_query;
    elements.forEach(function (shape) {
      var element = document.createElementNS(namespace, shape[0]);
      Object.keys(shape[1]).forEach(function (attribute) { element.setAttribute(attribute, shape[1][attribute]); });
      element.setAttribute('fill', 'none');
      element.setAttribute('stroke', 'currentColor');
      element.setAttribute('stroke-width', '1.8');
      element.setAttribute('stroke-linecap', 'round');
      element.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(element);
    });
    wrapper.appendChild(svg);
    return wrapper;
  }

  function closeSearchSuggestions(restoreInput) {
    clearTimeout(searchSuggestionTimer);
    searchSuggestionTimer = null;
    if (searchSuggestionRequest && searchSuggestionRequest.abort) searchSuggestionRequest.abort();
    searchSuggestionRequest = null;
    ++searchSuggestionGeneration;
    searchSuggestionOpen = false;
    searchSuggestionFocusedKey = '';
    if (searchSuggestions) {
      searchSuggestions.classList.add('is-hidden');
      searchSuggestions.setAttribute('aria-hidden', 'true');
    }
    if (searchInput) searchInput.setAttribute('aria-expanded', 'false');
    if (restoreInput && searchInput) {
      searchSuggestionDismissedQuery = searchInput.value.trim();
      searchSuggestionReturnKey = '';
      goFocus(searchInput);
    }
  }

  // Keep the focus ring inside the suggestion scrollport. Android 6 may
  // place a focused first/last item exactly on the edge when using
  // scrollIntoView, which clips the two-pixel white outline.
  function keepSearchSuggestionFocusVisible(button) {
    if (!searchSuggestions || !button || !searchSuggestions.getBoundingClientRect || !button.getBoundingClientRect) return;
    var bounds = searchSuggestions.getBoundingClientRect();
    var rect = button.getBoundingClientRect();
    var inset = 6;
    var top = bounds.top + (searchSuggestions.clientTop || 0) + inset;
    var bottom = bounds.top + (searchSuggestions.clientTop || 0) + searchSuggestions.clientHeight - inset;
    var scrollTop = Number(searchSuggestions.scrollTop) || 0;
    var next = scrollTop;
    if (rect.top < top) next -= top - rect.top;
    else if (rect.bottom > bottom) next += rect.bottom - bottom;
    var max = Math.max(0, (Number(searchSuggestions.scrollHeight) || 0) - (Number(searchSuggestions.clientHeight) || 0));
    next = Math.max(0, Math.min(max, next));
    if (next !== scrollTop) searchSuggestions.scrollTop = next;
  }

  function renderSearchSuggestions(items) {
    if (!searchSuggestions) return;
    var activeElement = typeof androidShell !== 'undefined' && androidShell ? remoteFocusTarget() || document.activeElement : document.activeElement;
    var activeKey = activeElement && activeElement.dataset && activeElement.dataset.suggestionKey;
    var restoreSuggestionFocus = !!(activeElement && activeElement.closest && activeElement.closest('#search-suggestions')) || !!searchSuggestionFocusedKey;
    var previousKey = activeKey || searchSuggestionFocusedKey;
    searchSuggestionItems = (items || []).slice(0, 10);
    searchSuggestions.innerHTML = '';
    searchSuggestionItems.forEach(function (item, index) {
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'search-suggestion'; button.tabIndex = 0;
      button.dataset.focus = 'search-suggestion-' + index;
      button.dataset.suggestionKey = item.key || item.name;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false');
      button.setAttribute('aria-label', uiText('search.suggestionLabel', '搜索{value}', { value: item.name }));
      button.addEventListener('focus', function () {
        try { button.scrollIntoView({ block: 'nearest' }); } catch (ignore) { button.scrollIntoView(false); }
        keepSearchSuggestionFocusVisible(button);
      });
      var image = null;
      if (item.drama && item.drama.cover) {
        image = document.createElement('img'); image.className = 'search-suggestion-image'; image.alt = ''; image.loading = 'lazy'; setCover(image, item.drama);
      } else {
        image = createSearchSuggestionIcon(item.kind);
      }
      var copy = document.createElement('span'); copy.className = 'search-suggestion-copy';
      var name = document.createElement('span'); name.className = 'search-suggestion-name'; name.textContent = item.name;
      var meta = document.createElement('span'); meta.className = 'search-suggestion-meta';
      meta.textContent = item.meta || (item.kind === 'short_play_actor' ? uiText('search.suggestionActorMeta', '演员作品') : uiText('search.suggestionSearchMeta', '按此关键词搜索'));
      var kind = document.createElement('span'); kind.className = 'search-suggestion-kind'; kind.textContent = searchSuggestionType(item.kind);
      copy.appendChild(name); copy.appendChild(meta); button.appendChild(image); button.appendChild(copy); button.appendChild(kind);
      button.__suggestion = item;
      button.addEventListener('click', function () { activateSearchSuggestion(item, button); });
      searchSuggestions.appendChild(button);
    });
    if (!searchSuggestions.children.length) {
      closeSearchSuggestions(false);
      return;
    }
    searchSuggestionOpen = true;
    searchSuggestions.classList.remove('is-hidden'); searchSuggestions.setAttribute('aria-hidden', 'false');
    searchInput.setAttribute('aria-expanded', 'true');
    if (restoreSuggestionFocus) {
      var same = null;
      Array.prototype.forEach.call(searchSuggestions.querySelectorAll('.search-suggestion'), function (button) {
        if (button.dataset.suggestionKey === previousKey) same = button;
      });
      var target = same || firstVisible('.search-suggestion');
      if (target) goFocus(target);
    }
  }

  function restoreSearchSuggestionFocus() {
    if (!searchSuggestionReturnKey || !searchInput || !searchSuggestions || !searchSuggestionItems.length || pageMode() !== 'search') return false;
    if (!searchSuggestions.querySelector('.search-suggestion')) renderSearchSuggestions(searchSuggestionItems);
    else {
      searchSuggestionOpen = true;
      searchSuggestions.classList.remove('is-hidden'); searchSuggestions.setAttribute('aria-hidden', 'false');
      searchInput.setAttribute('aria-expanded', 'true');
    }
    var target = null;
    Array.prototype.forEach.call(searchSuggestions.querySelectorAll('.search-suggestion'), function (button) {
      if (button.dataset.suggestionKey === searchSuggestionReturnKey) target = button;
    });
    if (target) { goFocus(target); return true; }
    return false;
  }

  function loadSearchSuggestions(query) {
    query = String(query || '').trim();
    if (!query) { closeSearchSuggestions(false); return; }
    if (searchSuggestionRequest && searchSuggestionRequest.abort) searchSuggestionRequest.abort();
    var generation = ++searchSuggestionGeneration;
    searchSuggestionRequest = typeof AbortController === 'function' ? new AbortController() : null;
    var options = searchSuggestionRequest ? { signal: searchSuggestionRequest.signal } : {};
    fetchData('/api/v1/search/suggestions?q=' + encodeURIComponent(query), options).then(function (data) {
      if (generation !== searchSuggestionGeneration || !searchInput || searchInput.value.trim() !== query || pageMode() !== 'search') return;
      renderSearchSuggestions(data.items || []);
    }).catch(function (error) {
      if (generation !== searchSuggestionGeneration || error.name === 'AbortError') return;
      closeSearchSuggestions(false);
    }).then(function () { if (generation === searchSuggestionGeneration) searchSuggestionRequest = null; });
  }

  function scheduleSearchSuggestions() {
    if (!searchInput || pageMode() !== 'search') return;
    searchSuggestionReturnKey = '';
    clearTimeout(searchSuggestionTimer);
    var query = searchInput.value.trim();
    if (!query) { closeSearchSuggestions(false); return; }
    if (query === searchSuggestionDismissedQuery) { closeSearchSuggestions(false); return; }
    searchSuggestionDismissedQuery = '';
    searchSuggestionTimer = setTimeout(function () { loadSearchSuggestions(query); }, 240);
  }

  function activateSearchSuggestion(item, button) {
    if (!item) return;
    searchSuggestionReturnKey = button && button.dataset.suggestionKey || item.key || item.name;
    var returnFocus = searchInput;
    closeSearchSuggestions(false);
    if (item.kind === 'short_play_actor' && item.actor_id) {
      openActorWorks({ actor_id: item.actor_id, title: item.name }, false, returnFocus);
      return;
    }
    if (item.drama && item.drama.series_id) {
      openDetail(item.drama, undefined, returnFocus);
      return;
    }
    searchInput.value = item.name || searchInput.value;
    searchSuggestionReturnKey = '';
    goFocus(searchInput);
    submitSearch();
  }

  function lastSearchFilter() {
    var rows = document.querySelectorAll('.filter-row[data-filter-group]');
    var panel = document.getElementById('filter-panel');
    if (panel && panel.classList.contains('is-collapsed')) return firstVisible('#filter-toggle');
    var row = rows[rows.length - 1];
    return row && panel && !panel.classList.contains('is-hidden') ? row.querySelector('.is-active') || row.querySelector('button') : null;
  }

  function filterSummary() {
    var labels = [];
    filterRows.forEach(function (row) {
      var value = searchFilters[row.type];
      row.options.forEach(function (option) { if (value === option.id) labels.push(searchFilterLabel(row, option)); });
    });
    return labels.join(' · ') || uiText('ui.allDrama', '全部短剧');
  }

  function searchFilterLabel(row, option) {
    row = row || {};
    option = option || {};
    var rowKeys = {
      genre: 'search.category',
      sort: 'search.sort',
      creation_status: 'search.status',
      online_time: 'search.time',
      category_dim_theme: 'search.theme',
      category_dim_role: 'search.role',
      category_dim_epoch: 'search.background',
      gender: 'search.audience'
    };
    var optionKeys = {
      short_play: 'channel.real',
      comic_series: 'channel.comic',
      ai_series: 'rank.ai',
      hot_score: 'search.sortHot',
      online_time: 'search.sortLatest',
      hot_collect: 'search.sortFavorite',
      creation_status_0: 'search.finished',
      creation_status_1: 'search.ongoing',
      gender_male: 'new.male',
      gender_female: 'new.female'
    };
    var key = optionKeys[String(option.id || '')];
    if (key) return uiText(key, option.label || option.id);
    var rowKey = rowKeys[String(row.type || '')];
    // The API uses the same helper for a row heading and its options. Keep
    // headings on the locale resource instead of leaking the API's Chinese
    // label into a translated UI.
    if (option.id === row.type && rowKey) return uiText(rowKey, option.label || option.id);
    return option.id === '' && rowKey ? uiText('common.all', '全部') : option.label || option.id || uiText('common.all', '全部');
  }

  function toggleSearchFilters(focusAfter) {
    var panel = document.getElementById('filter-panel');
    var toggle = document.getElementById('filter-toggle');
    if (!panel || !toggle || panel.classList.contains('is-hidden')) return;
    searchFiltersExpanded = !panel.classList.contains('is-expanded');
    panel.classList.toggle('is-expanded', searchFiltersExpanded);
    panel.classList.toggle('is-collapsed', !searchFiltersExpanded);
    toggle.textContent = searchFiltersExpanded ? uiText('search.collapseFilter', '收起筛选') : uiText('search.expandFilter', '展开筛选');
    toggle.setAttribute('aria-expanded', String(searchFiltersExpanded));
    if (focusAfter !== false) goFocus(searchFiltersExpanded ? firstVisible('.search-filter') || toggle : toggle);
  }

  function selectSearchFilter(button) {
    var type = button.dataset.filterType;
    var value = button.dataset.filterValue || '';
    if ((searchFilters[type] || '') === value && !searchPager.error) return;
    searchFilters[type] = value;
    var refresh = type === 'genre';
    if (refresh) {
      // Theme/role/era options depend on genre. Reset these along with the
      // previous list cursor before requesting the new selector panel.
      ['category_dim_theme', 'category_dim_role', 'category_dim_epoch'].forEach(function (key) { delete searchFilters[key]; });
    }
    document.querySelectorAll('.search-filter').forEach(function (node) {
      var selected = (searchFilters[node.dataset.filterType] || '') === (node.dataset.filterValue || '');
      node.classList.toggle('is-active', selected);
      node.setAttribute('aria-pressed', String(selected));
    });
    document.getElementById('filter-state').textContent = filterSummary();
    loadBrowse(false, refresh);
  }

  function renderFilterRows(rows) {
    var current = document.activeElement;
    var focusKey = zoneOf(current) === 'searchFilters' ? current.dataset.focus : '';
    filterRows = rows;
    var container = document.getElementById('filter-rows');
    container.innerHTML = '';
    rows.forEach(function (row) {
      var line = document.createElement('div');
      line.className = 'filter-row';
      line.dataset.filterGroup = row.type;
      var label = document.createElement('strong');
      label.textContent = searchFilterLabel({ type: row.type }, { id: row.type, label: row.label });
      line.appendChild(label);
      var options = document.createElement('div');
      options.className = 'filter-options';
      [{ id: '', label: uiText('common.all', '全部') }].concat(row.options).forEach(function (option) {
        var button = document.createElement('button');
        button.className = 'search-filter';
        button.dataset.filterType = row.type;
        button.dataset.filterValue = option.id;
        button.dataset.focus = 'filter-' + row.type + '-' + (option.id || 'all');
        button.textContent = searchFilterLabel(row, option);
        var active = (searchFilters[row.type] || '') === option.id;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
        button.addEventListener('click', function () { selectSearchFilter(button); });
        button.addEventListener('focus', function () { button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
        options.appendChild(button);
      });
      line.appendChild(options);
      container.appendChild(line);
    });
    if (focusKey) goFocus(container.querySelector('[data-focus="' + focusKey + '"]') || firstSearchFilter());
    document.getElementById('filter-state').textContent = filterSummary();
  }

  function loadBrowse(append, refreshFilters) {
    if (append) return searchPager.load(searchPager.error !== '');
    var path = ({ comic_series: '/category/comic-drama', ai_series: '/category/ai-drama' })[searchFilters.genre] || '/category/real-drama';
    if (refreshFilters || !filterRows.length) searchPanelPending = true;
    var params = Object.assign({ path: path }, searchFilters);
    if (searchPanelPending) params.selectors = '1';
    searchKind = 'browse';
    document.getElementById('filter-panel').classList.remove('is-hidden');
    document.getElementById('search-browse').classList.add('is-hidden');
    document.getElementById('search-result-title').textContent = filterSummary();
    return searchPager.reset(params);
  }

  function beginBrowse() {
    searchInput.value = '';
    loadBrowse(false, !filterRows.length);
    goFocus(firstSearchFilter() || searchInput);
  }

  function dramaMeta(item) {
    var values = [];
    if (item.score) values.push(item.score + uiText('ui.scoreSuffix', '分'));
    if (item.episode_count) values.push(uiText('content.episodeCount', '全{count}集', { count: item.episode_count }));
    if (item.tags && item.tags.length) values.push(item.tags.slice(0, 2).join(' · '));
    return values.join(' · ') || uiText('app.name', '红果短剧');
  }

  function rankLabel() {
    var active = document.querySelector('.rank-subtab.is-active');
    return active ? active.textContent : uiText('ui.hotRank', '热播榜');
  }

  function rankFilterSummary() {
    var active = rankOptions.filter(function (option) { return option.id === rankSelection.rank; })[0];
    var sub = active && (active.children || []).filter(function (option) { return option.id === rankSelection.rank_sub; })[0];
    var labels = [];
    if (active && active.id !== 'all') labels.push(rankOptionLabel(active));
    if (sub && sub.label) labels.push(rankOptionLabel(sub));
    if (sub && rankSelection.rank_panel) {
      (sub.panels || []).some(function (group) {
        var option = (group.options || []).filter(function (item) { return item.id === rankSelection.rank_panel; })[0];
        if (option) { labels.push(rankOptionLabel(option)); return true; }
        return false;
      });
    }
    return labels.join(' · ') || uiText('ui.allRank', '全部榜单');
  }

  function rankFiltersCanCollapse(sub) {
    if (!sub) return false;
    if (/hot_play/i.test(String(sub.id || ''))) return true;
    return /recommend|hot_play/i.test(String(sub.id || ''));
  }

  function rankOptionLabel(option) {
    if (!option) return '';
    var id = String(option.id || '');
    var keys = {
      all: 'common.all',
      human: 'channel.real',
      comic_series_rank: 'channel.comic',
      ai_playlet: 'rank.ai',
      ranklist_hot_play_sc: 'rank.hot',
      human_hot_play: 'rank.hot',
      comic_series_hot_play: 'rank.hot',
      ai_playlet_hot_play: 'rank.hot',
      ranklist_subscribe: 'rank.reservation',
      ranklist_celebrity: 'rank.actor',
      ranklist_actor_fans: 'rank.starRank',
      series_album: 'modal.series',
      series_album_new_rank: 'rank.newSeason',
      other: 'rank.overall',
      gender_male: 'new.male',
      gender_female: 'new.female',
      genre: 'search.category',
      sort: 'search.sort',
      creation_status: 'search.status',
      online_time: 'search.time',
      category_dim_theme: 'search.theme',
      category_dim_role: 'search.role',
      category_dim_epoch: 'search.background',
      gender: 'search.audience'
    };
    if (keys[id]) return uiText(keys[id], option.label || id);
    if (!id && /^(总榜|综合)$/.test(String(option.label || ''))) return uiText('rank.overall', option.label);
    return option.label || id;
  }

  function updateRankFilterPanel(sub) {
    var panel = document.getElementById('rank-filter-panel');
    var heading = panel && panel.querySelector('.rank-filter-heading');
    if (!panel) return false;
    var collapsible = rankFiltersCanCollapse(sub);
    panel.classList.toggle('is-collapsible', collapsible);
    panel.classList.toggle('is-direct', !collapsible);
    if (heading) heading.classList.toggle('is-hidden', !collapsible);
    return collapsible;
  }

  function toggleRankFilters(focusAfter) {
    var panel = document.getElementById('rank-filter-panel');
    var toggle = document.getElementById('rank-filter-toggle');
    if (!panel || !toggle) return;
    var expanded = !panel.classList.contains('is-expanded');
    panel.classList.toggle('is-expanded', expanded);
    panel.classList.toggle('is-collapsed', !expanded);
    toggle.textContent = expanded ? uiText('search.collapseFilter', '收起筛选') : uiText('search.expandFilter', '展开筛选');
    toggle.setAttribute('aria-expanded', String(expanded));
    if (focusAfter !== false) goFocus(expanded ? firstVisible('.rank-panel.is-active') || firstVisible('.rank-panel') || toggle : toggle);
  }

  function renderMessage(container, className, message) {
    container.innerHTML = '';
    var empty = document.createElement('div');
    empty.className = className;
    empty.textContent = message;
    container.appendChild(empty);
  }

  function renderRankSelectors(data) {
    if (!data || !data.length) return;
    rankOptions = data;
    var key = document.activeElement && document.activeElement.dataset.focus;
    var priorZone = zoneOf(document.activeElement);
    var root = document.getElementById('rank-tabs');
    var subnav = document.getElementById('rank-subnav');
    var panels = document.getElementById('rank-panels');
    root.innerHTML = ''; subnav.innerHTML = ''; panels.innerHTML = '';
    var active = data.filter(function (x) { return x.id === rankSelection.rank; })[0] || data[0];
    rankSelection.rank = active.id;
    var children = active.children || [];
    var sub = children.filter(function (x) { return x.id === rankSelection.rank_sub; })[0] || children.filter(function (x) { return x.selected; })[0] || children[0];
    if (sub) rankSelection.rank_sub = sub.id;
    var collapsibleFilters = updateRankFilterPanel(sub);
    function button(option, cls, selected, target, handler) {
      var node = document.createElement('button'); node.className = cls + (selected ? ' is-active' : '');
      node.dataset.focus = cls + '-' + (option.id || 'all'); node.textContent = rankOptionLabel(option);
      node.setAttribute('aria-pressed', String(selected));
      node.addEventListener('click', handler);
      node.addEventListener('focus', function () { node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
      target.appendChild(node); return node;
    }
    data.forEach(function (option) {
      button(option, 'rank-tab', option === active, root, function () {
        rankSelection = { rank: option.id, rank_sub: '', rank_panel: '' };
        var child = (option.children || []).filter(function (x) { return /hot_play/i.test(String(x.id || '')); })[0] || (option.children || [])[0];
        if (child) rankSelection.rank_sub = child.id;
        renderRankSelectors(rankOptions); loadRank();
      });
    });
    children.forEach(function (option) { button(option, 'rank-subtab', option === sub, subnav, function () { rankSelection.rank_sub = option.id; rankSelection.rank_panel = ''; renderRankSelectors(rankOptions); loadRank(); }); });
    (sub && sub.panels || []).forEach(function (group) {
      var line = document.createElement('div'); line.className = 'rank-panel-row';
      var label = document.createElement('span'); label.textContent = rankOptionLabel({ id: group.type, label: group.label }); line.appendChild(label);
      var options = document.createElement('div'); options.className = 'rank-panel-options'; line.appendChild(options);
      group.options.forEach(function (option) { button(option, 'rank-panel', option.id === rankSelection.rank_panel, options, function () { rankSelection.rank_panel = option.id; renderRankSelectors(rankOptions); loadRank(); }); });
      panels.appendChild(line);
    });
    var filterState = document.getElementById('rank-filter-state');
    if (filterState) filterState.textContent = rankFilterSummary();
    var rankFilterToggle = document.getElementById('rank-filter-toggle');
    if (rankFilterToggle) rankFilterToggle.tabIndex = collapsibleFilters ? 0 : -1;
    if (['rankTabs', 'rankFilters', 'rankSubnav', 'rankPanels'].indexOf(priorZone) >= 0) {
      var match = Array.prototype.filter.call(document.querySelectorAll('[data-focus]'), function (node) { return node.dataset.focus === key; })[0];
      goFocus(match || firstVisible('.rank-tab.is-active') || firstRankFilterToggle());
    }
  }

  function openRankFilter() {
    if (!rankOptions.length) { showNotice(uiText('ui.rankFilterWaiting', '筛选条件还在读取，请稍候')); return; }
    rankDraftSelection = Object.assign({}, rankSelection);
    rankFilterOpen = true;
    var root = document.getElementById('rank-filter-options'); root.innerHTML = '';
    rankOptions.forEach(function (group) {
      var heading = document.createElement('strong'); heading.className = 'rank-filter-group-title'; heading.textContent = rankOptionLabel(group); root.appendChild(heading);
      (group.children || []).forEach(function (option) {
        var button = document.createElement('button'); button.className = 'rank-filter-option'; button.dataset.focus = 'rank-filter-' + option.id; button.textContent = rankOptionLabel(option);
        button.classList.toggle('is-selected', option.id === rankDraftSelection.rank_sub);
        button.addEventListener('click', function () { rankDraftSelection.rank = group.id; rankDraftSelection.rank_sub = option.id; rankDraftSelection.rank_panel = ''; root.querySelectorAll('.rank-filter-option').forEach(function (node) { node.classList.remove('is-selected'); }); button.classList.add('is-selected'); });
        root.appendChild(button);
        (option.panels || []).forEach(function (panel) { (panel.options || []).forEach(function (panelOption) { var child = document.createElement('button'); child.className = 'rank-filter-option rank-filter-detail'; child.dataset.focus = 'rank-filter-' + panelOption.id; child.textContent = rankOptionLabel({ id: panel.type, label: panel.label }) + '：' + rankOptionLabel(panelOption); child.classList.toggle('is-selected', panelOption.id === rankDraftSelection.rank_panel); child.addEventListener('click', function () { rankDraftSelection.rank = group.id; rankDraftSelection.rank_sub = option.id; rankDraftSelection.rank_panel = panelOption.id; root.querySelectorAll('.rank-filter-option').forEach(function (node) { node.classList.remove('is-selected'); }); child.classList.add('is-selected'); }); root.appendChild(child); }); });
      });
    });
    document.getElementById('rank-filter-modal').classList.remove('is-hidden'); document.getElementById('rank-filter-modal').setAttribute('aria-hidden', 'false');
    goFocus(firstVisible('.rank-filter-option') || document.getElementById('rank-filter-cancel'));
  }
  function closeRankFilter(restore) {
    rankFilterOpen = false; rankDraftSelection = null;
    document.getElementById('rank-filter-modal').classList.add('is-hidden'); document.getElementById('rank-filter-modal').setAttribute('aria-hidden', 'true');
    if (restore) goFocus(document.getElementById('rank-filter-open'));
  }

  function updateDetailActions() {
    if (!currentDetail) return;
    var favorite = document.getElementById('detail-favorite');
    var follow = document.getElementById('detail-follow');
    var entry = libraryEntry(currentDetail.series_id);
    var saved = !!(entry && entry.favorite_at);
    favorite.classList.toggle('is-active', saved);
    favorite.setAttribute('aria-pressed', String(saved));
    favorite.setAttribute('aria-label', uiText(saved ? 'ui.favorited' : 'ui.favorite', saved ? '已收藏' : '收藏'));
    favorite.querySelector('span').textContent = uiText(saved ? 'ui.favorited' : 'ui.favorite', saved ? '已收藏' : '收藏');
    var following = followIsActive(currentDetail);
    var ended = followState(currentDetail) === 'ended';
    follow.classList.toggle('is-active', following);
    follow.classList.toggle('is-hidden', ended);
    follow.setAttribute('aria-pressed', String(following));
    follow.setAttribute('aria-label', uiText(following ? 'ui.followed' : 'ui.follow', following ? '已追更' : '追更'));
    follow.querySelector('span').textContent = uiText(following ? 'ui.followed' : 'ui.follow', following ? '已追更' : '追更');
  }

  // Keep the actor focus ring inside its nested scrollport. Older Android
  // WebViews can leave the first or last grid item flush with the edge even
  // after scrollIntoView({ block: 'nearest' }), clipping the white ring.
  function keepDetailCastFocusVisible(button) {
    var list = document.getElementById('detail-cast-all');
    if (!list || !button || !list.getBoundingClientRect || !button.getBoundingClientRect) return;
    var bounds = list.getBoundingClientRect();
    var rect = button.getBoundingClientRect();
    var inset = 6;
    var top = bounds.top + (list.clientTop || 0) + inset;
    var bottom = bounds.top + (list.clientTop || 0) + list.clientHeight - inset;
    var scrollTop = Number(list.scrollTop) || 0;
    var next = scrollTop;
    if (rect.top < top) next -= top - rect.top;
    else if (rect.bottom > bottom) next += rect.bottom - bottom;
    var max = Math.max(0, (Number(list.scrollHeight) || 0) - (Number(list.clientHeight) || 0));
    next = Math.max(0, Math.min(max, next));
    if (next !== scrollTop) list.scrollTop = next;
  }

  function actorButton(name, actor, className) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('aria-label', actor.id ? uiText('ui.viewActorWorks', '查看{name}的作品', { name: name }) : name);
    button.disabled = !actor.id;
    if (actor.id) {
      button.dataset.actorId = actor.id;
      button.dataset.focus = 'detail-actor-' + actor.id;
      var image = document.createElement('img');
      image.alt = '';
      if (actor.avatar) image.src = actor.avatar;
      else image.className = 'is-hidden';
      button.appendChild(image);
      if (!actor.avatar) {
        var initial = document.createElement('span');
        initial.className = 'detail-cast-avatar';
        initial.textContent = (name || '演').slice(0, 1);
        button.appendChild(initial);
      }
      var label = document.createElement('span');
      label.textContent = name;
      button.appendChild(label);
      button.addEventListener('click', function () {
        openActorWorks({ actor_id: actor.id, title: name, intro: '', cover: actor.avatar });
      });
      if (className === 'detail-cast-modal-item') {
        button.addEventListener('focus', function () {
          try { button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (ignore) { button.scrollIntoView(false); }
          keepDetailCastFocusVisible(button);
        });
      }
    } else {
      var fallback = document.createElement('span');
      fallback.className = 'detail-cast-avatar';
      fallback.textContent = (name || '演').slice(0, 1);
      var fallbackName = document.createElement('span');
      fallbackName.textContent = name;
      button.appendChild(fallback);
      button.appendChild(fallbackName);
    }
    return button;
  }

  function renderDetailActors(actors) {
    var root = document.getElementById('detail-cast');
    var strip = document.getElementById('detail-cast-strip');
    var more = document.getElementById('detail-cast-more');
    strip.innerHTML = '';
    more.classList.add('is-hidden');
    actors = (actors || []).filter(function (actor) { return actor && actor.name; });
    root.classList.toggle('is-hidden', !actors.length);
    actors.slice(0, 5).forEach(function (actor) {
      strip.appendChild(actorButton(actor.name, actor, 'detail-cast-item'));
    });
    if (actors.length > 5) {
      more.textContent = uiText('ui.allActorsCount', '全部 {count} 位', { count: actors.length });
      more.classList.remove('is-hidden');
    }
    var all = document.getElementById('detail-cast-all');
    all.innerHTML = '';
    actors.forEach(function (actor) {
      all.appendChild(actorButton(actor.name, actor, 'detail-cast-modal-item'));
    });
  }

  function openDetailCast() {
    if (!currentDetail || !(currentDetail.actors || []).length) return;
    detailCastReturnFocus = document.activeElement;
    detailCastOpen = true;
    var modal = document.getElementById('detail-cast-modal');
    modal.classList.remove('is-hidden');
    modal.setAttribute('aria-hidden', 'false');
    goFocus(firstVisible('.detail-cast-modal-item') || document.getElementById('detail-cast-close'));
  }

  function closeDetailCast(restore) {
    detailCastOpen = false;
    var modal = document.getElementById('detail-cast-modal');
    modal.classList.add('is-hidden');
    modal.setAttribute('aria-hidden', 'true');
    var target = detailCastReturnFocus;
    detailCastReturnFocus = null;
    if (restore !== false) goFocus(target && document.contains(target) ? target : firstVisible('.detail-cast-item') || document.getElementById('detail-tab-episodes'));
  }

  function renderActorWorks(result) {
    var modal = document.getElementById('actor-works-modal');
    var list = document.getElementById('actor-works-list');
    var progress = document.getElementById('actor-works-progress');
    var retry = document.getElementById('actor-works-retry');
    document.getElementById('actor-works-name').textContent = result.actor && result.actor.name ? result.actor.name : uiText('ui.actorWorks', '演员作品');
    var avatar = document.getElementById('actor-works-avatar');
    if (result.actor && result.actor.avatar) { avatar.src = result.actor.avatar; avatar.classList.remove('is-hidden'); } else { avatar.removeAttribute('src'); avatar.classList.add('is-hidden'); }
    document.getElementById('actor-works-description').textContent = result.actor && result.actor.description ? result.actor.description : '';
    list.innerHTML = '';
    retry.classList.add('is-hidden');
    var items = result.items || [];
    if (!items.length) { progress.textContent = uiText('ui.actorWorksEmpty', '暂时没有找到该演员的作品'); return; }
    progress.textContent = uiText('ui.actorWorksCount', '共 {count} 部作品', { count: items.length });
    items.forEach(function (item, index) {
      var card = document.createElement('button');
      card.className = 'actor-work-card'; card.dataset.focus = 'actor-work-' + item.series_id;
      var image = document.createElement('img'); image.className = 'actor-work-image'; setCover(image, item);
      var title = document.createElement('strong'); title.className = 'actor-work-title'; title.textContent = item.title || uiText('ui.unnamedDrama', '未命名短剧');
      var meta = document.createElement('span'); meta.className = 'actor-work-meta'; meta.textContent = dramaMeta(item);
      card.appendChild(image); card.appendChild(title); card.appendChild(meta);
      card.addEventListener('click', function () {
        var returnFocus = actorWorksReturnFocus;
        closeActorWorks(false);
        if (detailCastOpen) closeDetailCast(false);
        if (detailModalOpen) closeDetail();
        startPlayer(item, returnFocus);
      });
      list.appendChild(card);
    });
    goFocus(firstVisible('.actor-work-card'));
  }

  function openActorWorks(item, preserveReturnFocus) {
    if (!item || !item.actor_id) return;
    if (actorWorksRequest && actorWorksRequest.abort) actorWorksRequest.abort();
    if (!preserveReturnFocus) actorWorksReturnFocus = arguments.length > 2 && arguments[2] ? arguments[2] : document.activeElement;
    actorWorksItem = item;
    actorWorksOpen = true;
    var generation = ++actorWorksGeneration;
    var modal = document.getElementById('actor-works-modal');
    modal.classList.remove('is-hidden'); modal.setAttribute('aria-hidden', 'false');
    document.getElementById('actor-works-name').textContent = item.title || uiText('ui.actorWorks', '演员作品');
    document.getElementById('actor-works-avatar').classList.add('is-hidden');
    document.getElementById('actor-works-description').textContent = item.intro || '';
    document.getElementById('actor-works-progress').textContent = uiText('ui.actorWorksLoading', '正在读取作品…');
    document.getElementById('actor-works-list').innerHTML = '';
    document.getElementById('actor-works-retry').classList.add('is-hidden');
    goFocus(document.getElementById('actor-works-close'));
    actorWorksRequest = typeof AbortController === 'function' ? new AbortController() : null;
    fetchData('/api/v1/actors/works?actor_id=' + encodeURIComponent(item.actor_id), actorWorksRequest ? { signal: actorWorksRequest.signal } : {}).then(function (data) {
      if (!actorWorksOpen || generation !== actorWorksGeneration) return;
      renderActorWorks(data);
    }).catch(function (error) {
      if (!actorWorksOpen || generation !== actorWorksGeneration || error.name === 'AbortError') return;
      document.getElementById('actor-works-progress').textContent = uiText('ui.actorWorksFailed', '作品读取失败：{error}', { error: localizedError(error, 'common.networkFailed', '连接失败') });
      document.getElementById('actor-works-retry').classList.remove('is-hidden');
      goFocus(document.getElementById('actor-works-retry'));
    }).then(function () { if (generation === actorWorksGeneration) actorWorksRequest = null; });
  }

  function closeActorWorks(restore) {
    if (actorWorksRequest && actorWorksRequest.abort) actorWorksRequest.abort();
    actorWorksRequest = null; ++actorWorksGeneration; actorWorksOpen = false;
    var modal = document.getElementById('actor-works-modal');
    modal.classList.add('is-hidden'); modal.setAttribute('aria-hidden', 'true');
    var target = actorWorksReturnFocus && document.contains(actorWorksReturnFocus) ? actorWorksReturnFocus : firstRankRow();
    actorWorksReturnFocus = null;
    actorWorksItem = null;
    if (restore !== false) {
      if (!restoreSearchSuggestionFocus()) goFocus(target);
      searchSuggestionReturnKey = '';
    }
  }

  function retryActorWorks() {
    if (!actorWorksItem) return;
    openActorWorks(actorWorksItem, true);
  }
  function applyRankFilter() {
    if (!rankDraftSelection) { closeRankFilter(true); return; }
    rankSelection = Object.assign({}, rankDraftSelection); closeRankFilter(false); renderRankSelectors(rankOptions); loadRank(); goFocus(document.getElementById('rank-filter-open'));
  }

  var radarOfficialKind = 'hot';
  var radarGrowthMetric = 'd_hot';
  var radarGrowthType = 'all';
  var radarOfficialLabels = { hot: uiText('ui.radarOfficial', '综合'), real: uiText('ui.radarReal', '真人'), ai: uiText('ui.radarAI', 'AI'), comic: uiText('ui.radarComic', '漫剧') };
  var radarGrowthMetricLabels = { d_hot: uiText('ui.radarHotDaily', '热度日增'), d_fav: uiText('ui.radarFavoriteDaily', '收藏日增'), r_hot: uiText('ui.radarHotRate', '热度增长率') };
  var radarGrowthTypeLabels = { all: uiText('ui.radarAll', '全部'), real: uiText('ui.radarReal', '真人'), ai: uiText('ui.radarAI', 'AI'), comic: uiText('ui.radarComic', '漫剧'), unknown: uiText('ui.radarUnknown', '未知') };
  function radarNumber(value) {
    if (value === null || value === undefined || value === '' || !isFinite(Number(value))) return '—';
    var number = Number(value) || 0;
    if (number >= 100000000) return (number / 100000000).toFixed(number >= 1000000000 ? 1 : 2).replace(/\.0+$/, '') + uiText('ui.unitBillion', '亿');
    if (number >= 10000) return (number / 10000).toFixed(number >= 1000000 ? 0 : 1).replace(/\.0+$/, '') + uiText('ui.unitTenThousand', '万');
    return String(number);
  }
  function radarDelta(delta) {
    if (delta === null || delta === undefined) return uiText('ui.newRank', '新上榜');
    var number = Number(delta) || 0;
    return number > 0 ? '↑ ' + number : number < 0 ? '↓ ' + Math.abs(number) : '— ' + uiText('ui.flat', '持平');
  }
  function radarDate(data) {
    return data && (data.date || data.rank_date) ? uiText('ui.dataDate', '数据日期 {date}', { date: data.date || data.rank_date }) : '';
  }
  function radarBucket(kind) { return radarData && radarData.ranks ? radarData.ranks[kind] : null; }
  function radarTypeLabel(type) { return radarGrowthTypeLabels[type] || uiText('ui.radarUnknown', '未知'); }
  function radarGrowthIndex() {
    var result = {};
    var items = radarData && radarData.growth && radarData.growth.items || [];
    items.forEach(function (item) { if (item && item.id != null) result[String(item.id)] = item; });
    return result;
  }
  function radarOfficialModel(source, index, kind, growthIndex) {
    var growth = growthIndex[String(source.id)] || {};
    return {
      series_id: source.id,
      title: source.title || uiText('ui.unnamedDrama', '未命名短剧'),
      rank: source.rank || index + 1,
      delta: source.delta,
      status_tags: source.status_tags || [],
      type: kind === 'hot' ? (growth.type || 'unknown') : kind,
      hot: growth.hot,
      d_hot: growth.d_hot,
      d_fav: growth.d_fav,
      score: growth.score,
      streak: source.streak,
      radar_rank: source
    };
  }
  function radarGrowthItems() {
    var items = radarData && radarData.growth && radarData.growth.items || [];
    var type = radarGrowthType;
    return items.filter(function (item) { return type === 'all' || (item.type || 'unknown') === type; }).slice().sort(function (a, b) {
      return (Number(b[radarGrowthMetric]) || 0) - (Number(a[radarGrowthMetric]) || 0);
    });
  }
  function radarCell(className, text) {
    var cell = document.createElement('span');
    cell.className = className || 'radar-cell';
    cell.textContent = text == null || text === '' ? '—' : String(text);
    return cell;
  }
  function radarRate(value) { return value == null || value === '' ? '—' : (Number(value) * 100).toFixed(2).replace(/\.00$/, '') + '%'; }
  function radarSignedNumber(value) { return value === null || value === undefined || value === '' || !isFinite(Number(value)) ? '—' : '+' + radarNumber(value); }
  function radarScore(value) { return value == null || value === '' ? '—' : String(value); }
  function radarOfficialRow(source, index, kind, growthIndex) {
    var item = radarOfficialModel(source, index, kind, growthIndex);
    var row = document.createElement('div');
    row.className = 'radar-row radar-official-row'; row.tabIndex = 0; row.setAttribute('role', 'button');
    row.setAttribute('aria-label', uiText('ui.playLabel', '播放：') + item.title); row.dataset.focus = 'radar-official-' + item.series_id;
    row.__radarItem = item;
    row.appendChild(radarCell('radar-rank', item.rank));
    row.appendChild(radarCell('radar-delta ' + (Number(item.delta) > 0 ? 'is-up' : Number(item.delta) < 0 ? 'is-down' : ''), radarDelta(item.delta)));
    row.appendChild(radarCell('radar-title-cell', item.title));
    row.appendChild(radarCell('radar-type-cell', radarTypeLabel(item.type)));
    row.appendChild(radarCell('radar-number-cell radar-hot-cell', radarNumber(item.hot)));
    row.appendChild(radarCell('radar-number-cell', radarSignedNumber(item.d_hot)));
    row.appendChild(radarCell('radar-number-cell', radarSignedNumber(item.d_fav)));
    row.appendChild(radarCell('radar-score-cell', radarScore(item.score)));
    row.appendChild(radarCell('radar-number-cell', item.streak == null ? '—' : uiText('ui.daysOnRank', '{days}天', { days: item.streak })));
    row.addEventListener('click', function () { startPlayer(row.__radarItem, row); });
    row.addEventListener('focus', function () { try { row.scrollIntoView({ block: 'nearest' }); } catch (ignore) {} });
    return row;
  }
  function radarGrowthRow(source, index) {
    var item = Object.assign({}, source, { series_id: source.id, type: source.type || 'unknown', radar_growth: source });
    var row = document.createElement('div');
    row.className = 'radar-row radar-growth-row'; row.tabIndex = 0; row.setAttribute('role', 'button');
    row.setAttribute('aria-label', uiText('ui.playLabel', '播放：') + (item.title || uiText('ui.unnamedDrama', '未命名短剧'))); row.dataset.focus = 'radar-growth-' + item.series_id;
    row.__radarItem = item;
    row.appendChild(radarCell('radar-rank', index + 1));
    row.appendChild(radarCell('radar-title-cell', item.title || uiText('ui.unnamedDrama', '未命名短剧')));
    row.appendChild(radarCell('radar-type-cell', radarTypeLabel(item.type)));
    row.appendChild(radarCell('radar-number-cell radar-hot-cell', radarNumber(item.hot)));
    row.appendChild(radarCell('radar-number-cell radar-growth-primary', radarSignedNumber(item.d_hot)));
    row.appendChild(radarCell('radar-rate-cell', radarRate(item.r_hot)));
    row.appendChild(radarCell('radar-number-cell', radarSignedNumber(item.d_fav)));
    row.appendChild(radarCell('radar-number-cell', radarSignedNumber(item.d7_hot)));
    row.addEventListener('click', function () { startPlayer(row.__radarItem, row); });
    row.addEventListener('focus', function () { try { row.scrollIntoView({ block: 'nearest' }); } catch (ignore) {} });
    return row;
  }
  function renderRadar() {
    var officialRows = document.getElementById('radar-official-rows');
    var growthRows = document.getElementById('radar-growth-rows');
    var status = document.getElementById('radar-status');
    var officialSection = document.getElementById('radar-official-section');
    var growthSection = document.getElementById('radar-growth-section');
    officialRows.innerHTML = ''; growthRows.innerHTML = '';
    officialSection.classList.toggle('is-hidden', radarView !== 'official');
    growthSection.classList.toggle('is-hidden', radarView !== 'growth');
    var official = radarBucket(radarOfficialKind);
    var growth = radarGrowthItems();
    if (!official || !official.items || !official.items.length) renderMessage(officialRows, 'rank-empty', radarData ? uiText('ui.radarOfficialEmpty', '官方榜暂无数据。') : uiText('ui.radarLoading', '正在读取榜单雷达…'));
    else {
      var index = radarGrowthIndex();
      official.items.forEach(function (source, i) { officialRows.appendChild(radarOfficialRow(source, i, radarOfficialKind, index)); });
    }
    if (!growth.length) renderMessage(growthRows, 'rank-empty', radarData ? uiText('ui.radarGrowthEmpty', '当前筛选暂无飙升数据。') : uiText('ui.radarLoading', '正在读取榜单雷达…'));
    else growth.forEach(function (source, i) { growthRows.appendChild(radarGrowthRow(source, i)); });
    var rankDate = radarData && radarData.ranks && radarData.ranks[radarOfficialKind];
    var growthDate = radarData && radarData.growth;
    var stale = radarData && (radarData.ranks_stale || radarData.growth_stale);
    status.textContent = uiText('ui.radarStatus', '官方榜 {official} · 飙升榜 {growth} · 当前按 {metric} · {type}{stale} · 官方 {officialCount} 部 · 飙升 {growthCount} 部', { official: radarDate(rankDate) || uiText('ui.noDate', '暂无日期'), growth: radarDate(growthDate) || uiText('ui.noDate', '暂无日期'), metric: radarGrowthMetricLabels[radarGrowthMetric], type: radarGrowthTypeLabels[radarGrowthType], stale: stale ? ' · ' + uiText('ui.recentData', '使用最近成功数据') : '', officialCount: official && official.items ? official.items.length : 0, growthCount: growth.length });
    document.querySelectorAll('[data-radar-official]').forEach(function (node) { var active = node.dataset.radarOfficial === radarOfficialKind; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
    document.querySelectorAll('[data-radar-metric]').forEach(function (node) { var active = node.dataset.radarMetric === radarGrowthMetric; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
    document.querySelectorAll('[data-radar-type]').forEach(function (node) { var active = node.dataset.radarType === radarGrowthType; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
    document.querySelectorAll('[data-radar-view]').forEach(function (node) { var active = node.dataset.radarView === radarView; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
  }
  function setRadarView(view, focusAfter) {
    radarView = view === 'growth' ? 'growth' : 'official';
    renderRadar();
    if (focusAfter !== false) goFocus(radarView === 'growth' ? firstRadarGrowthMetric() : firstRadarOfficialTab());
  }
  function setRadarOfficial(kind) { if (!radarOfficialLabels[kind]) return; radarOfficialKind = kind; renderRadar(); }
  function setRadarGrowthMetric(metric) { if (!radarGrowthMetricLabels[metric]) return; radarGrowthMetric = metric; renderRadar(); }
  function setRadarGrowthType(type) { if (!radarGrowthTypeLabels[type]) return; radarGrowthType = type; renderRadar(); }
  function loadRadar(force) {
    if (radarRequest) radarRequest.abort();
    var request = radarRequest = typeof AbortController === 'function' ? new AbortController() : null;
    var generation = ++radarGeneration;
    document.getElementById('radar-status').textContent = uiText('ui.radarLoading', '正在读取榜单雷达…');
    var url = '/api/v1/radar' + (force ? '?refresh=' + Date.now() : '');
    return fetchData(url, request ? { signal: request.signal } : {})
      .then(function (data) {
        if (generation !== radarGeneration) return;
        radarData = data; renderRadar();
      }).catch(function (error) {
        if (error.name === 'AbortError' || generation !== radarGeneration) return;
        document.getElementById('radar-status').textContent = uiText('ui.radarFailed', '榜单雷达暂时读取失败：{error}', { error: localizedError(error, 'common.networkFailed', '连接失败') });
        renderMessage(document.getElementById('radar-official-rows'), 'rank-empty', uiText('ui.radarOfficialUnavailable', '暂时没有官方榜数据，请稍后刷新。'));
        renderMessage(document.getElementById('radar-growth-rows'), 'rank-empty', uiText('ui.radarGrowthUnavailable', '暂时没有飙升榜数据，请稍后刷新。'));
      }).then(function () { if (radarRequest === request) radarRequest = null; });
  }
  function setRankView(view, focusAfter) {
    rankView = view === 'radar' ? 'radar' : 'official';
    var radar = rankView === 'radar';
    document.getElementById('rank-official-controls').classList.toggle('is-hidden', radar);
    document.querySelector('#rank-page .rank-layout').classList.toggle('is-hidden', radar);
    document.getElementById('rank-radar-view').classList.toggle('is-hidden', !radar);
    document.querySelectorAll('.rank-view-tab').forEach(function (node) { var active = node.dataset.rankView === rankView; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });
    if (radarData) renderRadar();
    if (radar) loadRadar(false);
    if (focusAfter !== false) goFocus(radar ? firstRadarViewTab() || firstRadarOfficialTab() || firstRankView() : firstVisible('.rank-tab.is-active') || firstRankTab());
  }

  function renderRank(items, append) {
    if (!append) { rankItems = []; rankList.innerHTML = ''; }
    var start = rankItems.length;
    rankItems = rankItems.concat(items || []);
    document.getElementById('rank-list-title').textContent = rankLabel();
    document.getElementById('rank-list-update').textContent = rankItems.length ? uiText('ui.rankLoaded', '已加载 {count}{unit}', { count: rankItems.length, unit: rankSelection.rank === 'ranklist_celebrity' ? uiText('ui.personUnit', '位') : uiText('ui.dramaUnit', '部') }) : uiText('ui.rankEmpty', '暂时没有榜单内容');
    if (!rankItems.length) {
      rankList.innerHTML = '<div class="rank-empty">' + uiText('ui.rankEmptyRetry', '暂时没有榜单内容，请稍后刷新。') + '</div>';
      return;
    }
    (items || []).forEach(function (item, localIndex) {
      var index = start + localIndex;
      var row = document.createElement('div');
      row.className = 'rank-row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', (item.actor_id ? uiText('ui.actorLabel', '演员：') : uiText('ui.playLabel', '播放：')) + item.title);
      row.dataset.index = String(index);
      row.dataset.focus = 'rank-item-' + item.series_id;
      row.__rankItem = item;
      var rank = document.createElement('span');
      rank.className = 'rank-row-rank';
      rank.textContent = String(item.rank || index + 1);
      var image = document.createElement('img');
      image.className = 'rank-row-image';
      setCover(image, item);
      var copy = document.createElement('span');
      copy.className = 'rank-row-copy';
      var title = document.createElement('span');
      title.className = 'rank-row-title';
      title.textContent = item.title || uiText('ui.unnamedDrama', '未命名短剧');
      var meta = document.createElement('span');
      meta.className = 'rank-row-meta';
      meta.textContent = dramaMeta(item);
      var intro = document.createElement('span');
      intro.className = 'rank-row-intro';
      intro.textContent = item.intro || uiText('ui.noIntro', '暂无简介');
      var heat = document.createElement('span');
      heat.className = 'rank-row-heat';
      heat.textContent = item.heat || item.favorite_text || item.like_text || '';
      copy.appendChild(title); copy.appendChild(meta); copy.appendChild(intro); copy.appendChild(heat);
      var side = document.createElement('span');
      side.className = 'rank-row-side';
      var play = document.createElement('button');
      play.className = 'rank-row-play';
      play.textContent = uiText('ui.playButton', '▶ 播放');
      var detail = document.createElement('button');
      detail.className = 'rank-row-detail';
      detail.textContent = uiText('ui.detailButton', '详情');
      play.addEventListener('click', function (event) { event.stopPropagation(); startPlayer(item, play); });
      detail.addEventListener('click', function (event) { event.stopPropagation(); openDetail(item); });
      if (item.actor_id) {
        var actor = document.createElement('button');
        actor.className = 'rank-row-actor'; actor.textContent = uiText('ui.viewWorks', '查看作品'); actor.dataset.focus = 'rank-actor-' + item.actor_id;
        actor.addEventListener('click', function (event) { event.stopPropagation(); openActorWorks(item); });
        side.appendChild(actor);
      } else { side.appendChild(play); side.appendChild(detail); }
      row.appendChild(rank); row.appendChild(item.actor_id ? image : dramaPoster(image, item)); row.appendChild(copy); row.appendChild(side);
      row.addEventListener('click', function (event) { if (item.actor_id) openActorWorks(item); else if (!event.target.closest('button')) startPlayer(item, row); });
      row.addEventListener('focus', function () { try { row.scrollIntoView({ block: 'nearest' }); } catch (ignore) {} });
      rankList.appendChild(row);
    });
  }

  function loadRank() { return rankPager.reset(Object.assign({}, rankSelection)); }

  function renderNew(items, append) {
    if (!append) { newItems = []; newGrid.innerHTML = ''; }
    newItems = newItems.concat(items || []);
    if (!newItems.length) {
      newGrid.innerHTML = '<div class="search-result-empty">' + uiText('ui.newDramaEmpty', '暂时没有新剧内容。') + '</div>';
      return;
    }
    (items || []).forEach(function (item) {
      newGrid.appendChild(publicationCard(item, 'new-item-'));
    });
  }

  function renderFollow(items, append) {
    if (!append) followGrid.innerHTML = '';
    if (!followPager.items.length && !followPager.busy) {
      renderMessage(followGrid, 'list-empty', accountData && accountData.logged_in ? uiText('ui.followEmpty', '还没有追更中的短剧。') : uiText('ui.followLogin', '登录红果账号后查看追更。'));
      return;
    }
    (items || []).forEach(function (item) {
      var card = document.createElement('button');
      card.className = 'follow-card'; card.dataset.focus = 'follow-' + item.series_id;
      var image = document.createElement('img'); image.className = 'follow-card-image'; setCover(image, item);
      var copy = document.createElement('span'); copy.className = 'follow-card-copy';
      var title = document.createElement('strong'); title.textContent = item.title || uiText('ui.unnamedDrama', '未命名短剧');
      var watched = item.latest_watched_episode || (libraryEntry(item.series_id) || {}).episode || 0;
      var meta = document.createElement('span'); meta.textContent = watched ? uiText('ui.watchedEpisode', '已看第{episode}集', { episode: watched }) : item.episode_count ? uiText('content.episodeCount', '全{count}集', { count: item.episode_count }) : uiText('common.updating', '更新中');
      var status = document.createElement('span'); status.className = 'follow-card-status';
    status.textContent = followState(item) === 'ended' ? uiText('common.finished', '已完结') : item.has_watched_latest_episode ? uiText('ui.followCaughtUp', '已追平') : item.show_update_frequency || uiText('common.updating', '更新中');
      copy.appendChild(title); copy.appendChild(meta); copy.appendChild(status); card.appendChild(dramaPoster(image, item)); card.appendChild(copy);
      card.addEventListener('click', function () { startPlayer(item, card); });
      card.addEventListener('focus', function () { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
      followGrid.appendChild(card);
    });
  }

  function publicationCard(item, prefix) {
      var card = document.createElement('button');
      card.className = 'new-card';
      card.dataset.focus = prefix + item.series_id;
      var poster = document.createElement('span'); poster.className = 'new-card-poster drama-poster';
      var image = document.createElement('img');
      image.className = 'new-card-image'; setCover(image, item);
      var episodeCount = document.createElement('span'); episodeCount.className = 'new-card-episodes'; episodeCount.textContent = item.episode_count ? uiText('ui.totalEpisodes', '共{count}集', { count: item.episode_count }) : '';
      poster.appendChild(image); if (episodeCount.textContent) poster.appendChild(episodeCount); updatePosterSeason(poster, item);
      var title = document.createElement('span'); title.className = 'new-card-title'; title.textContent = item.title || uiText('ui.unnamedDrama', '未命名短剧');
      var meta = document.createElement('span'); meta.className = 'new-card-meta'; meta.textContent = (item.tags || []).slice(0, 3).join(' · ') || (prefix === 'reservation-' ? uiText('common.online', '已上线') : uiText('ui.newDrama', '新剧'));
      var score = document.createElement('span'); score.className = 'new-card-score'; score.textContent = item.score ? item.score + ' ' + uiText('ui.scoreSuffix', '分') : (item.episode_count ? uiText('ui.totalEpisodes', '共{count}集', { count: item.episode_count }) : '');
      card.appendChild(poster); card.appendChild(title); card.appendChild(meta); card.appendChild(score);
      card.addEventListener('click', function () { startPlayer(item, card); });
      card.addEventListener('focus', function () { try { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (ignore) {} });
      return card;
  }

  function rememberReservationOverride(item, reserved) {
    var id = item && item.reservation_id;
    if (!id) return;
    if (!reserved) { delete reservationOverrides[id]; return; }
    reservationOverrides[id] = {
      item: Object.assign({}, item, { upcoming: true, reserved: true }),
      reserved: true,
      seen: false,
      expires: Date.now() + reservationOverrideTTL
    };
  }
  function writeReservation(item, reserved, signal) {
    var options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_id: item.reservation_id, reserved: reserved }) };
    if (signal) options.signal = signal;
    return fetchData('/api/v1/reservation', options).then(function (result) {
      if (!result.accepted) throw new Error(apiError(result, 200, 'common.operationFailed', '红果未接受预约请求'));
      return result;
    });
  }
  function reservationPendingMessage() {
    return uiText('ui.reservationPending', '预约请求已提交，但红果列表尚未确认。请稍后到“我的预约 → 待上线”刷新核对。');
  }
  function applyReservationOverride(item) {
    var id = item && item.reservation_id;
    var local = id && reservationOverrides[id];
    if (!local) return item;
    if (local.expires <= Date.now()) { delete reservationOverrides[id]; return item; }
    if (local.reserved) item.reserved = true;
    return item;
  }
  function activeReservationOverrideCount() {
    var count = 0; var now = Date.now();
    Object.keys(reservationOverrides).forEach(function (id) {
      var local = reservationOverrides[id];
      if (!local || local.expires <= now) { delete reservationOverrides[id]; return; }
      if (!local.seen && local.reserved) count++;
    });
    return count;
  }
  function resetReservationOverrideVisibility() {
    Object.keys(reservationOverrides).forEach(function (id) {
      var local = reservationOverrides[id];
      if (local && local.expires > Date.now()) local.seen = false;
      else delete reservationOverrides[id];
    });
  }
  function reservationMetadata(data, pager) {
    (data.items || []).forEach(function (item) {
      var local = item && item.reservation_id && reservationOverrides[item.reservation_id];
      if (local && local.expires > Date.now()) local.seen = true;
      applyReservationOverride(item);
    });
    updateReservationCounts(data, pager);
  }
  function updateReservationCounts(data) {
    var pending = activeReservationOverrideCount() > 0;
    if (typeof data.online_total_count === 'number') reservationCounts.online = data.online_total_count;
    if (typeof data.offline_total_count === 'number') {
      var upcoming = data.offline_total_count;
      if (pending && reservationCounts.upcoming === null) upcoming += pending;
      if (pending && reservationCounts.upcoming !== null) upcoming = Math.max(upcoming, reservationCounts.upcoming);
      reservationCounts.upcoming = upcoming;
    }
    document.querySelectorAll('.reservation-tab').forEach(function (tab) {
      var mode = tab.dataset.reservationMode; var count = reservationCounts[mode];
      tab.textContent = (mode === 'online' ? uiText('common.online', '已上线') : uiText('common.upcoming', '待上线')) + (count === null ? '' : ' ' + count);
    });
  }

  function renderCalendarDays(schema) {
    if (!schema || !schema.dates || !schema.dates.length) return;
    if (calendarSchema && JSON.stringify(calendarSchema) === JSON.stringify(schema)) return;
    calendarSchema = schema;
    if (!calendarDate) calendarDate = schema.default_date;
    var key = document.activeElement && document.activeElement.dataset.focus;
    var onDays = zoneOf(document.activeElement) === 'calendarDays';
    dateStrip.innerHTML = '';
    schema.dates.forEach(function (value) {
      var date = new Date(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)));
      var day = document.createElement('button'); day.className = 'calendar-day' + (value === calendarDate ? ' is-active' : '');
      day.dataset.focus = 'calendar-day-' + value; day.dataset.date = value;
      var week = document.createElement('span'); week.textContent = value === schema.current_date ? uiText('ui.today', '今天') : uiText('ui.weekPrefix', '周') + uiText('ui.weekday' + date.getDay(), ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]);
      var label = document.createElement('strong'); label.textContent = (date.getMonth() + 1) + '/' + date.getDate();
      day.appendChild(week); day.appendChild(label);
      day.addEventListener('click', function () { calendarDate = value; document.querySelectorAll('.calendar-day').forEach(function (node) { node.classList.toggle('is-active', node === day); }); loadCalendar(); });
      day.addEventListener('focus', function () { day.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
      dateStrip.appendChild(day);
    });
    if (onDays) goFocus(dateStrip.querySelector('[data-focus="' + key + '"]') || firstCalendarDay());
    else { var selected = dateStrip.querySelector('.is-active'); if (selected) selected.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  }

  function changeReservation(item, button) {
    if (!item.reservation_id || button.disabled) return;
    if (!accountData || !accountData.logged_in) {
      showNotice(uiText('ui.loginAccountFirst', '请先登录红果账号')); activatePage(document.querySelector('.side-item[data-page="account"]')); return;
    }
    var epoch = accountEpoch; var reserve = !item.reserved;
    var originPage = pageMode(); var hadFocus = document.activeElement === button;
    button.disabled = true; button.textContent = reserve ? uiText('ui.reservationInProgress', '正在预约…') : uiText('ui.reservationCanceling', '正在取消…');
    writeReservation(item, reserve)
      .then(function (result) {
        if (epoch !== accountEpoch) return;
        if (!result.confirmed) { showNotice(reservationPendingMessage()); return; }
        item.reserved = reserve;
        rememberReservationOverride(item, reserve);
        if (reservationCounts.upcoming !== null && item.upcoming) { reservationCounts.upcoming = Math.max(0, reservationCounts.upcoming + (reserve ? 1 : -1)); updateReservationCounts({}); }
        document.querySelectorAll('.publication-row').forEach(function (row) { if (row.__item && row.__item.reservation_id === item.reservation_id) { row.__item.reserved = reserve; var b = row.querySelector('.publication-action'); if (b) b.textContent = reserve ? uiText('ui.cancelReservation', '取消预约') : uiText('ui.reserve', '预约'); } });
        if (!reserve && originPage === 'follows' && pageMode() === 'follows' && followView === 'reservations' && reservationMode === 'upcoming' && document.contains(button)) {
          var row = button.closest('.publication-row'); var next = row.nextElementSibling || row.previousElementSibling;
          var focused = hadFocus && (document.activeElement === button || document.activeElement === document.body);
          reservationPager.items = reservationPager.items.filter(function (x) { return x.reservation_id !== item.reservation_id; });
          reservationPager.buffer = reservationPager.buffer.filter(function (x) { return x.reservation_id !== item.reservation_id; });
          row.remove(); if (focused) goFocus(next || firstVisible('.reservation-tab.is-active'));
          if (!reservationPager.items.length) renderPublications([], false, true);
        }
        showNotice(reserve ? uiText('ui.reserved', '已预约') : uiText('ui.reservationCanceled', '已取消预约'));
      }).catch(function (error) { if (epoch === accountEpoch) showNotice(localizedError(error, 'common.operationFailed', '操作未完成，请重试。')); })
      .then(function () {
        if (epoch !== accountEpoch) return;
        button.disabled = false; button.textContent = item.reserved ? uiText('ui.cancelReservation', '取消预约') : uiText('ui.reserve', '预约');
        if (hadFocus && pageMode() === originPage && document.contains(button) && document.activeElement === document.body) goFocus(button);
      });
  }
  function prepareReservationItems(items, append, container) {
    var result = (items || []).map(function (item) { return applyReservationOverride(item); });
    var existing = {};
    if (append && container) container.querySelectorAll('[data-reservation-id]').forEach(function (node) {
      if (node.dataset.reservationId) existing[node.dataset.reservationId] = true;
    });
    result = result.filter(function (item) {
      var id = item && item.reservation_id;
      if (!id || !existing[id]) return true;
      return false;
    });
    if (!append) {
      var present = {};
      result.forEach(function (item) { if (item && item.reservation_id) present[item.reservation_id] = true; });
      Object.keys(reservationOverrides).forEach(function (id) {
        var local = reservationOverrides[id];
        if (!local || local.expires <= Date.now()) { delete reservationOverrides[id]; return; }
        if (local.reserved && !local.seen && !present[id]) result.push(Object.assign({}, local.item));
      });
    }
    return result;
  }
  function renderPublications(items, append, reservations) {
    var container = reservations ? document.getElementById('reservation-list') : calendarList;
    if (!append) container.innerHTML = '';
    if (reservations && reservationMode === 'upcoming') items = prepareReservationItems(items, append, container);
    if (!items.length && !container.children.length) renderMessage(container, 'calendar-empty', reservations ? uiText('ui.noReservation', '暂无{status}的预约', { status: reservationMode === 'online' ? uiText('common.online', '已上线') : uiText('common.upcoming', '待上线') }) : uiText('ui.noSchedule', '这一天暂无上新安排'));
    items.forEach(function (item) {
      if (reservations && reservationMode === 'online') {
        var card = publicationCard(item, 'reservation-'); card.classList.add('reservation-row'); card.dataset.reservationId = item.reservation_id || ''; card.__item = item;
        container.appendChild(card); return;
      }
      var row = document.createElement('div'); row.className = 'publication-row ' + (reservations ? 'reservation-row' : 'calendar-row'); row.tabIndex = 0; row.dataset.reservationId = item.reservation_id || '';
      row.dataset.focus = (reservations ? 'reservation-' : 'calendar-') + (item.reservation_id || item.series_id); row.__item = item;
      var image = document.createElement('img'); image.loading = 'lazy'; setCover(image, item); row.appendChild(image);
      var copy = document.createElement('div'); copy.className = 'publication-copy';
      var title = document.createElement('strong'); title.textContent = item.title;
      var meta = document.createElement('span'); meta.textContent = dramaMeta(item);
      var summary = document.createElement('p'); summary.textContent = item.intro || '';
      var schedule = document.createElement('span'); schedule.className = 'publication-date';
      var scheduled = item.publish_time ? new Date(item.publish_time * 1000) : null;
      var scheduleTime = scheduled && !isNaN(scheduled.getTime()) ? scheduled.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      schedule.textContent = item.upcoming ? uiText('ui.upcoming', '待上线') + ' · ' + (scheduleTime ? uiText('ui.publishExpected', '预计 {time} 上线', { time: scheduleTime }) : item.publish_text || uiText('ui.publishPending', '上线时间待定')) : uiText('common.online', '已上线') + (scheduleTime ? ' · ' + scheduleTime : '');
      copy.appendChild(title); copy.appendChild(meta); copy.appendChild(summary); copy.appendChild(schedule); row.appendChild(copy);
      if (!item.upcoming || item.reservation_id) {
        var action = document.createElement('button'); action.className = 'publication-action';
        action.dataset.focus = row.dataset.focus + (item.upcoming ? '-reserve' : '-play');
        action.textContent = item.upcoming ? item.reserved ? uiText('ui.cancelReservation', '取消预约') : uiText('ui.reserve', '预约') : uiText('common.play', '播放');
        action.addEventListener('click', function (event) { event.stopPropagation(); if (item.upcoming) changeReservation(item, action); else startPlayer(item, row); }); row.appendChild(action);
      }
      row.addEventListener('click', function (event) { if (event.target.closest('button')) return; if (item.upcoming) { var action = row.querySelector('button'); if (action) goFocus(action); else showNotice(uiText('ui.notOnline', '这部短剧尚未上线')); } else startPlayer(item, row); });
      row.addEventListener('focus', function () { row.scrollIntoView({ block: 'nearest' }); });
      container.appendChild(row);
    });
  }
  function genderParam() { return ({ male: '1', female: '0' })[newGender] || '2'; }
  function loadCalendar() { return calendarPager.reset({ date: calendarDate }); }
  function loadNew() { return newPager.reset({ gender: genderParam() }); }
  function renderNewMode() {
    var calendar = newMode === 'calendar';
    // The confirmed calendar contract does not apply audience filters.
    document.querySelector('.new-filters').classList.toggle('is-hidden', calendar);
    dateStrip.classList.toggle('is-hidden', !calendar); newGrid.classList.toggle('is-hidden', calendar); calendarList.classList.toggle('is-hidden', !calendar);
    document.getElementById('new-pagination').classList.toggle('is-hidden', calendar);
    document.getElementById('calendar-pagination').classList.toggle('is-hidden', !calendar);
  }
  function switchNewMode(mode) {
    newMode = mode === 'calendar' ? 'calendar' : 'recommend';
    document.querySelectorAll('.new-tab').forEach(function (node) { node.classList.toggle('is-active', node.dataset.newMode === newMode); });
    newPager.cancel(); calendarPager.cancel(); renderNewMode();
    if (newMode === 'calendar') { if (!calendarPager.loaded) loadCalendar(); else queueTailCheck(); }
    else { if (!newPager.loaded) loadNew(); else queueTailCheck(); }
  }
  function renderReservations(mode, restoring) {
    reservationMode = mode || reservationMode;
    document.getElementById('reservation-list').className = reservationMode === 'online' ? 'new-grid reservation-grid' : 'calendar-list';
    document.querySelectorAll('.reservation-tab').forEach(function (node) {
      var selected = node.dataset.reservationMode === reservationMode;
      node.classList.toggle('is-active', selected);
      node.setAttribute('aria-selected', String(selected));
    });
    if (restoring && reservationPager.loaded) { queueTailCheck(); return; }
    if (!accountData || !accountData.logged_in) {
      reservationPager.cancel(); reservationPager.items = []; reservationPager.loaded = false;
      var list = document.getElementById('reservation-list'); list.innerHTML = '';
      var empty = document.createElement('div'); empty.className = 'calendar-empty reservation-login';
      var message = document.createElement('p'); message.textContent = uiText('ui.reservationLoginHint', '登录后查看你的预约'); empty.appendChild(message); list.appendChild(empty);
      var login = document.createElement('button'); login.className = 'publication-action'; login.dataset.focus = 'reservation-login'; login.textContent = uiText('ui.loginAccount', '登录红果账号'); login.addEventListener('click', function () { activatePage(document.querySelector('.side-item[data-page="account"]')); });
      empty.appendChild(login); return;
    }
    resetReservationOverrideVisibility();
    reservationPager.reset({ mode: reservationMode });
  }

  function switchLibraryView(kind) {
    if (['favorites', 'likes'].indexOf(kind) < 0 || pageMode() === kind) return;
    var item = document.querySelector('.side-item[data-page="favorites"]');
    if (!item) return;
    libraryEditing = false;
    shell.dataset.mode = kind;
    document.querySelectorAll('.side-item').forEach(function (node) { node.classList.toggle('is-active', node === item); });
    renderLibrary(false);
    goFocus(firstVisible('.library-tab[data-library-view="' + kind + '"]'));
  }

  function switchFollowView(view, shouldFocus, restoring) {
    followView = view === 'reservations' ? 'reservations' : 'follow';
    var reservations = followView === 'reservations';
    if (reservations && followNotificationViewOpen) {
      followNotificationViewOpen = false;
      followNotificationReturnFocus = null;
    }
    document.querySelectorAll('.follow-tab').forEach(function (tab) {
      var selected = tab.dataset.followView === followView;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    var showNotifications = !reservations && followNotificationViewOpen;
    followListView.classList.toggle('is-hidden', reservations || showNotifications);
    followNotificationView.classList.toggle('is-hidden', !showNotifications);
    if (followActions) followActions.classList.toggle('is-hidden', reservations || showNotifications);
    document.getElementById('reservations-view').classList.toggle('is-hidden', !reservations);
    if (reservations) {
      renderReservations(reservationMode, restoring);
    } else if (!accountData || !accountData.logged_in) {
      renderMessage(followGrid, 'list-empty', uiText('ui.followLogin', '登录红果账号后查看追更。'));
    } else if (!followPager.loaded) {
      followPager.reset({});
    } else {
      queueTailCheck();
    }
    if (shouldFocus !== false) goFocus(firstVisible('.follow-tab.is-active'));
  }

  function submitSearch() {
    closeSearchSuggestions(false);
    var query = window.HongguoSearchHistory.normalize(searchInput ? searchInput.value : '');
    if (!query) { showNotice(uiText('content.searchLength', '请输入不超过100字的剧名或关键词')); goFocus(searchInput); return; }
    var returnTarget = remoteFocusTarget() || document.activeElement;
    if (androidShell && window.HongguoTVInput && typeof window.HongguoTVInput.finishSearchEditing === 'function') window.HongguoTVInput.finishSearchEditing();
    searchInput.value = query;
    activeSearchQuery = query; searchKind = 'keyword';
    document.getElementById('filter-panel').classList.add('is-hidden'); document.getElementById('search-browse').classList.remove('is-hidden');
    document.getElementById('search-result-title').textContent = uiText('ui.loadedSearchPrefix', '搜索：{query}', { query: query });
    var result = searchPager.reset({ q: query });
    searchPager.historyEpoch = searchHistoryEpoch;
    var generation = searchPager.generation;
    result.then(function () {
      if (generation !== searchPager.generation || activeSearchQuery !== query || pageMode() !== 'search') return;
      if (searchPager.error) {
        if (document.activeElement === returnTarget || remoteFocusTarget() === returnTarget) {
          var retry = firstVisible('#search-pagination .list-retry');
          if (retry) goFocus(retry);
        }
        return;
      }
      if (!searchPager.loaded) return;
      if (document.activeElement === returnTarget) goFocus(firstSearchResult() || firstSearchAction());
    });
  }

  function renderSearchHistory(items) {
    var container = document.getElementById('search-history-items');
    var focused = document.activeElement;
    var wasKeyword = focused && focused.__searchQuery;
    var inHistory = focused && focused.closest('#search-history');
    container.innerHTML = '';
    items.forEach(function (query, index) {
      var button = document.createElement('button');
      button.className = 'search-history-action'; button.dataset.focus = 'search-history-' + index;
      button.__searchQuery = query; button.textContent = query; button.title = query;
      button.addEventListener('click', function () { searchInput.value = query; submitSearch(); });
      button.addEventListener('focus', function () { button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
      container.appendChild(button);
    });
    document.getElementById('search-history').classList.toggle('is-hidden', !items.length);
    if (!inHistory) container.scrollLeft = 0;
    if (inHistory && !confirmOpen && pageMode() === 'search') {
      var target = null;
      container.querySelectorAll('button').forEach(function (button) { if (button.__searchQuery === wasKeyword) target = button; });
      goFocus(target || firstVisible('.search-history-action') || firstSearchAction());
    }
  }

  function confirmClearSearchHistory() {
    ++confirmationGeneration;
    confirmReturnFocus = document.activeElement;
    confirmOperation = function () { ++searchHistoryEpoch; return searchHistory.clear(); };
    confirmOpen = true;
    document.getElementById('confirm-title').textContent = uiText('ui.clearSearchTitle', '清空最近搜索？');
    document.getElementById('confirm-copy').textContent = uiText('ui.clearSearchCopy', '清空这台设备保存的搜索关键词。');
    document.getElementById('confirm-accept').textContent = uiText('common.clear', '清空');
    document.getElementById('confirm-modal').classList.remove('is-hidden');
    document.getElementById('confirm-modal').setAttribute('aria-hidden', 'false');
    goFocus(document.getElementById('confirm-cancel'));
  }

  function closeSearchScan(restore) {
    searchScanOpen = false;
    if (searchNumberScan) searchNumberScan.stop();
    document.getElementById('search-scan-modal').classList.add('is-hidden');
    document.getElementById('search-scan-modal').setAttribute('aria-hidden', 'true');
    document.getElementById('search-scan-title').textContent = uiText('ui.scanSearchTitle', '手机扫码搜索');
    document.getElementById('search-scan-copy').textContent = uiText('ui.scanSearchCopy', '手机输入或粘贴剧名，发送后在电视上搜索');
    document.getElementById('search-scan-hint').innerHTML = uiText('ui.scanHint', '手机和电视需在同一局域网<br>二维码5分钟有效，关闭后失效');
    document.getElementById('search-scan-close').textContent = uiText('ui.scanBackSearch', '返回搜索');
    var target = searchScanReturnFocus; searchScanReturnFocus = null;
    if (restore && pageMode() === 'search') goFocus(focusables().indexOf(target) >= 0 ? target : firstVisible('#search-scan'));
  }

  function openSearchScan() {
    if (desktopShell || pageMode() !== 'search' || searchScanOpen || applicationInBackground) return;
    searchScanReturnFocus = document.activeElement;
    searchScanOpen = true;
    document.getElementById('search-scan-title').textContent = uiText('ui.scanSearchTitle', '手机扫码搜索');
    document.getElementById('search-scan-copy').textContent = uiText('ui.scanSearchCopy', '手机输入或粘贴剧名，发送后在电视上搜索');
    document.getElementById('search-scan-hint').innerHTML = uiText('ui.scanHint', '手机和电视需在同一局域网<br>二维码5分钟有效，关闭后失效');
    document.getElementById('search-scan-close').textContent = uiText('ui.scanBackSearch', '返回搜索');
    document.getElementById('search-scan-modal').classList.remove('is-hidden');
    document.getElementById('search-scan-modal').setAttribute('aria-hidden', 'false');
    goFocus(document.getElementById('search-scan-close'));
    searchNumberScan.start('search');
  }

  function closeDanmakuScan(restore) {
    if (!danmakuScanOpen) return;
    danmakuScanOpen = false;
    if (danmakuNumberScan) danmakuNumberScan.stop();
    document.getElementById('search-scan-modal').classList.add('is-hidden');
    document.getElementById('search-scan-modal').setAttribute('aria-hidden', 'true');
    document.getElementById('search-scan-title').textContent = uiText('ui.scanSearchTitle', '手机扫码搜索');
    document.getElementById('search-scan-copy').textContent = uiText('ui.scanSearchCopy', '手机输入或粘贴剧名，发送后在电视上搜索');
    document.getElementById('search-scan-hint').innerHTML = uiText('ui.scanHint', '手机和电视需在同一局域网<br>二维码5分钟有效，关闭后失效');
    var target = danmakuScanReturnFocus; danmakuScanReturnFocus = null;
    if (restore !== false && playerOptionsOpen) goFocus(target && focusables().indexOf(target) >= 0 ? target : document.getElementById('player-compose-input'));
  }

  function openDanmakuScan() {
    if (desktopShell || !playerOptionsOpen || danmakuScanOpen || searchScanOpen || !composeSession || composeBusy || applicationInBackground) return;
    danmakuScanReturnFocus = document.activeElement;
    danmakuScanOpen = true;
    document.getElementById('search-scan-title').textContent = uiText('ui.scanDanmakuTitle', '手机扫码发弹幕');
    document.getElementById('search-scan-copy').textContent = uiText('ui.scanDanmakuCopy', '手机输入或粘贴弹幕，完成后回填到电视');
    document.getElementById('search-scan-hint').innerHTML = uiText('ui.scanHint', '手机和电视需在同一局域网<br>二维码5分钟有效，关闭后失效');
    document.getElementById('search-scan-close').textContent = uiText('ui.scanBackDanmaku', '返回弹幕');
    document.getElementById('search-scan-modal').classList.remove('is-hidden');
    document.getElementById('search-scan-modal').setAttribute('aria-hidden', 'false');
    goFocus(document.getElementById('search-scan-close'));
    danmakuNumberScan.start('danmaku');
  }

  function loadCatalog(title) {
    resetEndRecommendations();
    recommendationSession = null;
    episodePrefetch.cancel(); cancelPlaybackPreparation();
    saveProgress(true); activePlayback = null; ++feedGeneration;
    if (typeof syncNativePlaybackPageState === 'function') syncNativePlaybackPageState();
    document.getElementById('hero-video').pause();
    releasePlaybackAudio();
    document.getElementById('hero-video').removeAttribute('src');
    document.getElementById('hero-video').classList.remove('has-source');
    clearLastPlaybackFrame();
    document.getElementById('hero').classList.remove('is-preparing-video');
    document.getElementById('hero-video').load();
    resetDanmaku(); closeDiscussion(false);
    featuredItem = null; feedItems = []; feedIndex = -1;
    updateSeasonControl(null);
    showRecommendationPlaceholder(uiText('ui.readingRecommendations', '正在读取推荐'));
    var tab = recommendationChannel();
    if (tab === '45' && (!accountData || !accountData.logged_in)) {
      feedPager.cancel(); renderFeed([]);
      showRecommendationPlaceholder(uiText('ui.followLoginShort', '登录后查看关注内容'), uiText('ui.loginInAccount', '在我的账号中登录红果账号。')); return Promise.resolve([]);
    }
    setCatalogHeading(title || uiText('nav.recommend', '推荐'));
    return feedPager.reset({ channel: tab }).then(function firstContent() {
      if (pageMode() !== 'recommend' || feedPager.params.channel !== tab) return;
      if (!feedPager.items.length && feedPager.hasMore() && !feedPager.error) return feedPager.load().then(firstContent);
      if (pageMode() === 'recommend' && feedPager.error) {
        showRecommendationPlaceholder(uiText('ui.recommendationFailed', '推荐加载失败'), feedPager.error + uiText('ui.reselectChannelRetry', '，重新选择频道可重试。'));
      }
    });
  }

  function seriesMessage(text, retry) {
    document.getElementById('detail-series-message').textContent = text || '';
    document.getElementById('detail-series-retry').classList.toggle('is-hidden', !retry);
  }

  function cancelSeasonSwitch() {
    ++seasonSwitchGeneration;
    if (seasonSwitchRequest) seasonSwitchRequest.abort();
    seasonSwitchRequest = null; seasonSwitchID = '';
    updateSeriesRows();
  }

  function resetSeriesPanel() {
    cancelSeasonSwitch();
    ++seriesGeneration;
    if (seriesRequest) seriesRequest.abort();
    if (seriesReservationRequest) seriesReservationRequest.abort();
    seriesRequest = null; seriesReservationRequest = null; seriesReservationID = '';
    seriesItems = []; seriesLoaded = false;
    seriesFocusCurrent = false;
    document.getElementById('detail-series-list').innerHTML = '';
    document.getElementById('detail-series-count').textContent = '';
    seriesMessage('');
  }

  function rememberSeasonCatalog(id, entry) {
    var index = seasonCatalogKeys.indexOf(id);
    if (index >= 0) seasonCatalogKeys.splice(index, 1);
    seasonCatalogCache[id] = entry; seasonCatalogKeys.push(id);
    while (seasonCatalogKeys.length > 24) delete seasonCatalogCache[seasonCatalogKeys.shift()];
  }

  function updateSeasonReservation(id, reserved) {
    function update(items) { items.forEach(function (item) { if (item.reservation_id === id) item.reserved = reserved; }); }
    update(seriesItems);
    seasonCatalogKeys.forEach(function (key) {
      var entry = seasonCatalogCache[key];
      if (entry && entry.items) update(entry.items);
    });
  }

  function resetSeasonCatalog() {
    seasonCatalogRequests.forEach(function (request) { request.abort(); });
    seasonCatalogRequests = []; seasonCatalogCache = {}; seasonCatalogKeys = [];
    updateSeasonControl(null);
  }

  // Cache only the official season metadata, never media URLs or playback parsing.
  // The selector and its shortcut share the request and account-scoped result.
  function getSeasonCatalog(id) {
    var entry = seasonCatalogCache[id];
    if (entry && entry.epoch === accountEpoch && (entry.pending || entry.expires > Date.now())) return entry.promise;
    var epoch = accountEpoch; var request = new AbortController();
    seasonCatalogRequests.push(request);
    entry = { epoch: epoch, pending: true, expires: 0 };
    rememberSeasonCatalog(id, entry);
    entry.promise = fetchData('/api/v1/series/seasons?series_id=' + encodeURIComponent(id), { signal: request.signal }).then(function (result) {
      if (epoch !== accountEpoch) throw new Error(uiText('ui.accountSwitched', '账号已切换'));
      if (!Array.isArray(result.items)) throw new Error(uiText('content.seriesInvalid', '系列剧响应无效'));
      var seen = {};
      entry.items = result.items.filter(function (item) {
        if (!item || !/^[1-9][0-9]*$/.test(item.series_id || '') || seen[item.series_id]) return false;
        seen[item.series_id] = true; applyReservationOverride(item); return true;
      });
      entry.pending = false; entry.expires = Date.now() + 120000;
      entry.items.forEach(function (item) { rememberSeasonCatalog(item.series_id, entry); });
      rememberSeasonCatalog(id, entry);
      if (playbackMenuHintCandidate || (document.getElementById('playback-menu-hint') && !document.getElementById('playback-menu-hint').classList.contains('is-hidden'))) updatePlaybackMenuHintCopy(activePlayback);
      return entry.items;
    }).catch(function (error) {
      if (seasonCatalogCache[id] === entry) delete seasonCatalogCache[id];
      throw error;
    }).then(function (items) {
      seasonCatalogRequests = seasonCatalogRequests.filter(function (value) { return value !== request; });
      return items;
    }, function (error) {
      seasonCatalogRequests = seasonCatalogRequests.filter(function (value) { return value !== request; });
      throw error;
    });
    return entry.promise;
  }

  function updateSeasonControl(item) {
    var button = document.querySelector('[data-action="seasons"]');
    var id = item && item.series_id || '';
    var known = id && seasonCatalogCache[id];
    var hinted = item && (item.is_multi_season || posterSeasonLabel(item) || known && known.items && known.items.length > 1);
    if (id && seasonControlID === id && seasonControlState) return;
    var generation = ++seasonControlGeneration;
    seasonControlID = id; seasonControlState = id ? 'loading' : '';
    button.classList.toggle('is-hidden', !hinted);
    updatePlaybackCommandMenu();
    if (!hinted && document.activeElement === button) goFocus(document.querySelector('[data-action="episodes"]'));
    setControlIcon('seasons', uiText('ui.selectSeasonLoading', '选季…'), 'icon-seasons'); button.setAttribute('aria-busy', id ? 'true' : 'false');
    if (!id) {
      return;
    }
    // A base title can be season one without a suffix or a multi-season flag.
    // Ask the official selector for every new drama; ordinary ones stay hidden.
    getSeasonCatalog(id).then(function (items) {
      if (generation !== seasonControlGeneration || !featuredItem || featuredItem.series_id !== id) return;
      seasonControlState = 'loaded';
      var count = items.filter(function (season) { return season.playable && !season.upcoming; }).length;
      setControlIcon('seasons', uiText('ui.selectSeasonCount', '选季 · {count} 季', { count: count }), 'icon-seasons'); button.setAttribute('aria-busy', 'false');
      var hasSeasons = items.length > 1 || items.some(function (season) { return !!(season.season_index > 0 || season.label || posterSeasonLabel(season)); });
      button.classList.toggle('is-hidden', !hasSeasons);
      updatePlaybackCommandMenu();
      if (!hasSeasons && document.activeElement === button) goFocus(document.querySelector('[data-action="episodes"]'));
    }).catch(function () {
      if (generation !== seasonControlGeneration) return;
      seasonControlState = 'error'; setControlIcon('seasons', uiText('ui.selectSeason', '选季'), 'icon-seasons'); button.setAttribute('aria-busy', 'false');
    });
  }

  function focusCurrentSeason() {
    var row = currentSeriesRow();
    var list = document.getElementById('detail-series-list');
    if (row && list) {
      var listRect = list.getBoundingClientRect();
      var rowRect = row.getBoundingClientRect();
      var centeredTop = list.scrollTop + rowRect.top - listRect.top - (list.clientHeight - row.offsetHeight) / 2;
      list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, centeredTop));
    }
    if (seriesFocusCurrent && detailTab === 'series' && document.activeElement.id === 'detail-tab-series') {
      seriesFocusCurrent = false; if (row) goFocus(row);
    }
  }

  function currentSeriesRow() {
    var id = activePlayback && activePlayback.item.series_id || detailSeriesID;
    return Array.from(document.querySelectorAll('.series-row')).filter(function (row) { return row.dataset.seriesId === id; })[0] || null;
  }

  function updateSeriesRows() {
    document.querySelectorAll('.series-row').forEach(function (row, index) {
      var item = seriesItems[index]; if (!item) return;
      var playing = !!(activePlayback && activePlayback.item.series_id === item.series_id);
      row.classList.toggle('is-current', playing || !activePlayback && detailSeriesID === item.series_id);
      row.setAttribute('aria-current', playing || !activePlayback && detailSeriesID === item.series_id ? 'true' : 'false');
      var entry = libraryEntry(item.series_id);
      var status = uiText('ui.unavailable', '暂不可播放');
      if (item.upcoming) status = item.reservation_id ? item.reserved ? uiText('ui.cancelReservation', '取消预约') : uiText('ui.reserve', '预约') : uiText('ui.upcoming', '待上线');
      else if (item.playable) status = playing ? uiText('common.playing', '播放中') : entry && entry.last_played_at ? uiText('ui.continuePlaying', '继续播放') : uiText('common.play', '播放');
      if (seasonSwitchID === item.series_id) status = uiText('ui.switching', '正在切换…');
      if (seriesReservationID === item.reservation_id && seriesReservationRequest) status = uiText('ui.submittingReservation', '正在提交…');
      row.querySelector('.series-status').textContent = status;
      row.setAttribute('aria-busy', seasonSwitchID === item.series_id || seriesReservationID === item.reservation_id && !!seriesReservationRequest ? 'true' : 'false');
    });
  }

  function selectDetailTab(tab) {
    if (!detailModalOpen) return;
    if (tab !== detailTab) { cancelSeasonSwitch(); seriesMessage(''); }
    detailTab = tab;
    detailFocusPending = false;
    document.querySelectorAll('.detail-tab').forEach(function (node) {
      var selected = node.id === 'detail-tab-' + tab;
      node.classList.toggle('is-active', selected); node.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    document.getElementById('detail-episode-panel').classList.toggle('is-hidden', tab !== 'episodes');
    document.getElementById('detail-series-panel').classList.toggle('is-hidden', tab !== 'series');
    document.getElementById('detail-reviews-panel').classList.toggle('is-hidden', tab !== 'reviews');
    document.getElementById('detail-related-panel').classList.toggle('is-hidden', tab !== 'related');
    goFocus(document.getElementById('detail-tab-' + tab));
    if (tab === 'series') {
      if (!seriesLoaded) loadSeriesSeasons();
      else { updateSeriesRows(); focusCurrentSeason(); }
    }
    if (tab === 'reviews' || tab === 'related') renderDetailSocial(tab);
  }

  function renderDetailSocial(tab) {
    if (!currentDetail) return;
    var isReviews = tab === 'reviews';
    var list = document.getElementById(isReviews ? 'detail-reviews-list' : 'detail-related-list');
    var message = document.getElementById(isReviews ? 'detail-reviews-message' : 'detail-related-message');
    list.innerHTML = '';
    if (isReviews) {
      (currentDetail.reviews || []).forEach(function (review) {
        var card = document.createElement('article'); card.className = 'review-card'; card.tabIndex = 0; card.dataset.focus = 'review-' + (review.id || Math.random());
        var author = document.createElement('strong'); author.textContent = review.user_name || uiText('content.user', '红果用户');
        var copy = document.createElement('p'); copy.textContent = review.content;
        var meta = document.createElement('small'); meta.textContent = [review.rating ? review.rating + uiText('ui.scoreSuffix', '分') : '', review.digg_count ? uiText('ui.likeCount', '赞 {count}', { count: review.digg_count }) : ''].filter(Boolean).join(' · ');
        card.appendChild(author); card.appendChild(copy); card.appendChild(meta); list.appendChild(card);
      });
      message.textContent = currentDetail.reviews && currentDetail.reviews.length ? '' : uiText('ui.noReviews', '暂无剧评。');
    } else {
      (currentDetail.related || []).forEach(function (item) {
        var card = document.createElement('button'); card.className = 'related-card'; card.dataset.focus = 'related-' + item.series_id;
        var image = document.createElement('img'); image.className = 'related-card-image'; setCover(image, item);
        var title = document.createElement('strong'); title.textContent = item.title || uiText('ui.unnamedDrama', '未命名短剧');
        var meta = document.createElement('span'); meta.textContent = item.episode_count ? uiText('content.episodeCount', '全{count}集', { count: item.episode_count }) : uiText('app.name', '红果短剧');
        card.appendChild(dramaPoster(image, item)); card.appendChild(title); card.appendChild(meta); card.addEventListener('click', function () { openDetail(item); }); list.appendChild(card);
      });
      message.textContent = currentDetail.related && currentDetail.related.length ? '' : uiText('ui.noRelated', '暂无相关推荐。');
    }
    if (tab === detailTab) goFocus(firstVisible(isReviews ? '.review-card' : '.related-card') || document.getElementById('detail-tab-' + tab));
  }

  function loadSeriesSeasons() {
    if (seriesRequest || !detailModalOpen || !seriesRootID) return;
    if (document.activeElement.id === 'detail-series-retry') goFocus(document.getElementById('detail-tab-series'));
    var generation = ++seriesGeneration; var epoch = accountEpoch;
    var request = new AbortController(); seriesRequest = request;
    seriesMessage(uiText('ui.readingSeries', '正在读取系列剧…'));
    getSeasonCatalog(seriesRootID).then(function (items) {
      if (!detailModalOpen || request.signal.aborted || generation !== seriesGeneration || epoch !== accountEpoch) return;
      seriesItems = items; seriesLoaded = true;
      var list = document.getElementById('detail-series-list'); list.innerHTML = '';
      seriesItems.forEach(function (item) {
        var row = document.createElement('button'); row.className = 'series-row'; row.dataset.seriesId = item.series_id; row.dataset.focus = 'series-' + item.series_id;
        var image = document.createElement('img'); image.className = 'series-cover'; image.alt = ''; setCover(image, item);
        var copy = document.createElement('span'); copy.className = 'series-copy';
        var title = document.createElement('span'); title.className = 'series-title'; title.textContent = item.title;
        var meta = document.createElement('span'); meta.className = 'series-meta'; meta.textContent = [item.label, item.subtitle || (item.episode_count ? uiText('content.episodeCount', '全{count}集', { count: item.episode_count }) : '')].filter(Boolean).join(' · ');
        copy.appendChild(title); copy.appendChild(meta);
        var status = document.createElement('span'); status.className = 'series-status';
        row.appendChild(image); row.appendChild(copy); row.appendChild(status);
        row.addEventListener('focus', function () { row.scrollIntoView({ block: 'nearest' }); });
        row.addEventListener('click', function () { if (item.upcoming) reserveSeriesSeason(item); else switchSeriesSeason(item); });
        list.appendChild(row);
      });
      document.getElementById('detail-series-count').textContent = seriesItems.length ? String(seriesItems.length) : '';
      updateSeriesRows(); seriesMessage(seriesItems.length ? '' : uiText('ui.noOtherSeasons', '这部短剧暂无同系列的其他季。'));
      if (featuredItem && seriesItems.some(function (item) { return item.series_id === featuredItem.series_id; })) {
        seasonControlState = ''; updateSeasonControl(featuredItem);
      }
      if (detailTab === 'series') focusCurrentSeason();
      if (document.activeElement.id === 'detail-series-retry') goFocus(document.getElementById('detail-tab-series'));
    }).catch(function (error) {
      if (generation === seriesGeneration && epoch === accountEpoch && detailModalOpen && error.name !== 'AbortError') seriesMessage(uiText('ui.seriesLoadFailed', '系列剧加载失败：{error}', { error: localizedError(error, 'common.networkFailed', '连接失败') }), true);
    }).then(function () { if (seriesRequest === request) seriesRequest = null; });
  }

  function reserveSeriesSeason(item) {
    if (!item.reservation_id) { seriesMessage(uiText('ui.seasonNotReservable', '这季尚未开放预约。')); return; }
    if (!accountData || !accountData.logged_in) { seriesMessage(uiText('ui.loginBeforeReserve', '请先关闭面板，在左侧“我的”登录账号后再预约。')); return; }
    if (seriesReservationRequest) return;
    var generation = seriesGeneration; var epoch = accountEpoch; var reserved = !item.reserved;
    var request = new AbortController(); seriesReservationRequest = request; seriesReservationID = item.reservation_id;
    updateSeriesRows(); seriesMessage('');
    writeReservation(item, reserved, request.signal).then(function (result) {
      if (epoch !== accountEpoch || generation !== seriesGeneration || !detailModalOpen) return;
      if (!result.confirmed) { seriesMessage(reservationPendingMessage()); return; }
      item.reserved = reserved; rememberReservationOverride(item, reserved); updateSeasonReservation(item.reservation_id, reserved);
      reservationPager.loaded = false; calendarPager.loaded = false;
      if (reservationCounts.upcoming !== null) { reservationCounts.upcoming = Math.max(0, reservationCounts.upcoming + (reserved ? 1 : -1)); updateReservationCounts({}); }
      document.querySelectorAll('.publication-row').forEach(function (row) {
        if (row.__item && row.__item.reservation_id === item.reservation_id) {
          row.__item.reserved = reserved;
          var button = row.querySelector('.publication-action'); if (button) button.textContent = reserved ? uiText('ui.cancelReservation', '取消预约') : uiText('ui.reserve', '预约');
        }
      });
      seriesMessage(reserved ? uiText('ui.reservationSuccess', '预约成功。') : uiText('ui.reservationCanceledPeriod', '已取消预约。'));
    }).catch(function (error) {
      if (epoch === accountEpoch && generation === seriesGeneration && detailModalOpen && error.name !== 'AbortError') seriesMessage(uiText('ui.reservationFailed', '预约未确认成功：{error}', { error: localizedError(error, 'common.operationFailed', '操作未完成，请重试。') }));
    }).then(function () {
      if (seriesReservationRequest !== request) return;
      seriesReservationRequest = null; seriesReservationID = ''; updateSeriesRows();
    });
  }

  function switchSeriesSeason(item) {
    if (!item.playable || item.upcoming) { seriesMessage(uiText('ui.seasonUnavailable', '这季暂时不可播放。')); return; }
    if (activePlayback && activePlayback.item.series_id === item.series_id) { seriesMessage(uiText('ui.seasonPlaying', '当前正在播放这一季。')); return; }
    if (seasonSwitchRequest) return;
    ++continuationGeneration;
    var generation = ++seasonSwitchGeneration; var panel = detailGeneration; var feed = feedGeneration; var epoch = accountEpoch;
    var request = new AbortController(); seasonSwitchRequest = request; seasonSwitchID = item.series_id;
    updateSeriesRows(); seriesMessage('');
    getDetail(item, request.signal).then(function (detail) {
      if (!detailModalOpen || detailTab !== 'series' || generation !== seasonSwitchGeneration || panel !== detailGeneration || feed !== feedGeneration || epoch !== accountEpoch || applicationInBackground || applicationHidden()) return;
      if (!detail.vid_list || !detail.vid_list.length) throw new Error(uiText('ui.seasonNoEpisodes', '这季尚无可播放集数'));
      var next = Object.assign({}, item, detail);
      ++detailGeneration; currentDetail = next; detailSeriesID = next.series_id; renderDetail(next);
      if (isPlaybackPage()) {
        // Keep the recommendation slot and original card/page return target.
        feedItems[feedIndex] = next; playFeedItem(feedIndex);
      } else {
        startPlayer(next, detailReturnFocus);
        // startPlayer focuses the video; restore the open selector's row.
        goFocus(currentSeriesRow());
      }
      updateSeriesRows(); seriesMessage(uiText('ui.switchedSeason', '已切换到 {season}。', { season: item.label || item.title }));
    }).catch(function (error) {
      if (generation === seasonSwitchGeneration && detailModalOpen && error.name !== 'AbortError') seriesMessage(uiText('ui.switchSeasonFailed', '切换失败：{error}，保留原播放状态。', { error: localizedError(error, 'common.operationFailed', '操作未完成，请重试。') }));
    }).then(function () {
      if (seasonSwitchRequest !== request) return;
      seasonSwitchRequest = null; seasonSwitchID = ''; updateSeriesRows();
    });
  }

  function detailElements() {
    return {
      title: document.getElementById('detail-title'),
      progress: document.getElementById('detail-progress'),
      retry: document.getElementById('detail-retry'),
      episodes: document.getElementById('detail-episodes')
    };
  }

  function detailEpisodeNumber(item) {
    var entry = libraryEntry(item.series_id);
    // Live playback can be ahead of an asynchronous history write.
    var episode = activePlayback && activePlayback.item.series_id === item.series_id ? activePlayback.episode : entry && entry.episode;
    return Math.max(1, Math.min(Number(episode) || 1, item.episode_count || (item.episodes || []).length || 1));
  }

  function currentDetailEpisode() {
    return firstVisible('.detail-episode.is-playing') || firstVisible('.detail-episode');
  }

  function focusLoadedDetailEpisode() {
    if (!detailFocusPending || detailTab !== 'episodes' || document.activeElement.id !== 'detail-tab-episodes') return;
    detailFocusPending = false;
    goFocus(currentDetailEpisode());
  }

  function renderDetail(item) {
    var nodes = detailElements();
    var focused = document.activeElement;
    var focusedIndex = focused && focused.classList.contains('detail-episode') ? focused.dataset.index : null;
    var retryFocused = focused === nodes.retry;
    nodes.title.textContent = item.title || uiText('modal.selectEpisode', '选集');
    var cover = document.getElementById('detail-cover');
    if (item.cover || item.cover_fallback) { cover.classList.remove('is-empty'); setCover(cover, item); }
    else { cover.removeAttribute('src'); cover.classList.add('is-empty'); }
    var meta = [];
    if (item.episode_count) meta.push(uiText('ui.totalEpisodes', '共{count}集', { count: item.episode_count }));
    if (item.score) meta.push(item.score + uiText('ui.scoreSuffix', '分'));
    if (item.tags && item.tags.length) meta.push(item.tags.slice(0, 3).join(' · '));
    document.getElementById('detail-meta').textContent = meta.join(' · ') || uiText('app.name', '红果短剧');
    document.getElementById('detail-intro').textContent = item.intro || '';
    document.getElementById('detail-intro').classList.toggle('is-hidden', !item.intro);
    renderDetailActors(item.actors || []);
    updateDetailActions();
    nodes.retry.classList.add('is-hidden');
    nodes.episodes.innerHTML = '';
    nodes.episodes.scrollTop = 0;
    (item.episodes || []).forEach(function (episode) {
      var button = document.createElement('button');
      button.className = 'detail-episode';
      button.dataset.index = String(Math.max(0, episode.index - 1));
      button.textContent = String(episode.index);
      button.setAttribute('aria-label', uiText('ui.playEpisodeLabel', '播放第{episode}集', { episode: episode.index }));
      button.addEventListener('click', function () { playEpisode(Number(button.dataset.index)); });
      button.addEventListener('focus', function () { button.scrollIntoView({ block: 'nearest' }); });
      nodes.episodes.appendChild(button);
    });
    updateDetailProgress();
    if (retryFocused && detailTab === 'episodes') goFocus(currentDetailEpisode() || document.getElementById('detail-tab-episodes'));
    if (focusedIndex !== null && detailTab === 'episodes') goFocus(firstVisible('.detail-episode[data-index="' + focusedIndex + '"]') || currentDetailEpisode() || document.getElementById('detail-tab-episodes'));
  }

  function updateDetailProgress() {
    if (!detailModalOpen || !currentDetail) return;
    var count = currentDetail.episode_count || (currentDetail.episodes || []).length;
    var episode = detailEpisodeNumber(currentDetail);
    detailElements().progress.textContent = (currentDetail.episodes || []).length ? uiText('content.currentEpisodeTotal', '当前第{episode}集 · 共{count}集', { episode: episode, count: count }) : uiText('content.noPlayableEpisodes', '暂无可播放集数');
    updateEpisodeHighlight((currentDetail.episodes || []).length ? episode - 1 : -1);
    updateSeriesRows();
  }

  function loadDetailEpisodes(item) {
    if (!item || !item.series_id) return;
    detailRequestItem = item;
    var generation = ++detailGeneration;
    var nodes = detailElements();
    nodes.progress.textContent = uiText('content.readingEpisodes', '正在读取集数…');
    if (document.activeElement === nodes.retry) goFocus(document.getElementById('detail-tab-episodes'));
    nodes.retry.classList.add('is-hidden');
    nodes.episodes.innerHTML = '';
    nodes.episodes.scrollTop = 0;
    getDetail(item).then(function (detail) {
      if (!detailModalOpen || generation !== detailGeneration) return;
      currentDetail = Object.assign({}, item, detail);
      renderDetail(currentDetail);
      if (detailTab === 'reviews' || detailTab === 'related') renderDetailSocial(detailTab);
      focusLoadedDetailEpisode();
    }).catch(function (error) {
      if (!detailModalOpen || generation !== detailGeneration) return;
      nodes.progress.textContent = uiText('content.episodesFailed', '集数加载失败：{error}', { error: localizedError(error, 'common.networkFailed', '连接失败') });
      nodes.retry.classList.remove('is-hidden');
      if (detailFocusPending && detailTab === 'episodes' && document.activeElement.id === 'detail-tab-episodes') goFocus(nodes.retry);
      detailFocusPending = false;
    });
  }

  function openDetail(item, initialTab, returnFocus) {
    if (!item || !item.series_id) return;
    if (actorWorksOpen) closeActorWorks(false);
    if (detailCastOpen) closeDetailCast(false);
    closePlayerOptions(false); clearTimeout(controlsTimer); revealControls();
    detailReturnFocus = returnFocus || document.activeElement;
    detailModalOpen = true;
    detailSeriesID = item.series_id;
    seriesRootID = item.series_id;
    resetSeriesPanel();
    seriesFocusCurrent = initialTab === 'series';
    currentDetail = null;
    detailModal.classList.remove('is-hidden');
    detailModal.setAttribute('aria-hidden', 'false');
    detailElements().title.textContent = item.title || uiText('modal.selectEpisode', '选集');
    selectDetailTab(initialTab === 'series' ? 'series' : 'episodes');
    detailFocusPending = detailTab === 'episodes';
    detailModal.classList.toggle('is-playback-drawer', pageMode() === 'player');
    syncPlaybackDrawerLayout();
    loadDetailEpisodes(item);
  }

  function closeDetail(skipPlaybackMenuReturn) {
    if (actorWorksOpen) closeActorWorks(false);
    if (detailCastOpen) closeDetailCast(false);
    var returnToPlaybackMenu = !skipPlaybackMenuReturn && playbackDetailReturnToMenu && pageMode() === 'player';
    var playbackMenuAction = playbackDetailResumeAction;
    playbackDetailReturnToMenu = false;
    playbackDetailResumeAction = '';
    resetSeriesPanel();
    ++detailGeneration;
    seriesRootID = '';
    detailFocusPending = false;
    detailModalOpen = false;
    detailSeriesID = '';
    currentDetail = null;
    detailRequestItem = null;
    detailModal.classList.add('is-hidden');
    detailModal.classList.remove('is-playback-drawer');
    detailModal.setAttribute('aria-hidden', 'true');
    var target = detailReturnFocus && document.contains(detailReturnFocus) ? detailReturnFocus : firstCatalog() || activeChannel();
    detailReturnFocus = null;
    if (!restoreSearchSuggestionFocus()) {
      if (returnToPlaybackMenu) openPlaybackCommandMenu(playbackMenuAction, true);
      else goFocus(target);
    }
    if (!returnToPlaybackMenu) syncPlaybackDrawerLayout();
    searchSuggestionReturnKey = '';
    scheduleControlsHide();
  }

  function updateEpisodeHighlight(index) {
    document.querySelectorAll('.detail-episode').forEach(function (node) {
      var playing = Number(node.dataset.index) === index;
      node.classList.toggle('is-playing', playing);
      node.setAttribute('aria-current', playing ? 'true' : 'false');
    });
  }

  function playEpisode(index) {
    if (!currentDetail || !currentDetail.episodes || !currentDetail.episodes[index]) return;
    var episode = currentDetail.episodes[index];
    var item = Object.assign({}, currentDetail, { vid: episode.video_id, start_episode: episode.index, __explicitEpisode: true });
    var returnFocus = detailReturnFocus;
    closeDetail(true);
    startPlayer(item, returnFocus);
  }

  function showPlaybackFeedback(action) {
    if (!desktopShell || !window.HongguoPlaybackPointer) return;
    try {
      if (!playbackFeedback) playbackFeedback = window.HongguoPlaybackPointer.createFeedback(document.getElementById('hero'));
      playbackFeedback.show(action);
    } catch (error) {
      // A cosmetic overlay must never interrupt media controls or be reported
      // as a playback failure after video.play() has already succeeded.
      console.warn('Playback feedback unavailable:', error);
    }
  }
  function toggleVideo() {
    var video = document.getElementById('hero-video');
    if (!video.src) { showNotice(uiText('content.noOpenDrama', '请先打开一部短剧并选择集数。')); return; }
    var feedbackSource = video.src;
    if (video.paused) playMedia(video).then(function () {
      if (video.src === feedbackSource && !video.paused && isPlaybackPage()) showPlaybackFeedback('play');
    }).catch(function () { showNotice(uiText('content.playerBlocked', '播放被设备阻止，请再次确认。')); });
    else { video.pause(); showPlaybackFeedback('pause'); }
  }

  function activatePage(item, restoring) {
    if (accountQR && accountQR.snapshot().active && item.dataset.page !== 'account') cancelAccountQR(false);
    if (item.dataset.page === 'recommend' && pageMode() === 'recommend') {
      if (!restoring) { revealControls(); goFocus(firstContentFocus()); }
      return;
    }
    if (typeof closePlaybackCommandMenu === 'function') closePlaybackCommandMenu(false);
    if (searchScanOpen) closeSearchScan(false);
    if (typeof danmakuScanOpen !== 'undefined' && danmakuScanOpen) closeDanmakuScan(false);
    if (smsVerification) smsVerification.stop();
    if (supportModalOpen) closeSupportQR();
    if (accountKeypadOpen()) numericKeypad.close('page');
    engagement.clear();
    if (typeof actorWorksOpen !== 'undefined' && actorWorksOpen) closeActorWorks(false);
    if (detailModalOpen) closeDetail();
    closePlayerOptions(false);
    var recommendation = rememberRecommendation();
    settleRecommendationSave(recommendation, saveProgress(true));
    allPagers.forEach(function (pager) { pager.cancel(); });
    activePlayback = null;
    ++feedGeneration;
    document.getElementById('hero-video').pause();
    resetPlayerUI();
    document.querySelectorAll('.side-item').forEach(function (node) { node.classList.toggle('is-active', node === item); });
    var label = item.querySelector('span:last-child');
    shell.dataset.mode = item.dataset.page || 'recommend';
    if (typeof syncNativePlaybackPageState === 'function') syncNativePlaybackPageState();
    document.getElementById('page-context').textContent = label ? label.textContent : uiText('ui.page', '页面');
    document.getElementById('page-context').disabled = true;
    shell.classList.remove('is-player');
    mainSurface.classList.remove('has-search', 'has-workspace', 'has-placeholder');
    searchPage.classList.add('is-hidden');
    pagePlaceholder.classList.add('is-hidden');
    hideWorkspacePages();
    if (item.dataset.page === 'recommend') {
      if (typeof notificationHidePopup === 'function') notificationHidePopup();
      mainSurface.classList.remove('has-placeholder');
      pagePlaceholder.classList.add('is-hidden');
      document.getElementById('hero').classList.add('is-feed');
      var active = document.querySelector('.channel-tab.is-active');
    if (!restoreRecommendation()) loadCatalog(active ? active.textContent : uiText('nav.recommend', '推荐'));
    } else if (item.dataset.page === 'search') {
      mainSurface.classList.remove('has-placeholder');
      pagePlaceholder.classList.add('is-hidden');
      mainSurface.classList.add('has-search');
      searchPage.classList.remove('is-hidden');
      searchHistory.load();
      if (!searchPager.loaded) { if (searchKind === 'keyword' && activeSearchQuery) submitSearch(); else loadBrowse(false, !filterRows.length); } else queueTailCheck();
    } else if (item.dataset.page === 'rank') {
      mainSurface.classList.add('has-workspace');
      rankPage.classList.remove('is-hidden');
      setRankView(rankView, false);
      if (rankView === 'official' && !rankPager.loaded) loadRank(); else if (rankView === 'official') queueTailCheck();
    } else if (item.dataset.page === 'new') {
      mainSurface.classList.add('has-workspace');
      newPage.classList.remove('is-hidden');
      renderNewMode(); if (newMode === 'recommend' && !newPager.loaded) loadNew(); else if (newMode === 'calendar' && !calendarPager.loaded) loadCalendar(); else queueTailCheck();
    } else if (item.dataset.page === 'follows') {
      mainSurface.classList.add('has-workspace');
      followPage.classList.remove('is-hidden');
      switchFollowView(followView, false, restoring);
      notificationCheck(false);
    } else if (['history', 'favorites', 'likes'].indexOf(item.dataset.page) >= 0) {
      mainSurface.classList.add('has-workspace');
      libraryPage.classList.remove('is-hidden');
      if (!restoring) libraryEditing = false;
      renderLibrary(!!restoring);
    } else if (item.dataset.page === 'account') {
      mainSurface.classList.add('has-workspace');
      accountPage.classList.remove('is-hidden');
      renderAccount();
      pollAccount();
    } else if (item.dataset.page === 'settings') {
      mainSurface.classList.add('has-workspace');
      settingsPage.classList.remove('is-hidden');
      appUpdates.refresh();
    } else if (item.dataset.page === 'support') {
      mainSurface.classList.add('has-workspace');
      supportPage.classList.remove('is-hidden');
    } else {
      mainSurface.classList.add('has-placeholder');
      pagePlaceholder.classList.remove('is-hidden');
    document.getElementById('page-placeholder-title').textContent = label ? label.textContent : uiText('ui.page', '页面');
    document.getElementById('page-placeholder-copy').textContent = uiText('ui.pageNotReady', '这个页面的数据和交互正在接入。');
    showNotice(uiText('ui.pageEntered', '{page}页面已进入，下一步接入对应数据。', { page: label ? label.textContent : uiText('ui.page', '页面') }));
    }
    if (!restoring) goFocus(firstContentFocus());
  }

  if (desktopShell && window.HongguoDesktopUI && window.HongguoDesktopUI.createPointerFocus) {
    desktopPointerFocus = window.HongguoDesktopUI.createPointerFocus(window, {
      selector: Object.keys(zoneSelectors).map(function (zone) { return zoneSelectors[zone]; }).join(','),
      allowed: function (element) { return focusables().indexOf(element) >= 0; },
      paint: paintFocus,
      focus: goFocus,
      hover: function (element) {
        if (element && element.closest('#hero')) revealControls();
        if (element && element.closest('#end-recommendations')) cancelEndRecommendationAutoplay();
      }
    });
  }
  document.addEventListener('keydown', handleKey, true);
  document.addEventListener('scroll', queueTailCheck, true);
  window.addEventListener('resize', queueTailCheck);
  window.addEventListener('resize', layoutLastPlaybackFrame);
  window.addEventListener('resize', resizePlaybackMenuHint);
  window.addEventListener('resize', function () { if (endRecommendations && endRecommendations.isOpen()) scrollEndRecommendationIntoView(document.activeElement); });
  window.addEventListener('blur', cancelEndRecommendationAutoplay);
  document.addEventListener('focusin', function (event) {
    if (androidShell && window.HongguoTVInput && typeof window.HongguoTVInput.setRemoteNavigationTarget === 'function') {
      var target = event.target;
      var editingTarget = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      // Search edit mode already blocks fallback keys; keep the last page
      // target so a delayed IME focus callback cannot disable suggestion nav.
      if (target.id !== 'search-input') window.HongguoTVInput.setRemoteNavigationTarget(!editingTarget && focusables().indexOf(target) >= 0);
      if (target.classList && target.classList.contains('search-suggestion')) searchSuggestionFocusedKey = target.dataset.suggestionKey || '';
      else searchSuggestionFocusedKey = '';
    }
    if (endRecommendations && endRecommendations.isOpen()) {
      if (event.target !== document.getElementById('end-recommendations-track').children[0]) endRecommendations.cancelAutoplay();
      if (!event.target.closest('#end-recommendations')) { goFocus(document.getElementById('end-recommendations-track').children[endRecommendationIndex] || document.getElementById('end-recommendations-close')); return; }
      scrollEndRecommendationIntoView(event.target);
    } else setTimeout(flushEndRecommendations, 0);
    if (typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen && !event.target.closest('#playback-command-menu')) { goFocus(firstVisible('.playback-command-action')); return; }
    if (scanModalOpen() && !event.target.closest('#search-scan-modal')) { goFocus(document.getElementById('search-scan-close')); return; }
    if (accountCountryModalOpen && !event.target.closest('#account-country-modal')) { goFocus(document.querySelector('.account-country-item.is-selected') || document.getElementById('account-country-close')); return; }
    if (typeof actorWorksOpen !== 'undefined' && actorWorksOpen && !event.target.closest('#actor-works-modal')) { goFocus(document.getElementById('actor-works-close')); return; }
    if (detailModalOpen && event.target.id !== 'detail-tab-episodes') detailFocusPending = false;
    if (accountKeypadOpen()) {
      if (!event.target.closest('#account-keypad-modal')) { goFocus(accountKeypadFocus()); return; }
      var keyIndex = Array.prototype.indexOf.call(document.querySelectorAll('.account-keypad-key'), event.target);
      if (keyIndex >= 0 && keyIndex !== numericKeypad.snapshot().index) numericKeypad.choose(keyIndex);
    }
    // Some Android TV IMEs temporarily move window focus away from the
    // WebView while the DOM search input remains active. Tell the native
    // shell so it can keep forwarding vertical D-pad navigation to this
    // page; desktop and browser previews keep their existing behavior.
    if (androidShell && event.target && event.target.id === 'search-input' && window.HongguoTVInput) {
      if (typeof window.HongguoTVInput.beginSearchEditing === 'function') {
        window.HongguoTVInput.beginSearchEditing(typeof document.hasFocus === 'function' && document.hasFocus());
      } else if (typeof window.HongguoTVInput.startSearchEditing === 'function') {
        window.HongguoTVInput.startSearchEditing();
      }
    }
    markFocus(event.target);
    queueTailCheck();
    var zone = zoneOf(event.target);
    if (zone === 'controls' && event.target.closest('.playback-buttons')) lastPlaybackControl = event.target;
    if (zone === 'sidebar') clearTimeout(controlsTimer);
    else if (isPlaybackPage() && ['controls', 'timeline', 'actions', 'channels'].indexOf(zone) >= 0) revealControls();
    else if (isPlaybackPage() && zone === 'feed') scheduleControlsHide();
    if (!scanModalOpen() && !accountKeypadOpen() && !detailModalOpen && !(typeof actorWorksOpen !== 'undefined' && actorWorksOpen) && !confirmOpen && !playerOptionsOpen && !(typeof playbackCommandMenuOpen !== 'undefined' && playbackCommandMenuOpen) && !discussionOpen && zone !== 'sidebar') {
      lastContentFocus = event.target;
      lastPageFocus[pageMode()] = event.target;
    }
  });

  document.querySelectorAll('.side-item').forEach(function (item) {
    item.addEventListener('click', function () {
      activatePage(item);
      if (item.dataset.page === 'recommend') goFocus(firstContentFocus());
    });
  });

  document.querySelectorAll('[data-action]').forEach(function (item) {
    item.addEventListener('click', function () {
      if (item.dataset.action === 'search-submit') {
        submitSearch();
      } else if (item.dataset.action === 'search-scan') {
        openSearchScan();
      } else if (item.dataset.action === 'search-history-clear') {
        confirmClearSearchHistory();
      } else if (item.dataset.action === 'search-browse') {
        beginBrowse();
      } else if (item.dataset.action === 'toggle-search-filters') {
        toggleSearchFilters();
      } else if (item.dataset.action === 'toggle-rank-filters') {
        toggleRankFilters();
      } else if (item.dataset.action === 'favorite' || item.dataset.action === 'like') {
        toggleSaved(featuredItem, item.dataset.action, item);
      } else if (item.dataset.action === 'follow') {
        toggleFollow(featuredItem, item);
      } else if (item.dataset.action === 'library-discover') {
        activatePage(document.querySelector('.side-item[data-page="search"]'));
      } else if (item.dataset.action === 'comment') openDiscussion(item);
      else if (item.dataset.action === 'danmaku') toggleDanmaku();
      else if (item.dataset.action === 'featured') {
        if (featuredItem) openDetail(featuredItem);
    else showNotice(uiText('ui.noPlayableDrama', '当前还没有可打开的短剧。'));
      } else if (item.dataset.action === 'play' || item.dataset.action === 'pause') toggleVideo();
      else if (item.dataset.action === 'seasons') {
        if (featuredItem) openDetail(featuredItem, 'series');
      }
      else if (item.dataset.action === 'player-menu-episodes' || item.dataset.action === 'player-menu-seasons') {
        if (!featuredItem) {
          closePlaybackCommandMenu(true);
          showNotice(uiText('ui.noPlayableDrama', '当前还没有可打开的短剧。'));
          return;
        }
        var menuReturn = playbackCommandMenuReturnFocus || document.getElementById('hero-feed-focus');
        playbackDetailReturnToMenu = true;
        playbackDetailResumeAction = item.id;
        closePlaybackCommandMenu(false);
        playbackCommandMenuReturnFocus = menuReturn;
        openDetail(featuredItem, item.dataset.action === 'player-menu-seasons' ? 'series' : undefined, menuReturn);
      }
      else if (item.dataset.action === 'player-menu-fullscreen') {
        closePlaybackCommandMenu(true);
        toggleCinema();
      }
      else if (item.dataset.action === 'episodes') {
        if (featuredItem) openDetail(featuredItem);
    else showNotice(uiText('ui.noPlayableDrama', '当前还没有可打开的短剧。'));
      }
      else if (item.dataset.action === 'danmaku-scan') openDanmakuScan();
      else if (['speed', 'volume', 'quality', 'send-danmaku'].indexOf(item.dataset.action) >= 0) openPlayerOptions(item.dataset.action, item);
      else if (item.dataset.action === 'diagnostics') openPlayerOptions('diagnostics', item);
      else if (item.dataset.action === 'fullscreen') toggleCinema();
      else if (item.dataset.action === 'retry') {
        if (playbackRequest) { goFocus(document.getElementById('hero-feed-focus')); playFeedItem(playbackRequest.index, playbackRequest.episode, playbackRequest.position); }
      }
      else if (item.dataset.action === 'return-player') handlePlayerContextClick();
      else if (item.dataset.action === 'return-recommend') {
        var recommend = document.querySelector('.side-item[data-page="recommend"]');
        if (recommend) {
          activatePage(recommend);
          goFocus(firstContentFocus());
        }
      }
    else showNotice(uiText('ui.receivedAction', '已收到操作：{action}。', { action: item.dataset.action }));
    });
  });

  document.querySelectorAll('.channel-tab').forEach(function (item) {
    item.addEventListener('click', function () {
      if (item.id === 'recommend-refresh') { loadCatalog(activeChannel().textContent); return; }
      document.querySelectorAll('.channel-tab').forEach(function (node) { node.classList.toggle('is-active', node === item); });
      loadCatalog(item.textContent);
    });
  });
  document.querySelectorAll('.new-tab').forEach(function (item) {
    item.addEventListener('click', function () { switchNewMode(item.dataset.newMode); });
  });
  document.querySelectorAll('.new-filter').forEach(function (item) {
    item.addEventListener('click', function () {
      newGender = item.dataset.newGender;
      newItems = [];
      document.querySelectorAll('.new-filter').forEach(function (node) { node.classList.toggle('is-active', node === item); });
      newPager.cancel(); calendarPager.cancel();
      newPager.loaded = false; calendarPager.loaded = false;
      if (newMode === 'recommend') loadNew(); else loadCalendar();
    });
  });
  document.querySelectorAll('.reservation-tab').forEach(function (item) {
    item.addEventListener('click', function () { renderReservations(item.dataset.reservationMode); goFocus(item); });
  });
  document.querySelectorAll('.library-tab').forEach(function (item) {
    item.addEventListener('click', function () { switchLibraryView(item.dataset.libraryView); });
  });
  document.querySelectorAll('.follow-tab').forEach(function (item) {
    item.addEventListener('click', function () { switchFollowView(item.dataset.followView); });
  });
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      searchSuggestionDismissedQuery = '';
      scheduleSearchSuggestions();
    });
    searchInput.addEventListener('focus', function () { if (searchInput.value.trim()) scheduleSearchSuggestions(); });
    searchInput.addEventListener('keydown', function (event) {
      if (normalizedKey(event) === 'Enter') {
        submitSearch();
        event.preventDefault();
      }
    });
  }
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-follow').addEventListener('click', function (event) { event.stopPropagation(); toggleFollow(currentDetail, document.getElementById('detail-follow')); });
  document.getElementById('detail-favorite').addEventListener('click', function (event) { event.stopPropagation(); toggleSaved(currentDetail, 'favorite', document.getElementById('detail-favorite')); });
  document.getElementById('detail-cast-more').addEventListener('click', openDetailCast);
  document.getElementById('detail-cast-close').addEventListener('click', function () { closeDetailCast(true); });
  document.getElementById('actor-works-close').addEventListener('click', function () { closeActorWorks(true); });
  document.getElementById('actor-works-retry').addEventListener('click', retryActorWorks);
  document.getElementById('detail-tab-episodes').addEventListener('click', function () { selectDetailTab('episodes'); });
  document.getElementById('detail-tab-series').addEventListener('click', function () { selectDetailTab('series'); });
  document.getElementById('detail-tab-reviews').addEventListener('click', function () { selectDetailTab('reviews'); });
  document.getElementById('detail-tab-related').addEventListener('click', function () { selectDetailTab('related'); });
  document.getElementById('rank-filter-open').addEventListener('click', openRankFilter);
  document.getElementById('rank-filter-close').addEventListener('click', function () { closeRankFilter(true); });
  document.getElementById('rank-filter-cancel').addEventListener('click', function () { closeRankFilter(true); });
  document.getElementById('rank-filter-apply').addEventListener('click', applyRankFilter);
  document.getElementById('actor-works-close').addEventListener('click', function () { closeActorWorks(true); });
  document.getElementById('actor-works-retry').addEventListener('click', retryActorWorks);
  document.querySelectorAll('.rank-view-tab').forEach(function (button) {
    button.addEventListener('click', function () { setRankView(button.dataset.rankView); });
  });
  document.querySelectorAll('[data-radar-official]').forEach(function (button) {
    button.addEventListener('click', function () { setRadarOfficial(button.dataset.radarOfficial); });
  });
  document.querySelectorAll('[data-radar-view]').forEach(function (button) {
    button.addEventListener('click', function () { setRadarView(button.dataset.radarView); });
  });
  document.querySelectorAll('[data-radar-metric]').forEach(function (button) {
    button.addEventListener('click', function () { setRadarGrowthMetric(button.dataset.radarMetric); });
  });
  document.querySelectorAll('[data-radar-type]').forEach(function (button) {
    button.addEventListener('click', function () { setRadarGrowthType(button.dataset.radarType); });
  });
  document.getElementById('radar-refresh').addEventListener('click', function () { loadRadar(true); });
  document.getElementById('detail-series-retry').addEventListener('click', loadSeriesSeasons);
  document.getElementById('end-recommendations-close').addEventListener('click', function () { endRecommendations.close(true); });
  document.getElementById('end-recommendations').addEventListener('click', function (event) { if (event.target === this) endRecommendations.close(true); });
  if (playbackCommandMenu) playbackCommandMenu.addEventListener('click', function (event) { if (event.target === this) closePlaybackCommandMenu(true); });
  ['wheel', 'touchstart', 'mousedown', 'pointerdown'].forEach(function (name) {
    document.getElementById('end-recommendations').addEventListener(name, cancelEndRecommendationAutoplay, true);
  });
  document.getElementById('account-send-code').addEventListener('click', accountSendCode);
  accountQR = window.HongguoAccountScan.create({
    request: function (action, id) {
      var options = action === 'status' ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id ? { id: id } : {}) };
      return fetch('/api/v1/account/qr/' + action + (action === 'status' ? '?id=' + encodeURIComponent(id) : ''), options).then(function (response) { return response.json(); }).then(function (payload) {
        if (!payload.ok || !payload.data) throw new Error('QR request failed');
        return payload.data;
      });
    },
    onStatus: function (data) { acceptAccountStatus(data); },
    onChange: function () { renderAccount(); },
    onComplete: function () { if (pageMode() === 'account') goFocus(document.getElementById('account-logout')); }
  });
  document.getElementById('account-method-qr').addEventListener('click', startAccountQR);
  document.getElementById('account-method-phone').addEventListener('click', function () { accountLoginMethod = 'phone'; cancelAccountQR(true); });
  document.getElementById('account-qr-refresh').addEventListener('click', startAccountQR);
  document.getElementById('account-qr-cancel').addEventListener('click', function () { cancelAccountQR(true); });
  window.addEventListener('pagehide', function () { if (accountQR && accountQR.snapshot().active) accountQR.cancel(); });
  document.getElementById('account-login').addEventListener('click', accountLogin);
  document.getElementById('account-country-close').addEventListener('click', function () { closeAccountCountryModal(false); });
  document.getElementById('account-verify').addEventListener('click', verifyAccountSMS);
  document.getElementById('account-cancel').addEventListener('click', cancelAccountVerification);
  document.getElementById('account-change-phone').addEventListener('click', cancelAccountVerification);
  document.getElementById('account-logout').addEventListener('click', confirmAccountLogout);
  document.getElementById('account-sync').addEventListener('click', function () { accountRequest('sync').then(function () { if (pageMode() === 'account') goFocus(document.getElementById('account-logout')); }); });
  document.getElementById('account-import-history').addEventListener('click', function () {
    var owner = accountData && accountData.profile && accountData.profile.uid;
    if (!owner || this.disabled) return;
    var epoch = accountEpoch;
    accountRequest('import-history', { owner_id: owner }).then(function (ok) {
      if (!ok || epoch !== accountEpoch) return;
      libraryQueue = libraryQueue.catch(function () {}).then(function () { if (epoch === accountEpoch) return loadLibrary(); });
      libraryReady = libraryQueue;
      if (pageMode() === 'account') goFocus(firstVisible('#account-import-history') || firstVisible('#account-sync') || firstVisible('#account-logout'));
    });
  });
  setInterval(function () { if (pageMode() === 'account' && !accountBusy) renderAccount(); }, 1000);
  document.getElementById('detail-retry').addEventListener('click', function () { detailFocusPending = true; loadDetailEpisodes(detailRequestItem); });
  document.getElementById('discussion-close').addEventListener('click', function () { closeDiscussion(); });
  document.getElementById('discussion-send').addEventListener('click', sendDiscussion);
  document.getElementById('discussion-cancel-reply').addEventListener('click', function () { selectDiscussionReply(null); goFocus(document.getElementById('discussion-input')); });
  document.getElementById('player-compose-send').addEventListener('click', sendDanmaku);
  document.querySelectorAll('.history-filter').forEach(function (button) {
    button.addEventListener('click', function () { selectHistoryFilter(button.dataset.historyFilter); });
  });
  document.querySelectorAll('.library-type-filter').forEach(function (button) {
    button.addEventListener('click', function () { selectLibraryType(button.dataset.libraryType); });
  });
  document.getElementById('follow-refresh').addEventListener('click', function () { followPager.reset({}); });
  document.getElementById('follow-notifications-open').addEventListener('click', openFollowNotifications);
  document.getElementById('follow-notifications-back').addEventListener('click', closeFollowNotifications);
  document.getElementById('follow-notifications-read-all').addEventListener('click', function () {
    var target = document.activeElement;
    fetchData('/api/v1/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) }).then(function (data) {
      acceptNotificationData(data, false);
      if (followNotificationViewOpen) goFocus(target && target.id === 'follow-notifications-read-all' ? target : firstVisible('#follow-notifications-back'));
  }).catch(function () { showNotice(uiText('ui.followMarkFailed', '更新提醒暂时无法标记')); });
  });
  document.getElementById('notification-popup').addEventListener('click', notificationHidePopup);
  document.getElementById('library-manage').addEventListener('click', function () {
    if (libraryError) { libraryReady = loadLibrary(); return; }
    libraryEditing = !libraryEditing;
    renderLibrary(true);
  });
  document.getElementById('library-clear').addEventListener('click', confirmClearLibrary);
  document.getElementById('confirm-cancel').addEventListener('click', closeConfirmation);
  document.getElementById('confirm-accept').addEventListener('click', function () {
    if (!confirmOperation || this.disabled) return;
    var button = this;
    var generation = confirmationGeneration;
    button.disabled = true;
    confirmOperation().then(function (ok) { button.disabled = false; if (ok && confirmOpen && generation === confirmationGeneration) closeConfirmation(); });
  });
  document.getElementById('hero-feed-focus').addEventListener('click', toggleVideo);
  installRecommendationGestures();
  if (desktopShell && window.HongguoPlaybackPointer) {
    window.HongguoPlaybackPointer.attach(document.getElementById('hero'), {
      isEnabled: function () {
        return isPlaybackPage() && !!activePlayback && !applicationInBackground && !applicationHidden() &&
          !detailModalOpen && !playerOptionsOpen && !confirmOpen && !discussionOpen &&
          !scanModalOpen() && !supportModalOpen && !accountCountryModalOpen && !accountKeypadOpen() &&
          !rankFilterOpen && !detailCastOpen && !actorWorksOpen && !playbackCommandMenuOpen &&
          !(endRecommendations && endRecommendations.isOpen());
      },
      onTogglePlayback: toggleVideo,
      onSeek: function (delta) { seekBy(delta, false); },
      onToggleControls: function () {
        if (shell.classList.contains('is-controls-hidden')) revealControls();
        else {
          goFocus(document.getElementById('hero-feed-focus'));
          hideControls();
          controlsManuallyHidden = shell.classList.contains('is-controls-hidden');
        }
      }
    });
  }
  if (desktopShell && window.HongguoEpisodeWheel) {
    window.HongguoEpisodeWheel.attach(document.getElementById('hero'), {
      isEnabled: function () {
        return pageMode() === 'player' && !detailModalOpen && !playerOptionsOpen && !confirmOpen &&
          !discussionOpen && !scanModalOpen() && !supportModalOpen && !accountCountryModalOpen &&
          !accountKeypadOpen() && !rankFilterOpen && !detailCastOpen && !actorWorksOpen;
      },
      onStep: function (step) { switchPlayerEpisode(step, true); }
    });
  }
  document.getElementById('player-options-close').addEventListener('click', function () { closePlayerOptions(); });
  document.getElementById('player-diagnostics-close').addEventListener('click', function () { closePlayerOptions(); });
  document.getElementById('player-diagnostics-refresh').addEventListener('click', refreshPlaybackDiagnostics);
  document.getElementById('control-progress').addEventListener('click', function (event) {
    if (!event.detail) return;
    var rect = this.getBoundingClientRect();
    seekTo((event.clientX - rect.left) / rect.width * document.getElementById('hero-video').duration);
  });
  document.addEventListener(window.PointerEvent ? 'pointermove' : 'mousemove', function (event) { if (!controlsManuallyHidden && isPlaybackPage() && event.target.closest('#hero')) revealControls(); });
  document.addEventListener('fullscreenchange', function () {
    if (document.fullscreenElement) { nativeFullscreen = true; setCinema(true); }
    else if (nativeFullscreen) {
      nativeFullscreen = false; setCinema(false);
      if (fullscreenExitKeepsHidden) hideControls(); else revealControls();
      fullscreenExitKeepsHidden = false;
    }
  });

  function coreDiagnosticValue(value, limit) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\bhttps?:\/\/\S+/gi, '[URL redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b(cookie|authorization|token|signature|secret|password)\b(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
      .replace(/\s+/g, ' ').slice(0, limit || 240);
  }
  function coreConnectionRows(diagnostic) {
    var bridge = window.HongguoWebOS || {};
    var timestamp = diagnostic.timestamp ? new Date(diagnostic.timestamp) : new Date();
    var device = coreDiagnosticValue(window.navigator && window.navigator.userAgent, 260) || uiText('connection.unknown', '未取得');
    var rows = [
      [uiText('connection.stage', '失败阶段'), diagnostic.stage || 'unknown'],
      [uiText('connection.code', '错误码'), diagnostic.code || 'UNKNOWN'],
      [uiText('connection.detail', '错误详情'), diagnostic.message || uiText('connection.unknown', '未取得')],
      [uiText('connection.serviceId', 'webOS 服务'), 'com.aston314.hongguo.webos.service'],
      [uiText('connection.address', '本机服务'), '127.0.0.1:' + String(diagnostic.port || 7655)],
      [uiText('connection.time', '发生时间'), timestamp.toLocaleString()],
      [uiText('connection.version', '应用版本'), bridge.appVersion || uiText('connection.unknown', '未取得')],
      [uiText('connection.device', '设备标识'), device]
    ];
    var root = document.getElementById('core-connection-scroll');
    root.innerHTML = '';
    rows.forEach(function (entry, index) {
      var row = document.createElement('div'); row.className = 'core-connection-row';
      var label = document.createElement('span'); label.className = 'core-connection-label'; label.textContent = entry[0];
      var value = document.createElement('span'); value.className = 'core-connection-value'; value.textContent = coreDiagnosticValue(entry[1], index === 7 ? 260 : 300);
      row.appendChild(label); row.appendChild(value); root.appendChild(row);
    });
  }
  function openCoreConnectionModal() {
    if (!window.HongguoWebOS || coreConnectionModalOpen) return;
    coreConnectionReturnFocus = document.activeElement;
    coreConnectionModalOpen = true;
    var modal = document.getElementById('core-connection-modal');
    modal.classList.remove('is-hidden'); modal.setAttribute('aria-hidden', 'false');
    if (coreConnectionDiagnostic) coreConnectionRows(coreConnectionDiagnostic);
    goFocus(document.getElementById('core-connection-retry'));
  }
  function closeCoreConnectionModal(restore) {
    if (!coreConnectionModalOpen) return;
    coreConnectionModalOpen = false;
    var modal = document.getElementById('core-connection-modal');
    modal.classList.add('is-hidden'); modal.setAttribute('aria-hidden', 'true');
    var target = coreConnectionReturnFocus || status;
    if (coreStatusState === 'connected' && target === status) target = activeSidebar();
    coreConnectionReturnFocus = null;
    if (restore !== false) goFocus(target && document.contains(target) ? target : status);
  }
  function moveCoreConnectionFocus(current, direction) {
    var scroll = document.getElementById('core-connection-scroll');
    var retry = document.getElementById('core-connection-retry');
    var close = document.getElementById('core-connection-close');
    if (current === scroll) {
      if (direction === 'right') return retry;
      if (direction === 'down' || direction === 'up') {
        var bottom = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        if (direction === 'down' && scroll.scrollTop >= bottom - 1) return retry;
        var step = Math.max(48, Math.round(scroll.clientHeight * .65));
        scroll.scrollTop = Math.max(0, Math.min(bottom, scroll.scrollTop + (direction === 'down' ? step : -step)));
      }
      return null;
    }
    if (direction === 'up') return scroll;
    if (direction === 'left' || direction === 'right') return current === retry ? close : retry;
    return null;
  }
  function setCoreConnectionFailure(error, open) {
    var bridge = window.HongguoWebOS || {};
    var adapterDiagnostic = null;
    if (typeof bridge.getDiagnostic === 'function') {
      try { adapterDiagnostic = bridge.getDiagnostic(); } catch (ignoredDiagnostic) {}
    }
    var adapterHasFailure = adapterDiagnostic && adapterDiagnostic.code && adapterDiagnostic.code !== 'READY' && adapterDiagnostic.code !== 'NOT_CHECKED';
    var diagnostic = adapterHasFailure ? adapterDiagnostic : error;
    if (!diagnostic || !diagnostic.code) {
      diagnostic = { stage: error && error.stage || 'status_request', code: error && error.code || 'STATUS_UNREACHABLE', message: error && error.message || uiText('connection.statusFailed', '无法读取本机服务状态'), port: 7655, timestamp: Date.now() };
    }
    coreConnectionDiagnostic = {
      stage: coreDiagnosticValue(diagnostic.stage || 'unknown', 64),
      code: coreDiagnosticValue(diagnostic.code || 'UNKNOWN', 64),
      message: coreDiagnosticValue(diagnostic.message || uiText('connection.statusFailed', '无法读取本机服务状态'), 300),
      port: Number(diagnostic.port) || 7655,
      timestamp: Number(diagnostic.timestamp) || Date.now()
    };
    coreStatusState = coreConnectionDiagnostic.stage === 'status_http' || coreConnectionDiagnostic.stage === 'status_response' ? 'error' : 'unavailable';
    coreStatusVersion = '';
    coreStatusDiagnostic = coreConnectionDiagnostic.code;
    renderCoreStatus();
    coreConnectionRows(coreConnectionDiagnostic);
    var retry = document.getElementById('core-connection-retry');
    retry.disabled = false;
    retry.textContent = uiText('common.retry', '重试');
    if (coreConnectionModalOpen) {
      document.getElementById('core-connection-summary').textContent = uiText('connection.summary', '请拍下此页并反馈，帮助定位连接问题。');
      goFocus(retry);
    }
    else if (open && window.HongguoWebOS) openCoreConnectionModal();
  }
  function retryCoreConnection() {
    var button = document.getElementById('core-connection-retry');
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = uiText('connection.retrying', '正在重试…');
    document.getElementById('core-connection-summary').textContent = uiText('connection.retryingDetail', '正在重新检查 webOS 系统服务和本机数据服务…');
    goFocus(document.getElementById('core-connection-scroll'));
    var bridge = window.HongguoWebOS || {};
    if (typeof bridge.wakeService !== 'function') {
      button.disabled = false;
      button.textContent = uiText('common.retry', '重试');
      setCoreConnectionFailure({ stage: 'luna_ping', code: 'LUNA_API_UNAVAILABLE', message: uiText('connection.bridgeUnavailable', '未找到 webOS 系统服务接口') }, false);
      return;
    }
    Promise.resolve().then(function () { return bridge.wakeService(); }).then(function () {
      loadStatus({ openOnFailure: false, closeOnSuccess: true });
    }, function (error) {
      button.disabled = false;
      button.textContent = uiText('common.retry', '重试');
      setCoreConnectionFailure(error, false);
    });
  }
  document.getElementById('core-status').addEventListener('click', function () {
    if (window.HongguoWebOS && coreStatusState !== 'connected') openCoreConnectionModal();
  });
  document.getElementById('core-connection-retry').addEventListener('click', retryCoreConnection);
  document.getElementById('core-connection-close').addEventListener('click', function () { closeCoreConnectionModal(true); });
  function loadStatus(options) {
    options = options || {};
    // Use a bounded request even on WebViews without fetch/AbortController.
    var request = new XMLHttpRequest();
    request.open('GET', '/api/v1/status', true);
    request.timeout = 8000;
    function failed(error) { setCoreConnectionFailure(error, options.openOnFailure !== false); }
    renderCoreStatus();
    request.onload = function () {
      try {
        var data = JSON.parse(request.responseText);
        if (request.status === 200 && data.ok) {
          coreStatusState = 'connected'; coreStatusVersion = data.version || ''; coreStatusDiagnostic = ''; coreConnectionDiagnostic = null;
          var retryButton = document.getElementById('core-connection-retry');
          retryButton.disabled = false;
          retryButton.textContent = uiText('common.retry', '重试');
          document.getElementById('core-connection-summary').textContent = uiText('connection.summary', '请拍下此页并反馈，帮助定位连接问题。');
          renderCoreStatus();
          if (options.closeOnSuccess && coreConnectionModalOpen) closeCoreConnectionModal(true);
        } else {
          failed({ stage: 'status_http', code: 'STATUS_HTTP_' + (request.status || 0), message: data && (data.message || data.error) || 'HTTP ' + (request.status || 0) });
        }
      } catch (error) { failed({ stage: 'status_response', code: 'STATUS_INVALID_RESPONSE', message: error && error.message || 'invalid response' }); }
    };
    request.onerror = function () { failed({ stage: 'status_request', code: 'STATUS_NETWORK_ERROR', message: '连接本机服务的状态请求失败' }); };
    request.ontimeout = function () { failed({ stage: 'status_request', code: 'STATUS_TIMEOUT', message: '等待本机服务状态超时' }); };
    request.send();
  }

  var media = document.getElementById('hero-video');
  media.addEventListener('loadedmetadata', function () {
    if (!activePlayback || activePlayback.generation !== feedGeneration) return;
    if (media.videoWidth > 0 && media.videoHeight > 0) {
      activePlayback.videoWidth = media.videoWidth;
      activePlayback.videoHeight = media.videoHeight;
    }
    if (typeof maybeSkipRecommendationOrientation === 'function' && maybeSkipRecommendationOrientation(activePlayback, media.videoWidth, media.videoHeight)) return;
    var position = activePlayback.position;
    var adapter = typeof window !== 'undefined' ? window.HongguoNativePlaybackAdapter : null;
    var nativeStartPosition = adapter && typeof adapter.isNative === 'function' && adapter.isNative();
    if (!nativeStartPosition && position > 0 && Number.isFinite(media.duration)) media.currentTime = Math.min(position, Math.max(0, media.duration - .25));
    media.playbackRate = playbackPreferences.speed;
    updatePlaybackControls();
  });
  media.addEventListener('playing', function () {
    document.getElementById('danmaku-layer').classList.remove('is-paused'); tickDanmaku();
    markPlaybackStarted(activePlayback);
  });
  media.addEventListener('nativeframe', function (event) {
    // Media3 can report a rendered frame before WebView's `playing` callback.
    // Reveal that real frame without treating the episode as started for
    // history/progress purposes.
    if (activePlayback && activePlayback.presentation) {
      if (media.videoWidth > 0 && media.videoHeight > 0) {
        activePlayback.videoWidth = media.videoWidth;
        activePlayback.videoHeight = media.videoHeight;
      }
      if (typeof maybeSkipRecommendationOrientation === 'function' && maybeSkipRecommendationOrientation(activePlayback, media.videoWidth, media.videoHeight)) return;
      activePlayback.presentation.rendered = true;
      activePlayback.presentation.frame_at = Date.now();
      if (event && typeof event.coreIdle === 'boolean') {
        activePlayback.presentation.nativeCoreIdle = event.coreIdle;
        activePlayback.presentation.nativeFrameCoreIdle = event.coreIdle;
      }
      if (!media.paused && !media.seeking && media.readyState >= 2) activePlayback.presentation.waiting = false;
      finishPlaybackPreparation(activePlayback);
    }
  });
  media.addEventListener('nativeoutputstate', function (event) {
    if (!activePlayback || !activePlayback.presentation || !event || typeof event.coreIdle !== 'boolean') return;
    activePlayback.presentation.nativeCoreIdle = event.coreIdle;
    finishPlaybackPreparation(activePlayback);
  });
  function checkPlaybackData() {
    if (!activePlayback) return;
    var presentation = activePlayback.presentation;
    if (!currentPlaybackPresentation(activePlayback, presentation, media)) return;
    // A native first frame is a valid presentation signal even when the
    // WebView has not received `playing` yet.  Waiting for playback.started
    // here leaves some Android 9 WebViews behind an endless black cover while
    // Media3 is already advancing the clock.
    if (!media.paused && !media.seeking && media.readyState >= 3) presentation.waiting = false;
    finishPlaybackPreparation(activePlayback);
  }
  media.addEventListener('loadeddata', checkPlaybackData);
  media.addEventListener('canplay', checkPlaybackData);
  media.addEventListener('timeupdate', function () {
    tickDanmaku();
    checkPlaybackProgress(media);
    if (!activePlayback || !activePlayback.started) return;
    updatePlaybackControls();
    maybePrefetchNextEpisode(media);
    saveProgress(false);
  });
  media.addEventListener('pause', function () {
    if (typeof cancelFullEpisodePrefetchForPlayback === 'function') cancelFullEpisodePrefetchForPlayback(activePlayback);
    if (activePlayback) activePlayback.stableSince = 0;
    var staticMpvFrame = activePlayback && playbackEngineName() === 'mpv' && !activePlayback.started &&
      activePlayback.presentation && activePlayback.presentation.rendered && activePlayback.presentation.nativeFrameCoreIdle !== true &&
      media.paused && document.getElementById('hero').classList.contains('is-preparing-video');
    if (!staticMpvFrame) interruptPlaybackPresentation(activePlayback);
    else finishPlaybackPreparation(activePlayback);
    document.getElementById('danmaku-layer').classList.add('is-paused');
    saveProgress(true); updatePlaybackControls();
    if (activePlayback && activePlayback.started && media.getAttribute('src') && media.paused && !media.ended) revealControls();
  });
  media.addEventListener('webosaudiofallback', function () {
    if (!window.HongguoWebOS) return;
    updatePlaybackControls();
    showNotice(uiText('ui.audibleSpeedFallback', '倍速声音准备失败，已恢复正常速度'));
  });
  media.addEventListener('webosaudiostate', function (event) {
    if (!webosShell) return;
    updatePlaybackControls();
    if (event.detail && event.detail.phase === 'preparing') showNotice(uiText('ui.audibleSpeedPreparing', '正在准备倍速声音，暂按有声 1 倍速播放'));
  });
  media.addEventListener('webosaudioenabledchange', function (event) {
    if (!webosShell) return;
    if (event.detail && !event.detail.enabled) { playbackPreferences.speed = 1; savePlaybackPreferences(); }
    updateWebOSAudioSettings();
    updatePlaybackControls();
  });
  media.addEventListener('ratechange', updatePlaybackControls);
  media.addEventListener('volumechange', updatePlaybackControls);
  media.addEventListener('nativefallbackstart', function () {
    var hero = document.getElementById('hero');
    if (hero && hero.classList.contains('is-preparing-video') && hero.classList.contains('is-episode-transition') &&
        activePlayback && activePlayback.preserveNativeTransition && playbackEngineName() !== 'mpv') {
      hero.classList.add('is-native-media3-episode-transition');
    }
  });
  media.addEventListener('nativefallbackend', function () {
    var hero = document.getElementById('hero');
    // A Media3 failure can fall back to WebView while the new episode is still
    // preparing. Keep the old drama poster suppressed until that transition
    // presents a real frame; otherwise the poster flashes back over loading.
    if (hero && (!hero.classList.contains('is-preparing-video') || !hero.classList.contains('is-episode-transition'))) {
      hero.classList.remove('is-native-media3-episode-transition');
    }
  });
  media.addEventListener('emptied', updatePlaybackControls);
  media.addEventListener('waiting', function () {
    if (!activePlayback) return;
    if (typeof cancelFullEpisodePrefetchForPlayback === 'function') cancelFullEpisodePrefetchForPlayback(activePlayback);
    activePlayback.stableSince = 0;
    interruptPlaybackPresentation(activePlayback);
    if (activePlayback.presentation) activePlayback.presentation.waiting = true;
    setPlayerStatus(document.getElementById('hero').classList.contains('is-preparing-video') || !activePlayback.started ? episodeLoadingText(activePlayback.episode) : uiText('ui.buffering', '正在缓冲…'));
    if (activePlayback.mode === 'range' && !activePlayback.rangeFallbackAttempted) scheduleRangeStallFallback(activePlayback);
  });
  media.addEventListener('stalled', function () {
    if (typeof cancelFullEpisodePrefetchForPlayback === 'function') cancelFullEpisodePrefetchForPlayback(activePlayback);
    if (activePlayback && activePlayback.mode === 'range') scheduleRangeStallFallback(activePlayback);
  });
  media.addEventListener('seeking', function () { if (activePlayback) { if (typeof cancelFullEpisodePrefetchForPlayback === 'function') cancelFullEpisodePrefetchForPlayback(activePlayback); activePlayback.stableSince = 0; } interruptPlaybackPresentation(activePlayback); });
  media.addEventListener('seeked', function () {
    if (activePlayback && activePlayback.started && !media.paused && !media.ended) activePlayback.stableSince = Date.now();
    if (activePlayback && activePlayback.presentation) activePlayback.presentation.position = Number(media.currentTime) || 0;
    checkPlaybackData(); resetDanmaku(); tickDanmaku(); updatePlaybackControls(); saveProgress(true);
    if (media.paused) setPlayerStatus('');
  });
  media.addEventListener('error', function () {
    if (!activePlayback || !media.getAttribute('src')) return;
    clearRangeStallTimer();
    if (fallbackRangePlayback(activePlayback)) return;
    if (recoverPlaybackAfterError(activePlayback)) return;
    setPlayerStatus(uiText('ui.playbackFailed', '这集未能正常播放'), true);
  });
  media.addEventListener('ended', function () {
    clearRangeStallTimer();
    var playback = activePlayback;
    if (!playback || playback.generation !== feedGeneration) return;
    // Native Media3 can report the terminal state before its playing callback
    // reaches WebView. A real rendered frame plus ended is sufficient proof
    // that this session did play; do not lose automatic continuation solely
    // because the two callbacks crossed.
    if (!playback.started && !(playback.presentation && playback.presentation.rendered)) return;
    if (!playback.started) playback.started = true;
    saveProgress(true, true);
    if (applicationInBackground || applicationHidden()) {
      playback.endedPending = true;
      return;
    }
    continueAfterEpisode(playback);
  });
  document.addEventListener('visibilitychange', function () { if (desktopShell) return; if (applicationHidden()) pauseForBackground(); else resumeFromBackground(); });

  function openQRCode(card, image, title) {
    supportReturnFocus = card; supportModalOpen = true;
    document.getElementById('support-modal-title').textContent = title;
    document.getElementById('support-large-qr').src = image.getAttribute('src');
    document.getElementById('support-large-qr').alt = image.alt;
    document.getElementById('support-modal').classList.remove('is-hidden');
    document.getElementById('support-modal').setAttribute('aria-hidden', 'false');
    goFocus(document.getElementById('support-close'));
  }
  function closeSupportQR() {
    supportModalOpen = false;
    document.getElementById('support-modal').classList.add('is-hidden');
    document.getElementById('support-modal').setAttribute('aria-hidden', 'true');
    document.getElementById('support-large-qr').removeAttribute('src');
    goFocus(focusables().indexOf(supportReturnFocus) >= 0 ? supportReturnFocus : firstContentFocus());
  }
  document.querySelectorAll('.support-card').forEach(function (card) { card.addEventListener('click', function () { openQRCode(card, card.querySelector('img'), card.querySelector('h2').textContent); }); });
  document.getElementById('account-sms-qr').addEventListener('click', function () {
    var image = document.getElementById('account-sms-qr-image');
    if (image.getAttribute('src')) openQRCode(this, image, uiText('ui.scanSmsTitle', '扫码填写短信 · 请手动发送'));
  });
  document.getElementById('support-close').addEventListener('click', closeSupportQR);
  numericKeypad = window.HongguoNumericKeypad.create({
    render: function (state) {
      var modal = document.getElementById('account-keypad-modal');
      modal.classList.toggle('is-hidden', !state.open); modal.setAttribute('aria-hidden', state.open ? 'false' : 'true');
      document.getElementById('account-keypad-title').textContent = state.kind === 'code' ? uiText('ui.keypadCode', '输入验证码') : uiText('ui.keypadPhone', '输入手机号');
      var value = document.getElementById('account-keypad-value');
      value.textContent = state.value || uiText('ui.keypadNumber', '请输入数字'); value.classList.toggle('is-empty', !state.value);
      document.getElementById('account-keypad-hint').textContent = state.open ? uiText('ui.keypadPhoneHelp', '{length} / {max} 位 · {country} · 也可使用遥控器数字键', { length: state.value.length, max: state.maxLength, country: state.countryName }) : '';
      document.getElementById('account-keypad-error').textContent = state.error;
      if (state.open && document.activeElement !== accountKeypadFocus()) goFocus(accountKeypadFocus());
    },
    change: function (kind, value) {
      var field = document.getElementById(kind === 'phone' ? 'account-phone' : 'account-code');
      field.value = value; renderAccountNumber(field);
    },
    close: function (result) {
      accountNumberScan.stop();
      var origin = accountKeypadReturnFocus; accountKeypadReturnFocus = null; accountKeypadPhase = '';
      if (result.reason !== 'complete' && result.reason !== 'back') return;
      renderAccount();
      if (pageMode() !== 'account' || accountBusy || confirmOpen || supportModalOpen) return;
      var next = result.reason === 'back' ? origin : result.kind === 'code' ? firstVisible('#account-login') : firstVisible('#account-code') || firstVisible('#account-send-code');
      var target = next || (origin && !origin.disabled ? origin : firstContentFocus());
      // The keypad close render hides its buttons synchronously, but Android
      // 6 can restore the last hidden button on the next focus pass. Restore
      // the intended page target on the next turn as well.
      goFocus(target);
      setTimeout(function () {
        if (pageMode() === 'account' && !accountKeypadOpen() && !accountBusy && !confirmOpen && !supportModalOpen) {
          goFocus(target && !target.disabled && target.getClientRects().length ? target : firstContentFocus());
        }
      }, 0);
    }
  });
  try {
    var savedPhoneCountry = window.localStorage.getItem('hongguo.account.phoneCountryCode');
    if (savedPhoneCountry) accountPhoneCountryCode = savedPhoneCountry;
  } catch (ignoredPhoneCountryRead) {}
  buildAccountCountryList();
  if (!setAccountPhoneCountry(accountPhoneCountryCode, false)) setAccountPhoneCountry('+86', false);
  document.getElementById('account-country').addEventListener('click', openAccountCountryModal);
  function requestScanInput(method, session, kind, meta) {
      var options = { method: method };
      if (method === 'POST') { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify({ kind: kind, country_code: meta && meta.country_code || '' }); }
      return fetchData('/api/v1/number-input' + (session ? '?session=' + encodeURIComponent(session) : ''), options);
  }
  searchHistory = window.HongguoSearchHistory.create({
    request: function (method, query) {
      var options = { method: method };
      if (method === 'POST') { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify({ query: query }); }
      return fetchData('/api/v1/search-history', options);
    },
    render: renderSearchHistory,
    error: function (method) { if (method !== 'GET' && pageMode() === 'search') showNotice(uiText('ui.searchHistorySaveFailed', '最近搜索保存失败，请重试')); }
  });
  searchNumberScan = window.HongguoNumberInput.create({
    request: requestScanInput,
    render: function (state) {
      var image = document.getElementById('search-scan-qr');
      image.classList.toggle('is-hidden', state.state !== 'waiting');
      if (state.state === 'waiting') image.src = state.qr; else image.removeAttribute('src');
      document.getElementById('search-scan-status').textContent = state.state === 'creating' ? uiText('ui.scanCreating', '正在生成二维码…') : state.state === 'waiting' ? uiText('ui.scanSearchWaiting', '扫码后输入剧名，点击发送并搜索') : state.state === 'closed' ? '' : state.message;
    },
    complete: function (kind, value) {
      if (kind !== 'search' || !searchScanOpen || pageMode() !== 'search' || applicationInBackground) return;
      closeSearchScan(false); searchInput.value = value;
      goFocus(firstSearchAction()); submitSearch();
    }
  });
  danmakuNumberScan = window.HongguoNumberInput.create({
    request: requestScanInput,
    render: function (state) {
      var image = document.getElementById('search-scan-qr');
      image.classList.toggle('is-hidden', state.state !== 'waiting');
      if (state.state === 'waiting') image.src = state.qr; else image.removeAttribute('src');
      document.getElementById('search-scan-status').textContent = state.state === 'creating' ? uiText('ui.scanCreating', '正在生成二维码…') : state.state === 'waiting' ? uiText('ui.scanDanmakuWaiting', '扫码后输入弹幕，回填电视后确认发送') : state.state === 'closed' ? '' : state.message;
    },
    complete: function (kind, value) {
      if (kind !== 'danmaku' || !danmakuScanOpen || !playerOptionsOpen || applicationInBackground) return;
      closeDanmakuScan(false);
      var input = document.getElementById('player-compose-input');
      input.value = value;
      if (composeSession) storeDraft(danmakuDrafts, draftKey(composeSession), value);
      goFocus(input);
    }
  });
  document.getElementById('search-scan-close').addEventListener('click', function () { if (danmakuScanOpen) closeDanmakuScan(true); else closeSearchScan(true); });
  document.getElementById('search-scan-refresh').addEventListener('click', function () { if (danmakuScanOpen) danmakuNumberScan.start('danmaku'); else if (searchScanOpen) searchNumberScan.start('search'); });
  accountNumberScan = window.HongguoNumberInput.create({
    request: requestScanInput,
    render: function (state) {
      var image = document.getElementById('account-number-qr');
      image.classList.toggle('is-hidden', state.state !== 'waiting');
      if (state.state === 'waiting') image.src = state.qr; else image.removeAttribute('src');
      document.getElementById('account-number-scan-status').textContent = state.state === 'creating' ? uiText('ui.scanCreating', '正在生成二维码…') : state.state === 'waiting' ? uiText('ui.scanNumberWaiting', '手机扫码，填写或粘贴数字后回填电视') : state.state === 'closed' ? '' : state.message;
    },
    complete: function (kind, value) { numericKeypad.completeRemote(kind, value); }
  });
  window.HongguoNumericKeypad.keys.forEach(function (key, index) {
    var button = document.createElement('button'); button.type = 'button'; button.className = 'account-keypad-key';
    button.setAttribute('data-key', key); button.setAttribute('data-focus', 'account-digit-' + key);
    button.textContent = key === 'delete' ? uiText('ui.keypadDelete', '删除') : key === 'done' ? uiText('ui.keypadDone', '完成') : key;
    button.addEventListener('click', function () { numericKeypad.choose(index); numericKeypad.press(key); });
    document.getElementById('account-keypad-keys').appendChild(button);
  });
  document.querySelectorAll('.account-input').forEach(function (field) { if (!desktopShell) field.addEventListener('click', function () { openAccountKeypad(field); }); });

  engagement = window.HongguoEngagement.create({
    request: function (target) {
      var controller = new AbortController();
      return { abort: function () { controller.abort(); }, promise: fetchData('/api/v1/player/stats?' + new URLSearchParams(target), { signal: controller.signal }) };
    },
    render: function (target, data) {
      setEpisodeCover(target, data);
      ['like', 'favorite', 'comment'].forEach(function (kind) {
        var field = { like: 'likes', favorite: 'favorites', comment: 'comments' }[kind];
        var text = window.HongguoEngagement.countText(data && data[field]);
        document.getElementById('hero-' + kind + '-count').textContent = text;
        updateActionLabel(kind);
      });
    }
  });

  smsVerification = window.HongguoSMSVerification.create({
    canPoll: function () { return pageMode() === 'account' && !applicationHidden(); },
    request: function () {
      var controller = new AbortController();
      return { abort: function () { controller.abort(); }, promise: accountRequest('verify', {}, controller.signal).then(function (ok) {
        return { confirmed: ok && accountData && accountData.logged_in, active: ok && accountData && accountData.phase === 'mfa', error: !ok };
      }) };
    },
    onState: function (value) {
      if (value.state === 'expired') { accountNotice = uiText('ui.accountVerificationExpired', '本机验证等待时间已结束，请重新获取验证码'); accountNoticeIsError = false; }
      renderAccount();
      if (value.state === 'timeout' && pageMode() === 'account' && !supportModalOpen) goFocus(document.getElementById('account-verify'));
      if (value.state === 'expired' && !applicationHidden()) pollAccount();
    }
  });

  document.querySelectorAll('.sidebar-display-action').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!sidebarSettings.choose(button.getAttribute('data-mode'))) showNotice(uiText('settings.saveFailed', '设置未能保存，请重试。'));
    });
  });
  renderLocaleSettings();
  document.querySelectorAll('.locale-action').forEach(function (button) {
    button.addEventListener('click', function () {
      var i18n = window.HongguoI18n;
      var locale = button.getAttribute('data-locale');
      if (!i18n || typeof i18n.setLocale !== 'function' || !i18n.setLocale(locale)) {
        showNotice(uiText('settings.languageSaveFailed', '语言设置未能保存，请重试。'));
        return;
      }
      renderLocaleSettings();
      window.setTimeout(function () { window.location.reload(); }, 0);
    });
  });
  var desktopUpdateNotifiedCode = 0;
  var appUpdates = window.HongguoAppUpdates.create({
    bridge: window.HongguoTVUpdates,
    canPrompt: canShowAppUpdate,
    render: function (data) {
      var current = document.getElementById('app-current-version');
      if (data.current_version) current.textContent = data.current_version + (data.edition ? ' · ' + data.edition : '');
      else if (data.state === 'browser') current.textContent = uiText('ui.browserPreview', '网页预览');
      document.getElementById('app-update-state').textContent = data.message || uiText('ui.updateDefault', '启动后每天自动检查一次，播放时不打扰。');
      var check = document.getElementById('app-check-update');
      // Keep the active TV focus node alive while native checking/download runs.
      check.disabled = !data.supported;
      check.setAttribute('aria-disabled', data.state === 'checking' || data.state === 'downloading' || data.state === 'installing' ? 'true' : 'false');
      check.textContent = data.state === 'checking' ? uiText('ui.checking', '检查中…') : data.manual_install ? uiText('ui.checkUpdate', '检查更新') : !data.desktop && data.state === 'ready' ? uiText('ui.installUpdate', '安装更新') : !data.desktop && data.state === 'available' ? uiText('ui.viewUpdate', '查看更新 {version}', { version: data.latest_version }) : uiText('ui.checkUpdate', '检查更新');
      if (webosShell && data.manual_install) {
        var webosNotes = document.getElementById('desktop-update-notes');
        webosNotes.classList.toggle('is-hidden', !data.latest_version);
        webosNotes.classList.add('webos-update-notes');
        webosNotes.setAttribute('tabindex', data.latest_version ? '0' : '-1');
        webosNotes.setAttribute('data-focus', 'webos-update-notes');
        webosNotes.setAttribute('aria-label', uiText('ui.webosUpdateDetails', '更新说明与手动安装方法'));
        var webosNotesText = data.latest_version ? uiText('ui.releaseVersion', '版本 {version}', { version: data.latest_version }) + '\n\n' + uiText('ui.webosInstallGuide', '请在电脑上打开以下发布页面，下载 IPK 后使用 webOS Dev Manager 手动安装：') + '\n' + data.release_url + '\n\n' + data.release_notes : '';
        if (webosNotes.textContent !== webosNotesText) webosNotes.textContent = webosNotesText;
        if (data.state === 'available' && data.prompt_allowed && !data.notified && canShowAppUpdate()) {
          showNotice(uiText('ui.webosUpdateNotice', '发现 webOS 新版本 {version}，可在设置中查看安装说明。', { version: data.latest_version }));
          window.HongguoTVUpdates.markNotified(data.latest_version);
        }
      }
      if (data.desktop) {
        var downloading = data.state === 'downloading';
        var download = document.getElementById('desktop-download-update');
        download.classList.toggle('is-hidden', !(data.state === 'available' || downloading || data.state === 'error' && data.latest_code));
        download.setAttribute('aria-disabled', downloading || data.state === 'checking' ? 'true' : 'false');
        download.textContent = downloading ? uiText('ui.downloadingPercent', '下载中 {percent}%', { percent: data.total ? Math.floor(data.downloaded * 100 / data.total) : 0 }) : uiText('ui.downloadZip', '下载更新 ZIP');
        var folder = document.getElementById('desktop-open-update-folder');
        folder.classList.toggle('is-hidden', data.state !== 'ready');
        if (document.activeElement === download && data.state === 'ready') goFocus(folder);
        else if (document.activeElement === download && download.classList.contains('is-hidden')) goFocus(check);
        var notes = document.getElementById('desktop-update-notes');
        notes.classList.toggle('is-hidden', !data.release_notes);
        notes.textContent = data.release_notes ? uiText('ui.releaseVersion', '版本 {version}', { version: data.latest_version }) + '\n' + data.release_notes : '';
        if (data.state === 'available' && data.latest_code > desktopUpdateNotifiedCode && data.prompt_allowed && canShowAppUpdate()) {
          desktopUpdateNotifiedCode = data.latest_code;
          showNotice(uiText('ui.newVersionNotice', '发现新版本 {version}，可在设置中下载更新。', { version: data.latest_version }));
        }
      }
    }
  });
  document.getElementById('app-check-update').addEventListener('click', appUpdates.activate);
  document.getElementById('desktop-download-update').addEventListener('click', function () { if (desktopShell) window.HongguoTVUpdates.download(); });
  document.getElementById('desktop-open-update-folder').addEventListener('click', function () { if (desktopShell) window.HongguoTVUpdates.openFolder(); });
  var playbackSettings = window.HongguoPlaybackSettings.create({
    bridge: window.HongguoNativePlayer,
    render: function (data) {
      document.getElementById('mpv-playback-settings').classList.toggle('is-hidden', !data.supported);
      document.querySelectorAll('.playback-mode-action').forEach(function (button) {
        var selected = button.getAttribute('data-mode') === data.mode;
        button.classList.toggle('account-primary', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      document.getElementById('mpv-decode-state').textContent = data.message || '';
    }
  });
  document.querySelectorAll('.playback-mode-action').forEach(function (button) {
    button.addEventListener('click', function () { playbackSettings.choose(button.getAttribute('data-mode')); });
  });
  autoCinemaPreferences = window.HongguoAutoCinema.create({
    platform: autoCinemaPlatform,
    bridge: window.HongguoTVPreferences,
    storage: sidebarStorage,
    render: function (data) {
      autoCinemaSettingCard.classList.toggle('is-hidden', !data.supported);
      autoCinemaEnabled = data.enabled;
      autoCinemaToggle.setAttribute('aria-pressed', data.enabled ? 'true' : 'false');
      autoCinemaToggle.classList.toggle('account-primary', data.enabled);
      autoCinemaToggle.textContent = uiText(data.enabled ? 'settings.autoCinemaEnabled' : 'settings.autoCinemaDisabled', data.enabled ? '已开启' : '已关闭');
      document.getElementById('auto-cinema-state').textContent = data.message ? uiText('settings.saveFailed', '设置未能保存，请重试。') : data.supported ? uiText('settings.autoCinemaState', '仅应用于安卓与 webOS 的单剧卡片播放。') : '';
    }
  });
  autoCinemaToggle.addEventListener('click', function () {
    cancelPendingAutoCinema();
    if (!autoCinemaPreferences.choose(autoCinemaPreferences.enabled() ? 'disabled' : 'enabled')) showNotice(uiText('settings.saveFailed', '设置未能保存，请重试。'));
  });
  var webosAudio = webosShell && window.HongguoWebOSAudio;
  function updateWebOSAudioSettings() {
    var audio = webosShell && window.HongguoWebOSAudio;
    var supported = !!(audio && audio.supported);
    document.getElementById('webos-audio-settings').classList.toggle('is-hidden', !supported);
    if (!supported) return;
    var toggle = document.getElementById('webos-audio-toggle');
    var enabled = audio.isEnabled();
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggle.textContent = enabled ? uiText('settings.autoCinemaEnabled', '已开启') : uiText('settings.autoCinemaDisabled', '已关闭');
  }
  function renderEpisodePrefetchSettings(data) {
    if (!episodePrefetchSettingCard) return;
    episodePrefetchSettingCard.classList.toggle('is-hidden', !data.supported);
    document.querySelectorAll('.episode-prefetch-action').forEach(function (button) {
      var selected = button.getAttribute('data-mode') === data.mode;
      button.classList.toggle('account-primary', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    var state = document.getElementById('episode-prefetch-state');
    if (!state) return;
    state.textContent = data.message ? uiText('settings.saveFailed', '设置未能保存，请重试。') : data.supported ?
      uiText(data.mode === 'full' ? 'settings.episodePrefetchCurrentFull' : 'settings.episodePrefetchCurrentRange', data.mode === 'full' ? '当前：整集预下载' : '当前：边播边下') : '';
  }
  function renderRecommendationDirectionSettings(data) {
    var card = document.getElementById('recommendation-direction-settings');
    if (!card) return;
    card.classList.toggle('is-hidden', !data.supported);
    document.querySelectorAll('.recommendation-direction-action').forEach(function (button) {
      var selected = button.getAttribute('data-mode') === data.mode;
      button.classList.toggle('account-primary', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    var state = document.getElementById('recommendation-direction-state');
    if (!state) return;
    var stateKey = data.mode === 'landscape' ? 'settings.recommendationDirectionCurrentLandscape' : data.mode === 'portrait' ? 'settings.recommendationDirectionCurrentPortrait' : 'settings.recommendationDirectionCurrentAll';
    var stateFallback = data.mode === 'landscape' ? '当前：仅横屏剧' : data.mode === 'portrait' ? '当前：仅竖屏剧' : '当前：全部剧';
    state.textContent = data.message ? uiText('settings.saveFailed', '设置未能保存，请重试。') : data.supported ? uiText(stateKey, stateFallback) : '';
  }
  function initRecommendationDirectionSettings() {
    if (!window.HongguoRecommendationDirection) return;
    recommendationDirectionSettings = window.HongguoRecommendationDirection.create({
      platform: recommendationDirectionPlatform(), storage: sidebarStorage, bridge: window.HongguoTVPreferences,
      render: renderRecommendationDirectionSettings
    });
    document.querySelectorAll('.recommendation-direction-action').forEach(function (button) {
      button.addEventListener('click', function () {
        if (!recommendationDirectionSettings.choose(button.getAttribute('data-mode'))) showNotice(uiText('settings.saveFailed', '设置未能保存，请重试。'));
      });
    });
  }
  function initEpisodePrefetchSettings() {
    episodePrefetchSettings = HongguoEpisodePrefetchSettings.create({
      platform: episodePrefetchPlatform(),
      read: function () { return playbackPreferences.prefetch_mode; },
      write: function (value) {
        var previous = playbackPreferences.prefetch_mode;
        playbackPreferences.prefetch_mode = value;
        if (!savePlaybackPreferences()) { playbackPreferences.prefetch_mode = previous; return false; }
        episodePrefetch.cancel();
        if (playbackPrefetchHandoff && playbackPrefetchHandoff.prefetchMode === 'full' && value !== 'full') {
          playbackPrefetchHandoff.cancel();
          playbackPrefetchHandoff = null;
        }
        if (activePlayback && activePlayback.started && !activePlayback.ended && !activePlayback.completed) {
          activePlayback.stableSince = Date.now();
        }
        return true;
      },
      render: renderEpisodePrefetchSettings
    });
    document.querySelectorAll('.episode-prefetch-action').forEach(function (button) {
      button.addEventListener('click', function () {
        if (!episodePrefetchSettings || !episodePrefetchSettings.choose(button.getAttribute('data-mode'))) {
          showNotice(uiText('settings.saveFailed', '设置未能保存，请重试。'));
        }
      });
    });
  }
  updateWebOSAudioSettings();
  initRecommendationDirectionSettings();
  if (webosAudio && webosAudio.supported) {
    document.getElementById('webos-audio-toggle').addEventListener('click', function () {
      if (!webosAudio.choose(!webosAudio.isEnabled())) showNotice(uiText('settings.saveFailed', '设置未能保存，请重试。'));
      updateWebOSAudioSettings();
    });
  }
  var licenses = document.getElementById('app-open-licenses');
  if (window.HongguoNativePlayer && window.HongguoNativePlayer.showLicenses) {
    licenses.classList.remove('is-hidden');
    licenses.addEventListener('click', function () { window.HongguoNativePlayer.showLicenses(); });
  }
  appUpdates.refresh();
  setInterval(appUpdates.refresh, 1000);
  updateFollowNotificationAccess();
  syncNativePlaybackPageState();
  goFocus(document.querySelector('.side-item.is-active'));
  playbackMenuHintSeen = readPlaybackMenuHintSeen();
  restorePlaybackPreferences();
  initEpisodePrefetchSettings();
  loadStatus();
  libraryReady = loadLibrary();
  pollAccount();
  accountPollTimer = setInterval(function () { if (!applicationHidden()) pollAccount(); }, 8000);
    var initialHomeProgram = null;
    try {
      if (window.HongguoTVHome && window.HongguoTVHome.consumeHomeProgram) {
        var pendingHomeProgram = window.HongguoTVHome.consumeHomeProgram();
        if (pendingHomeProgram) initialHomeProgram = JSON.parse(pendingHomeProgram);
      }
    } catch (error) { initialHomeProgram = null; }
    if (!initialHomeProgram || !window.HongguoTV.openHomeProgram(initialHomeProgram)) loadCatalog(uiText('nav.recommend', '推荐'));
}());
