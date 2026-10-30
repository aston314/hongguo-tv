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

## 2026-10-30 对照包与实机进展

- 基线为当时最新 `origin/main` 的 `7647f25`，构建提交 `7ddd408`。
- [对照包 CI](https://github.com/aston314/hongguo-tv/actions/runs/41008195102) 与
  [完整 CI](https://github.com/aston314/hongguo-tv/actions/runs/41008194983) 均成功，包含远端 Go、Android 单测、构建与 lint。
- 本地仅运行 558 项 Node、42 项 Python 检查及 APK 验包，没有编译 Go 或 Android。
- APK 使用已安装正式包的同一证书，SHA256 为
  `117dc57341c638a6f416ef256e0d9893bcdf7961acfc4c1b270b79bea8b6785f`。
  两包的非 Java/签名条目完全一致，ARMv7 libmpv 仍为 `63fcca1a…`。
- 盒子原 APK 已备份，两次均覆盖安装成功，没有卸载或清数据。
- 同一份完整 HEVC/AAC 44.1 kHz 双声道视频通过盒子本地 HTTP 服务播放，避免网络和下载差异。
- A 实际后端为 `opensles`，B 为 `audiotrack`，B 没有退回 OpenSL；两者均保留自动解码与 `mediacodec-copy`。
- 每组记录 33 次播放器状态，首次播放、seek、换源、暂停/恢复、Home 后返回均有对应状态或持续进度，没有播放错误，解码丢帧为零。
- B 已补充截图确认视频实际可见。早期测试页曾被原生启动层挡住，纯播放器状态采样不算视觉验收；测试页已调整为等待核心启动完成后再进入。
- 实际扬声器/屏幕声画差尚待用户现场观察。上述结果不代表已测得补偿数值，也不代表全设备兼容。

校验完成后已删除临时 draft，未修改公开发布、版本号或更新清单。
对照代码保存在远端测试分支，正式主线默认音频顺序暂不修改。

## 第二轮：原始片源的实时 48 kHz 重采样

用户随后确认 AudioTrack 单独替换仍稍晚于嘴型；同一真人对白视频，保留视频轨、
仅离线转换音频至 48 kHz 后，用户反馈明显改善。活跃 48 kHz AudioTrack 仍为普通
Mixer（Flags `0x000`，无 `F` 标记），因此不能将改善解释为已经取得 FAST 通道。

下一轮保持 AudioTrack、解码器、原始 44.1 kHz 片源及其他参数相同，只对照：

- A：`HONGGUO_MPV_AUDIO_SAMPLE_RATE=auto`，不设置 MPV 输出采样率。
- B：`HONGGUO_MPV_AUDIO_SAMPLE_RATE=48000`，初始化时设置 `audio-samplerate=48000`，
  由 MPV 实时重采样；不播放离线转码文件来代替此验证。

普通构建仍为 `auto`，不改变正式默认参数。诊断新增 `audio_samplerate_requested`，
结合实际 `audio_rate` 确认参数生效。两包依然使用同一提交、核心、库、正式签名，
仅编译 Java 配置不同；签名及非 Java payload 校验继续保留。

这轮用于验证实时处理是否也有改善；离线 48 kHz 的主观效果不等于实时处理已通过。
只有实机确认后才讨论正式策略，不能据此推广为所有设备应固定 48 kHz。

### 实时重采样实机结果

- 构建提交 `6ff97bc`；[签名对照 CI](https://github.com/aston314/hongguo-tv/actions/runs/41017741587)
  和 [完整 CI](https://github.com/aston314/hongguo-tv/actions/runs/41017741564) 均通过。
- 下载后再次核对 SHA256、ZIP CRC、原正式证书、三 ABI 与全部非 Java/签名内容一致，
  临时 draft 已删除。两次 `adb install -r` 均成功，未卸载或清数据。
- 相同原始 AAC 44.1 kHz / HEVC 真人对白文件，A 实际输出 44100，B 实际输出 48000；
  后端始终为 `audiotrack`，解码路径与倍速不变，B 没有使用离线转码音轨。
- 每组 29 次采样覆盖开播、seek、换源、暂停恢复、暂停状态换源及前后台恢复，均无播放错误。
  两组解码丢帧均为零；暂停恢复附近输出丢帧计数分别达到 5 / 16，不能描述为所有过程零丢帧。
- B 另做约 30 秒连续播放：实际进度持续增长，输出 48000，解码/输出丢帧为零，无播放错误。
  稳态截图确认原生视频画面可见。采样切换途中的截图曾为黑屏，不能替代稳态可见性检查。
- B 稳态 AudioFlinger 为普通 Mixer、Flags `0x000`，活跃音轨 underrun 为零。
  本轮依然没有证明取得 FAST，也尚未用仪器测得物理声画差；听感等待用户确认。
- 未增加 `audio-delay`：固定补偿要与重采样分开验证。MPV 文档明确负数延迟视频、正数延迟音频，
  但 `-0.10` 的具体数值不能从日志推导，也不能直接对所有盒子启用。

测试代码继续保留在远端对照分支，正式主线、版本及更新通道均未改变。
