# 远程公告清单

正式版从 `hongguo-tv-releases/main/announcements.json` 读取公告。清单只用于设置页提示，不会在播放中弹窗，也不会参与播放地址请求。

```json
{
  "schema": 1,
  "channel": "stable",
  "items": [
    {
      "id": "playback-api-20261124",
      "enabled": true,
      "kind": "playback",
      "level": "warning",
      "title": "播放服务调整中",
      "summary": "部分剧集可能暂时无法取到播放地址",
      "body": "我们正在适配上游接口变化，请稍后重试或更新应用。",
      "platforms": ["android", "desktop", "webos", "linux"],
      "before_version": "0.2.181",
      "published_at": "2026-11-24T10:00:00Z",
      "expires_at": "2026-12-01T10:00:00Z",
      "dismissible": true,
      "action": { "type": "check_update", "label": "检查更新" }
    }
  ]
}
```

`enabled` 必须明确写成 `true` 才会显示，改为 `false` 可以立即下线；缺失或写成其他类型的条目会被忽略。`expires_at` 到期后自动隐藏，`platforms` 和 `before_version` 可限制平台与旧版本。需要再次提醒时使用新的 `id`，避免用户已经点过“知道了”的旧公告再次出现。
