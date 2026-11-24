const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalize, normalizeItem } = require('../core/cmd/hongguotv/ui/announcements.js');

test('remote announcements require enabled=true and ignore expired entries', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const payload = { data: { items: [
    { id: 'missing', title: 'missing' },
    { id: 'disabled', enabled: false, title: 'disabled' },
    { id: 'expired', enabled: true, title: 'expired', expires_at: '2026-11-24T11:00:00Z' },
    { id: 'live', enabled: true, title: 'live', summary: 'summary', action: { type: 'unknown' } }
  ] } };
  const items = normalize(payload, now);
  assert.deepEqual(items.map(item => item.id), ['live']);
  assert.equal(items[0].action, null);
  assert.equal(items[0].dismissible, true);
});

test('announcement action and body are reduced to safe UI fields', () => {
  const item = normalizeItem({
    id: 'playback', enabled: true, title: '  播放服务  ', body: '  稍后重试  ',
    action: { type: 'check_update', label: '  更新  ' }, dismissible: false
  }, Date.now());
  assert.deepEqual(item, {
    id: 'playback', kind: '', level: '', status: '', title: '播放服务', summary: '', body: '稍后重试',
    dismissible: false, action: { type: 'check_update', label: '更新' }
  });
});

test('settings places announcements before the first settings choice', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'core/cmd/hongguotv/ui/index.html'), 'utf8');
  assert.ok(html.indexOf('id="system-announcements-card"') < html.indexOf('id="sidebar-display-settings"'));
});
