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

## 关联播放自动修复

播放类公告可以使用以下操作：

```json
"action": { "type": "repair_playback", "label": "更新播放解析", "min_revision": 7 }
```

按钮定位到公告下方的自动修复区块。尚未开启时焦点停在开关，由用户确认开启；已开启时检查解析更新。公告只负责引导，不能开启设置、指定脚本地址或跳过验签。`min_revision` 对应签名规则清单的控制版本；只有本机已启用修复规则且版本达到要求，才显示“本公告对应的播放规则已就绪”。知道了/公告已读与规则是否修复分别保存。旧版客户端会忽略新操作，仍保留公告文字和原有应用更新入口。

相关公告建议仅投放 Android / desktop / linux；webOS 尚不支持在线规则更新时，需使用原有 `check_update` 引导升级应用。先发布并验证签名规则，再启用关联公告，避免公告提前声称修复已可用。
