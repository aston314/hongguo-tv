# Android 标准版 Media3 播放路径

本分支的 Android 标准 flavor 从 Media3/ExoPlayer 开始播放，平台解码器优先。首帧出现前，如果 Media3 报告解码失败或选中的视频轨道超过设备能力，播放器最多重建一次并优先使用 NextLib FFmpeg 软件 renderer；保留已知的 VOD 位置。软件尝试仍失败时，页面回退到原有 HTML5 播放路径，同一播放源不会再次回到 Media3，避免失败循环。

每次设置新的播放源都会重新建立一个 Media3 尝试。一次源的 HTML5 兜底状态不会污染下一集或下一部剧。MPV、桌面和 webOS 路径不使用这套 renderer。

标准 APK 包含 NextLib Media3 Extensions 及其 FFmpeg native libraries，依赖按 GPL-3.0 声明。发布包含该依赖的 APK 前，需要核实对应源代码、许可证文本和构建说明的提供方式；在许可分发方案明确前，不生成正式发布包。

本分支由远端 CI 检查 Go/JavaScript/Android unit、debug build、lint、APK ABI 和播放器 flavor 隔离。参考项目已有 Media3 + FFmpeg 真实验证；本项目不把用户逐台验证 Android 8/9 低端盒子、Android 9/13 设备和普通手机作为推进前置条件，也不据此声称本项目已通过这些设备。

该路径目前处于独立分支。依赖 GPL-3.0 的源代码/许可分发责任需要明确后，才可并入统一主线或发布 APK。
