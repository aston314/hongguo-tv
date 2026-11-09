# Android ByteVC2 转码验证（2026-11-09）

本实验用于比较参考仓库的转码链路与此前 MPV 直接软解。所有 Android 原生工具及 APK
均由 GitHub Actions 构建，未在本机编译。分支为 `codex/bytevc2-transcode-validation`，
没有并入主线或修改正式版播放器。

## 当前结论

- 此前 MPV 直接软解的横屏、竖屏 720P 出画面及基本切集验证保留，属于有价值的可播放路径。
- 按参考方案在 Android 上解码 ByteVC2、重新编码 H.264/AAC **能够成功转换** 720P 和 1080P。
- 转完后交给 HTML5 播放的 720P 样本，在约 16 秒观察窗口内零掉帧，实际走系统 AVC 硬解。
- **边转边播不达标**：参考配置和 ARM 优化配置的 1080P 均出现明显掉帧；参考配置还跟不上实时播放。
- 1080P 整文件补测通过基本播放、暂停恢复、seek 和全屏检查；Media3 使用 NVIDIA AVC 硬解器，
  同一输出的 HTML5 播放约 53 秒采样内零掉帧。代价是先等待约 48 秒转码。
- 这些结果不支持把新库加入轻量标准版或默认启用转码。实验包保留用于继续验证。

## 与参考仓库的对应关系

参考固定于 [zfdang/hongguo-open-player 的 36316dc](https://github.com/zfdang/hongguo-open-player/tree/36316dcbe35aa05cfa0176036e56edba17188567)：

- FFmpeg、x264 源码提交及 BVC2 解码补丁一致。
- `reference` 与其一样关闭全局汇编优化；`optimized` 单独启用 ARM 汇编和 VVC DSP，不能混成同一组结果。
- 均先取得完整源文件，再解码 ByteVC2；视频编码参数均为 `libx264 -preset ultrafast -crf 25 -pix_fmt yuv420p`，音频重新编码为 AAC。
- 整文件输出使用 `+faststart`；流式输出使用 `-g 30` 和 `frag_keyframe+empty_moov+default_base_moof`，经 MSE 顺序追加。
- 两种模式都有五分钟任务上限、128MiB 输出限制及取消清理。流式模式并不代表可以省掉完整源下载。
- Android 增加已验证的 `hvc1 + bv2C` 识别补丁，否则真实样本会被误交给 HEVC 解码器。
- 本实验沿用已有 Go 层 CENC 解密后交给 FFmpeg；参考也支持把密钥交给 FFmpeg。解密位置不同，不改变本轮已解密同源样本的性能对照。

此前 MPV 直接软解与这条“解码 → 重新编码 → 浏览器/Media3 硬解”的完整链路不同。
不能把转码成功当成已找到 MPV 1080P 掉帧的根因，也不能把任何一次失败直接定责为硬件或算法。

## 同源转换性能

设备为 Shield / darcy / Android 11 / arm64。两档源均为 24fps、1485 个视频帧、61.875 秒；
源文件预先下载、解密完成。以下计时不含网络下载，也没有同时播放视频。

| 配置 | 720P 整文件 | 1080P 整文件 | 720P 流式首个完整 mdat | 1080P 流式首个完整 mdat |
| --- | ---: | ---: | ---: | ---: |
| 参考配置 | 26.439s / 2.36× | 56.136s / 1.11× | 1.154s | 2.128s |
| ARM 优化 | 20.151s / 3.11× | 43.048s / 1.45× | 0.893s | 1.662s |

两档均输出 H.264 + AAC，视频帧数及尺寸正确。优化配置的 720P/1080P 整文件输出约
23.7MB/39.5MB，原输入约 2.8MB/4.8MB，增加约八倍。1080P 转换进程峰值 RSS 约
413～417MiB，**不包括 Java、WebView、Go 等进程的内存**。

首个 mdat 接收时间仅是传输层观测，不是可见首帧，更不是用户从点击开始的总等待。

## 转码与实际播放同时进行

独立包 `rocks.aston.hongguotv.transcodetest.debug`，与正式包及此前 MPV 实验包数据隔离。
首轮 APK 为 `dab4737`，其中 Media3 测试页的透明背景和区域适配随后修正。

| 测试 | 可见首帧（源已下载） | 观测结果 |
| --- | ---: | --- |
| ARM 优化，720P 转完后 HTML5 播放 | 21.72s，含转码等待 | 约 16s 内 386 总帧、0 掉帧 |
| 参考配置，720P 边转边播 | 2.24s | 自然播至结尾，1485 总帧、100 掉帧；转码耗时 35.45s |
| ARM 优化，720P 边转边播（最终包） | 1.98s | 自然播至结尾，1485 总帧、88 掉帧；转换 26.80s |
| 参考配置，1080P 边转边播 | 3.91s | 约 71s 墙钟仅播至 55.53s，563/1331 掉帧，转码约 0.83×；未达标 |
| ARM 优化，1080P 边转边播 | 3.31s | 转码约 1.07×，457/1440 掉帧，存在缓冲；未达标 |

两种 1080P 流式测试在观察期限后取消，未以自然播完验收。
Chromium 的 `MediaCodecVideoDecoder` 和 `kIsPlatformVideoDecoder=true` 确认输出 AVC
走系统解码；音频为 `FFmpegAudioDecoder`。未人工听音，不能据此宣称已完成主观音画同步验收。

“纯转换快于实时”与“同时播放仍掉帧”可以同时成立。这说明必须测端到端竞争，不能只用
命令行速度宣称电视可以流畅播放；目前没有分别测得调度、解码、编码、MSE 和呈现的独立耗时。

## 最终 APK 补测

最终构建 `2c92d75` 已重新安装并核对 SHA256，约 16.1MB。

- 同源 1080P 整文件 ARM 优化转换约 47.8 秒，可见首帧约 50.1 秒（不含网络下载）。
  Media3 报告 `OMX.Nvidia.h264.decode`、`video/avc` 和首帧就绪；截图确认有实际画面。
- Media3 暂停两次采样均为 3.002 秒；恢复后进度继续；seek 后进度为 21.335 秒；
  原生全屏区域下仍在播放，时钟比约 0.998。当前 Media3 诊断不提供掉帧计数，不能写成零掉帧。
- 同一结果切到 HTML5，恢复后的约 53 秒采样内零掉帧；额外全屏采样约 12 秒、291 帧增量，零掉帧。
- 实时接口 720P + reference 整文件：取源/下载/解密 1.612 秒，转换 27.455 秒，
  点击到首帧约 29.48 秒，约 10 秒播放窗口内零掉帧。只核验了该 VID，不代表所有剧集。
- 显式取消、720P→1080P→720P 快速替换、退到桌面时，FFmpeg 进程消失，输入、输出、进度文件清理。
  实验页在后台选择取消任务，回前台不会偷偷继续转换；不是生产后台续播策略。
- 原生退出确认后，Go core 和 FFmpeg 均退出，CoreService 不再运行；Android 可缓存 UI/Chromium 进程。
- 直接向 core 发送 SIGKILL 的尝试被 SELinux 拒绝，**没有完成独立父进程死亡测试**。
  代码设置了 `Pdeathsig=SIGKILL` 并保留启动线程，但此点不能以本轮设备结果声称验收。

## 构建与复现

- [原生工具构建](https://github.com/aston314/hongguo-tv/actions/runs/42611298371)
- [首轮独立 APK](https://github.com/aston314/hongguo-tv/actions/runs/42612942805)
- [最终修正测试页与取消逻辑的 APK](https://github.com/aston314/hongguo-tv/actions/runs/42614915976)
- 原生源码与工具校验信息见 `scripts/bytevc2-transcode/build_android.sh`。
- `check_device.py` 接收两份 CI artifact、设备序列号和本地已解密样本，可分别复测整文件及流式输出。
  输出目录含媒体和原始日志，应放在仓库外；不得上传媒体、密钥、签名 URL 或账户数据。
- APK 只保存在未发布 draft，附完整应用源码、两套原生源码及 CI 生成补丁；没有发布到更新渠道。
- 固定样本可用 ADB 的 `run-as` 导入独立包 `cache/bvc2-samples/{720P,1080P}.mp4`；
  页面也能使用实时接口按指定剧 ID / VID 取源。两种路径不能混写成相同的首帧时间。

完整生产页面的自动切集、真实接口下载等待、旧盒子/ARMv7、桌面平台和主观听音尚未验收。
本轮不改正式版的选源顺序、MPV 配置或播放器默认值。

## 数据入口

- [原生转换与流式传输](../scripts/bytevc2-transcode/evidence/2026-11-09-shield-native.json)
- [首轮应用实测](../scripts/bytevc2-transcode/evidence/2026-11-09-shield-app.json)
- [最终包补测与生命周期](../scripts/bytevc2-transcode/evidence/2026-11-09-shield-final.json)
- [保留的 MPV 直接软解报告](bytevc2-android-feasibility.md)
