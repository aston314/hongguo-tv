(function () {
  'use strict';
  var copy = {
    'zh-CN': { brand:'红果短剧',title:'手机找剧',copy:'用熟悉的输入法，把想看的剧送到电视。',label:'剧名 / 关键词',input:'输入或粘贴剧名',send:'发送到电视搜索',hint:'收藏此页面，下次无需重新扫码。\n手机与电视需在同一局域网，电视需打开“找剧”。\n电视 IP 变化后，请重新扫码。',connecting:'正在连接电视…',ready:'电视已就绪，可以开始搜索。',inactive:'请先在电视上打开红果短剧，进入“找剧”页。',offline:'暂时连接不上电视。请确认应用已打开、手机与电视在同一局域网；电视 IP 变化后需重新扫码。',sent:'已发送，请在电视上查看结果。还可以继续输入其他剧名。',pending:'已发送，正在等待电视接收…',invalid:'请输入不超过 100 字的剧名或关键词。',stale:'电视页面已切换，请再次点击发送。' },
    'zh-TW': { brand:'紅果短劇',title:'手機找劇',copy:'用熟悉的輸入法，把想看的劇送到電視。',label:'劇名 / 關鍵字',input:'輸入或貼上劇名',send:'傳送到電視搜尋',hint:'收藏此頁面，下次不必重新掃碼。\n手機與電視需在同一區域網路，電視需開啟「找劇」。\n電視 IP 變更後，請重新掃碼。',connecting:'正在連線到電視…',ready:'電視已就緒，可以開始搜尋。',inactive:'請先在電視上開啟紅果短劇，進入「找劇」頁。',offline:'暫時無法連線到電視。請確認應用已開啟、手機與電視在同一區域網路；電視 IP 變更後需重新掃碼。',sent:'已傳送，請在電視上查看結果。還可以繼續輸入其他劇名。',pending:'已傳送，正在等待電視接收…',invalid:'請輸入不超過 100 字的劇名或關鍵字。',stale:'電視頁面已切換，請再次點擊傳送。' },
    'ja-JP': { brand:'紅果短劇',title:'スマホで作品検索',copy:'いつもの入力方法で、見たい作品をテレビに送信。',label:'作品名 / キーワード',input:'作品名を入力または貼り付け',send:'テレビで検索',hint:'このページをブックマークすると次回からスキャン不要です。\nスマホとテレビを同じネットワークに接続し、テレビの「検索」を開いてください。\nテレビの IP が変わった場合は再度スキャンしてください。',connecting:'テレビに接続中…',ready:'テレビで検索できます。',inactive:'テレビでアプリを起動し、「検索」を開いてください。',offline:'テレビに接続できません。アプリとネットワークを確認してください。IP が変わった場合は再度スキャンしてください。',sent:'送信しました。テレビで結果を確認してください。続けて別の作品を検索できます。',pending:'送信済み。テレビの受信を待っています…',invalid:'作品名を 100 文字以内で入力してください。',stale:'テレビの画面が変わりました。もう一度送信してください。' }
  };
  var language = String(navigator.language || '').toLowerCase();
  var locale = /^ja/.test(language) ? 'ja-JP' : /(?:tw|hk|hant)/.test(language) ? 'zh-TW' : 'zh-CN', t = copy[locale];
  document.documentElement.lang = locale; document.title = t.brand + ' · ' + t.title;
  ['brand','title','copy','label','send'].forEach(function (id) { document.getElementById(id).textContent = t[id]; });
  document.getElementById('query').placeholder = t.input;
  document.getElementById('hint').textContent = t.hint; document.getElementById('hint').style.whiteSpace = 'pre-line';
  var input = document.getElementById('query'), button = document.getElementById('send'), status = document.getElementById('status');
  var endpoint = window.location.pathname.replace(/\/?$/, '/') + 'state';
  var nonce = '', ready = false, pending = false, sending = false, reading = false, timer = null, sent = false, revision = 0;
  function message(text, state) { status.textContent = text; status.setAttribute('data-state', state || ''); }
  function request(method, body, done) {
    var xhr = new XMLHttpRequest(); xhr.open(method, endpoint, true); xhr.timeout = 6000;
    if (body) xhr.setRequestHeader('Content-Type','application/json');
    var finished = false;
    function finish(data) { if (finished) return; finished = true; done(xhr.status, data); }
    xhr.onload = function () { var data; try { data = JSON.parse(xhr.responseText); } catch (ignored) {} finish(data); };
    xhr.onerror = xhr.ontimeout = function () { finish(null); };
    xhr.send(body ? JSON.stringify(body) : null);
  }
  function schedule() { clearTimeout(timer); if (!document.hidden) timer = setTimeout(refresh, 3000); }
  function refresh() {
    if (reading || sending || document.hidden) { schedule(); return; }
    reading = true; var current = revision;
    request('GET',null,function (code,data) {
      reading = false;
      if (current !== revision) { schedule(); return; }
      ready = code === 200 && !!(data && data.ready); pending = ready && !!data.pending; nonce = ready ? data.nonce : '';
      button.disabled = sending || !ready || pending;
      message(code !== 200 ? t.offline : !ready ? t.inactive : pending ? t.pending : sent ? t.sent : t.ready, code !== 200 ? 'error' : sent && ready ? 'success' : '');
      schedule();
    });
  }
  document.getElementById('form').addEventListener('submit',function (event) {
    event.preventDefault(); if (!ready || pending || sending) return;
    var value = input.value.trim();
    if (!value || value.length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(value)) { message(t.invalid,'error'); return; }
    sending = true; revision++; button.disabled = true;
    request('POST',{nonce:nonce,query:value},function (code,data) {
      sending = false;
      if (code === 200 && data && data.accepted) { sent = true; input.value = ''; message(t.pending,'success'); }
      else message(data && data.error === 'TV_NOT_READY' ? t.inactive : data && data.error === 'STALE_FORM' ? t.stale : code === 400 ? t.invalid : t.offline,'error');
      // Refresh the one-use form key, but never silently resubmit a query.
      ready = false; nonce = ''; clearTimeout(timer); timer = setTimeout(refresh,1000);
    });
  });
  document.addEventListener('visibilitychange',function () { clearTimeout(timer); if (!document.hidden) refresh(); });
  message(t.connecting); refresh();
}());
