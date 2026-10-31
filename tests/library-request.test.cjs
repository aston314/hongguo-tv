const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {uiText, apiError, localizedError} = require('./helpers/app-text.cjs');
const source = fs.readFileSync(require.resolve('../core/cmd/hongguotv/ui/app.js'), 'utf8');
const fn = name => source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'))[0];

function fixture(owner = '') {
  const requests = [], notices = [];
  const video = {currentTime: 12.5, duration: 180.25};
  const c = {Promise, uiText, apiError, localizedError, accountEpoch: 1,
    libraryReady: Promise.resolve(), libraryQueue: Promise.resolve(), libraryData: {owner_id: owner, entries: []},
    detailModalOpen: false, activePlayback: null, document: {getElementById: () => video},
    updateSavedButtons() {}, updateDetailProgress() {}, isLibraryPage: () => false,
    showNotice: text => notices.push(text),
    fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      requests.push({url, body: options.body, request});
      return {ok: true, status: 200, json: async () => ({ok: true, data: {owner_id: owner, entries: []}})};
    }};
  vm.createContext(c);
  vm.runInContext(fn('basicDrama') + '\n' + fn('changeLibrary') + '\n' + fn('saveProgress'), c);
  return {c, requests, notices};
}

test('single-drama progress fits the real HTTP limit before server-side summary trimming', async () => {
  for (const owner of ['', '1234567890123456789']) {
    const {c, requests, notices} = fixture(owner);
    const drama = {series_id: '7690163276214176792', title: '详情播放', cover: 'https://cover.example/1.jpg',
      intro: '剧情🎬'.repeat(12000), tags: Array.from({length: 60}, (_, i) => '标签' + i),
      episode_count: 144, vid_list: Array(144).fill('7654933376318589977'),
      episodes: Array.from({length: 144}, (_, i) => ({index: i + 1, video_id: '7654933376318589977'}))};
    const before = JSON.stringify(drama);
    const uncapped = {action: 'progress', drama: {series_id: drama.series_id, title: drama.title, intro: drama.intro}};
    assert.ok(Buffer.byteLength(JSON.stringify(uncapped)) > 32768, 'fixture must reproduce the old rejected body size');
    c.activePlayback = {item: drama, started: true, lastWrite: 0, episode: 3, vid: '7654933376318589977'};
    assert.equal(await c.saveProgress(true, false), true);
    const {body, request} = requests[0];
    assert.ok(Buffer.byteLength(body) < 32768);
    assert.equal(request.owner_id, owner);
    assert.equal(request.drama.series_id, drama.series_id);
    assert.equal(request.video_id, '7654933376318589977');
    assert.equal(request.episode, 3);
    assert.equal(request.position, 12.5);
    assert.equal(request.duration, 180.25);
    assert.equal(Array.from(request.drama.intro).length, 1000);
    assert.equal(request.drama.intro, Array.from(drama.intro).slice(0, 1000).join(''));
    assert.equal(request.drama.tags.length, 8);
    assert.equal(request.drama.vid_list, undefined);
    assert.equal(request.drama.episodes, undefined);
    assert.equal(JSON.stringify(drama), before, 'do not change player details or episode selection');
    assert.equal(notices.length, 0);
  }
});

test('normal record metadata and schema types remain unchanged', () => {
  const {c} = fixture();
  const drama = {series_id: '7690163276214176792', title: '正常记录', cover: '', cover_fallback: '', intro: '简介🎬', score: '9.5',
    episode_count: 144, tags: ['剧情'], season_index: 2, is_multi_season: true, content_type: 'video',
    video_category_type: '1', following_update: true, followed: true, follow_count: 12345,
    show_update_frequency: '每日', latest_watched_episode: 3, has_watched_latest_episode: false, series_status: '0'};
  const result = c.basicDrama(drama);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), drama);
  assert.notEqual(result.tags, drama.tags, 'record snapshot must not alias the detail tag array');
});

test('server validation failures stay visible and later progress writes can recover', async () => {
  const {c, notices} = fixture();
  c.activePlayback = {item: {series_id: '123', title: 'fixture'}, started: true, lastWrite: 0, episode: 1, vid: '456'};
  let calls = 0;
  c.fetch = async () => {
    const failed = ++calls === 1;
    return {ok: !failed, status: failed ? 400 : 200, json: async () => failed ?
      {ok: false, error: '记录字段格式无效：drama.tags', code: 'LIBRARY_FIELD_TYPE', field: 'drama.tags'} :
      {ok: true, data: {owner_id: '', entries: []}}};
  };
  assert.equal(await c.saveProgress(true, false), false);
  assert.match(notices[0], /本机记录未保存.*drama.tags/);
  assert.equal(await c.saveProgress(true, false), true);
  assert.equal(calls, 2, 'one failed write must not poison the record queue');
});
