# Android 标准版 Media3 回退路径

标准版当前使用 AndroidX Media3 1.11.1 和 NextLib Media3 Extensions 1.11.1-0.17.0；工程使用 compileSdk 36、targetSdk 35，Android 6（minSdk 23）运行基线不变。依赖升级只针对标准版播放器，MPV 版继续使用项目原有的独立播放栈。

Android 标准版默认从 WebView HTML5 开始播放。只有 HTML5 明确不支持当前编码、报告媒体解码错误、播放调用失败，或在有界观察期内没有进展/首帧时，才切到 Media3；网络错误、自动播放策略拒绝和播放中断不会仅凭超时触发该回退。切换时保留已知播放位置。

Media3 回退先使用设备解码器。首帧出现前，如果 Media3 报告解码失败或选中的视频轨道超过设备能力，播放器最多重建一次并优先使用 NextLib FFmpeg 软件 renderer；软件尝试仍失败时回到 HTML5。每个播放源最多尝试一次 Media3，避免失败循环。只有 HTML5 已确认解码/格式失败且 Media3 真正输出首帧后，才记录有期限、按 WebView 版本隔离的本地 Media3 偏好；有效偏好可让同一安装后续优先尝试 Media3，Media3 失败时会清除偏好。

每次设置新的播放源都会重置该源的回退状态。一次源的 HTML5 兜底状态不会污染下一集或下一部剧。MPV、桌面和 webOS 路径不使用这套 renderer；MPV 的独立播放策略不变。

NextLib Media3 Extensions 及其 FFmpeg native libraries 按 GPL-3.0 声明。发布包含该依赖的 APK 前，发行流程必须提供对应版本的源代码、许可证文本和构建材料；这项分发检查与源码合并分开处理。

远端 CI 检查 Go/JavaScript/Android unit、debug build、lint、APK ABI 和播放器 flavor 隔离。参考项目已有 Media3 + FFmpeg 真实验证；本项目 CI 通过不等于已经在 Android 8/9 低端盒子、Android 9/13 设备或普通手机上完成实机播放验证。
