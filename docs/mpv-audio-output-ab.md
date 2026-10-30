# MPV 音频后端实机对照

针对 Android 6 ZIDOO X9S 的声音滞后反馈，先对照输出后端，暂不改变正式默认值。
普通构建保持 `ao=opensles,audiotrack`。仅私有对照构建允许
`HONGGUO_MPV_AUDIO_OUTPUT=audiotrack,opensles`，诊断分别记录请求顺序与实际 `current-ao`。
没有新增设置项或任意 MPV 参数入口；Media3、HTML5、桌面及 webOS 不改变。

## 包与交付

- 两包来自同一最新主线基线及同一提交，共用一次编译的 Go 核心和固定 MPV 库。
- A：OpenSL ES 优先；B：AudioTrack 优先，初始化失败时仍允许 OpenSL ES。
- 继续使用现有正式签名、包名和版本号，可用 `adb install -r` 顺序覆盖，不能卸载清数据。
- 签名、三个 ABI、后端常量，以及 Java/signature 之外的完整 APK 内容必须通过校验。
- 只经 GitHub Actions 构建。下载暂存于私有 draft，验包下载后删除 draft；不生成更新清单，不镜像公开仓库。

## 实机步骤

1. 保存现有正式 APK、版本、签名信息和脱敏诊断，保留用户数据。
2. 对 A、B 使用相同视频文件、相同对白时间段、1 倍速、同一解码设置与音频接线。
3. 必须先确认 `audio_output` 真正对应目标后端；请求 AudioTrack 但回退 OpenSL 不算完成 B 验证。
4. 对照首次播放、切集和 seek 后的实际嘴型，并记录采样率、avsync、丢帧、AudioTrack underrun。
5. 不同时强制 48 kHz、改缓冲、改解码模式或加固定 `audio-delay`，以免混淆原因。
6. 日志中的 avsync 和系统声明延迟不代表屏幕/扬声器实际偏移；效果需要实体观察或同步测试素材确认。

## 当前证据边界

2026-10-30 的现有 0.2.132 实机只读采集：OpenSL 44.1 kHz，混音输出 48 kHz，
系统输出声明延迟 64 ms，OpenSL 查询 unknown key，30 秒内 avsync 自报近零且无新增掉帧。
固定 MPV 源码查询 `androidGetAudioLatency`，失败后额外设备延迟项保持零，仍计入自身入队时长。
这些证据优先指向输出延迟估算，但没有量出实际嘴型差，也不能据此指定 150–300 ms 补偿。

正式默认值只有在对照效果及首次播放、切集、seek、前后台恢复均确认后再决定。
