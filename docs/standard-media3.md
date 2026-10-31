# Android 标准版 Media3 播放路径

标准版当前使用 AndroidX Media3 1.11.1 和 NextLib Media3 Extensions 1.11.1-0.17.0；这两个版本与当前源码的 API 和 Android 6（minSdk 23）基线兼容。依赖升级只针对标准版播放器，MPV 版继续使用项目原有的独立播放栈。

Android 标准版从 Media3/ExoPlayer 开始播放，平台解码器优先。首帧出现前，如果 Media3 报告解码失败或选中的视频轨道超过设备能力，播放器最多重建一次并优先使用 NextLib FFmpeg 软件 renderer；保留已知的 VOD 位置。软件尝试仍失败时，页面回退到原有 HTML5 播放路径，同一播放源不会再次回到 Media3，避免失败循环。

每次设置新的播放源都会重新建立一个 Media3 尝试。一次源的 HTML5 兜底状态不会污染下一集或下一部剧。MPV、桌面和 webOS 路径不使用这套 renderer。

NextLib Media3 Extensions 及其 FFmpeg native libraries 按 GPL-3.0 声明。发布包含该依赖的 APK 前，发行流程必须提供对应版本的源代码、许可证文本和构建材料；这项分发检查与源码合并分开处理。

远端 CI 检查 Go/JavaScript/Android unit、debug build、lint、APK ABI 和播放器 flavor 隔离。参考项目已有 Media3 + FFmpeg 真实验证；本项目 CI 通过不等于已经在 Android 8/9 低端盒子、Android 9/13 设备或普通手机上完成实机播放验证。
