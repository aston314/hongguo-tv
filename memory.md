# 红果 TV 项目记忆

## 2026-11-09：ByteVC2 Android / MPV 独立实验

### 范围与约束

- 用户授权独立验证；Android APK 和原生库只在 GitHub 构建。
- 分支：`codex/bytevc2-android-validation`。不合并主线、不发布稳定版、不改标准版。
- 测试 APK 与正式版包名、数据隔离：`rocks.aston.hongguotv.mpv.bytevc2test.debug`。
- ByteVC2 解码支持与普通 HEVC 的 MediaCodec 绿屏/花屏是不同问题，不得混为一谈。
- 我们的桌面版尚未接入或验证 ByteVC2；参考桌面项目已有实现不代表我们的桌面版已支持。

### 已有证据

- GitHub APK 构建：`42604429691`，源码提交 `82cbaa2e3eb63efaa01a70561f7787e010d6c8db`。
- 原生组合：MPV 0.41.0、Jellyfin FFmpeg 8.1.3、参考 BVC2 补丁，加 `bv2C` 容器识别。
- Shield / Android 11 / arm64：真实横屏、竖屏 720P 能出画面；seek、暂停恢复、
  手动上下集、快速往返切集、实际片尾自动下一集、后台恢复和正常退出通过基本检查。
- 音频只核验 AudioTrack/AAC 输出状态与音画时钟，未人工听音；不要写成已完成主观声画验收。
- 1920×1080/30fps ByteVC2：持续渲染掉帧，音画时钟偏差曾约 17 秒，未达标。
- 原命令行实验的同一 1080P/24fps 文件放进 APK：约 15 秒观测到 86 个渲染丢帧，
  短时音画时钟偏差约 162ms；因此不能只用命令行 null 输出的 2.67× 宣称应用内流畅。
- HEVC 1080P 硬解对照在约 10 秒采样窗口内零掉帧，音画时钟稳定；HEVC 软解采样也可播放。
- 旧盒子/ARMv7、其他桌面平台未验证；本轮未自然选中 AVC 源，不能声称 AVC 对照通过。

### 1080P 为什么有问题：结论边界

**根因尚未定位，不能认定是“Shield 硬件不够”、解码算法错误，或漏抄参考补丁。**

1. **核心解码补丁一致。** 与 `zfdang/hongguo-open-player`
   `36316dcbe35aa05cfa0176036e56edba17188567` 的补丁逐字一致，SHA256 都是
   `fb0754afbd858cecbaacc5c0e2e9bf3a0ca47c9db74c0a8f37aa62f31bc48c18`。
   FFmpeg 基线也同为 `f6e945886e17c2cf882143bd98222b1bd66ffe28`。
2. **端到端播放路径不同。** 参考项目在外部 FFmpeg 进程解码 ByteVC2，再用
   `libx264 -preset ultrafast -crf 25` 编成 H.264，交给浏览器播放；支持整文件转码及
   fragmented MP4 边转边播。我们的 Android 实验把 BVC2 解码器嵌入 libmpv，
   CPU 实时解码后直接走 GPU/SurfaceView，并与 AudioTrack 同步，未转成 H.264。
   因此只能说“解码补丁相同”，不能说“播放实现与参考仓库完全一样”。
3. **当前只能确认完整实时播放链路未达性能要求。** 未分别测得解码耗时、CPU/线程利用率、
   GPU 上传/呈现耗时和音频同步开销；`frame-drop-count` 与 `avsync` 不能单独锁定 CPU 或 GPU。
   同一文件纯解码快于实时、进入应用后仍掉帧，说明必须排查集成后的额外开销、构建/调度配置，
   不能直接给硬件或算法定责。24fps 与 30fps 是不同样本，也不能直接互推性能。
4. **照参考转码不保证解决 Android 性能。** 转码仍需先软件解码 ByteVC2，还增加 H.264
   编码成本；整文件提前转码可把这部分等待移到播放前，边转边播仍受转码吞吐约束。
   参考桌面设备成功不证明电视盒子也能实时完成这条链路。

若后续继续定位，应使用同一文件、同一台设备，对照纯解码、MPV 视频输出与音频同步，
再评估参考转码路径；不要盲调线程数、Surface 尺寸或把未验收能力设成默认。
本轮 ByteVC2-only 是实验取源开关，有些集仅有 HEVC 会主动失败，不能照搬到生产选源。

### 证据入口

- [实验报告](docs/bytevc2-android-feasibility.md)
- [APK 实机证据](scripts/bytevc2/evidence/2026-11-09-shield-mpv-preview.json)
- [独立解码证据](scripts/bytevc2/evidence/2026-11-09-shield.json)
- [参考转码实现](https://github.com/zfdang/hongguo-open-player/blob/36316dcbe35aa05cfa0176036e56edba17188567/src/server/native/bytevc2-transcode.js)

媒体、截图、URL、密钥、账号留在本机临时目录，不写入记忆或公开仓库。
