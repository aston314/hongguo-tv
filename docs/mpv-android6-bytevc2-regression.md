# Android 6 MPV 0.2.130–0.2.132 片源回归

## 2026-10-30 实机证据

设备为 ZIDOO X9S / Realtek，Android 6.0.1、ARMv7。使用正式签名的
0.2.129、0.2.132 APK 覆盖安装，保留应用数据，没有本机构建 APK。
两个包的 ARMv7 `libmpv.so` SHA256 相同：
`63fcca1acbdf46e231f226298537c8b6a0cec9f4f0c1101eba82cfb08bc21c4e`。

| 测试 | 结果 |
| --- | --- |
| 129 按旧规则获取普通 HEVC 文件 | 正常播放，首帧约 571 ms |
| 132 仅改用旧规则 `codec_mode=default` 获取的普通 HEVC 文件 | 正常播放，首帧约 728 ms |
| 将 132 播放失败时保存的原始文件交给 129 | 同样卡住，主线程同步 MPV 属性读取阻塞 |

上述成功播放均为 `hwdec_current=mediacodec-copy`。该模式并非此次升级才出现。
保存的失败文件使用 `hvc1` sample entry，却包含 `bv2C` 配置，FFmpeg 无法正常
解析视频头；旧规则选出的文件包含正常的 `hvcC` 配置。

129 对失败文件的当次线程快照停在
`MpvPlayerBridge.updateDiagnostic → MPVLib.getPropertyInt → nativeDouble`。
132 另有主线程停在 `rendered → getPropertyInt → nativeDouble` 的快照。
进程存活不能作为主线程正常的证据。

## 根因和最小修正

`2b3ba01` 为软件解码增加 codec 筛选时，将原有的全局 `bytevc2` 排除条件
改成仅对 `default` 和 `software` 生效。MPV 的 `auto` 因此开始接受这些片源。
`hwdec=auto-safe` 只能选择解码器，不代表设备已经验证支持 `bytevc2`。

所有路径恢复排除 `bytevc2`；软件路径继续额外排除 `bytevc1`。
完整下载和 Range 共享该候选筛选函数，因此一并生效。标准版原有的筛选结果不变。
媒体缓存根目录按进程新建，不跨进程复用旧 job，无需迁移用户缓存或清除应用数据。

此次不改变 MPV 换源、Surface、解码默认项和线程归属。同步属性读取仍有在底层故障时
阻塞主线程的既有风险；将其异步化需要另行处理线程所有权和销毁时序。
这里的实机结果确认的是片源筛选回归，不能代替修正后正式 APK 的完整切集验收。

## 真实页面补充验证

在 132 正式包的当前页面中，临时将播放接口的 `codec_mode=auto` 改为 `default`，
保留 MPV 自动解码、换源和 Surface 代码。该操作使片源筛选等同于本次修正后的
自动解码候选集，不是安装了修正后的 APK，重启页面后调试改写失效。

- 推荐页面两次换剧正常，播放器 `load_to_output_ready_ms` 为 542、1038 ms。
- 全屏从第 1 集切至第 2 集正常，同一指标为 314 ms，播放进度继续推进。
- 解码模式均为 `mpv_auto`，实际为 `mediacodec-copy`，没有记录播放错误。
- 修正提交 `819881c` 的远端 CI 全部通过，包括 Go、页面、webOS 检查及两个 Android
  变体的构建、单元测试、lint 和包隔离验证。本机未编译。

这些耗时从播放器收到装载请求计起，不包含接口解析和媒体下载时间。
