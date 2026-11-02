红果短剧桌面版 0.2.141（macOS / Windows）

本版与统一主线同步，桌面更新版本码为 78。

- 下一集完整预下载命中时，切集 800 毫秒后显示目标集数，3 秒后再显示圆圈；实际画面更早就绪时直接完成交接。
- 保留 0.2.140 的播放控件刷新优化；弹幕运动、播放进度保存、预下载和 HTML5 播放行为不变。
- 账号取源增加签名请求与有界兼容回退；不会因媒体下载或解码错误重复刷新播放身份。

- 竖屏播放可在设置中选择动态模糊背景延伸；默认仍为黑色，不改变视频画面和播放器行为。
- 空播放响应的匿名身份恢复保持有上限；不会切换登录账号，也不会对普通网络或解码错误触发恢复。
- Android 标准版恢复 136 播放逻辑的改动不影响桌面版 HTML5 播放。

macOS 通用 ZIP 支持 Intel / Apple Silicon，最低 macOS 11；Windows x64 需要 Microsoft Edge WebView2 Runtime。Windows 播放 HEVC 还需要安装 HEVC Video Extensions；商店无法获取时，可参考 https://github.com/Ayx03/HEVCVideoExtension。Linux x86_64 AppImage 测试版在独立的 `linux-v0.2.141-test.1` 预发行版中提供，依赖系统 WebKitGTK 和 GStreamer。

通过设置检查更新并下载 ZIP，退出后手动替换完整程序。账号及本地记录保存在独立用户目录。
未做 Apple 公证或 Windows 代码签名。Windows 实体播放仍待实测。
