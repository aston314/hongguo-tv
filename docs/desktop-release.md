红果短剧桌面版 0.2.140（macOS / Windows）

本版与统一主线同步，桌面更新版本码为 77。

- 播放控件仅在内容变化时刷新；隐藏期间跳过视觉更新，重新显示时同步当前状态，减少弹幕播放时的重复 DOM 写入。
- 弹幕运动、进度保存、预下载、切集和 HTML5 播放路径不变；保留启动页面设置、搜索建议及侧栏焦点改进。
- 修正发布流程读取附注标签时的冲突，确保从统一版本对应提交构建。

- 竖屏播放可在设置中选择动态模糊背景延伸；默认仍为黑色，不改变视频画面和播放器行为。
- 空播放响应的匿名身份恢复保持有上限；不会切换登录账号，也不会对普通网络或解码错误触发恢复。
- Android 标准版恢复 136 播放逻辑的改动不影响桌面版 HTML5 播放。

macOS 通用 ZIP 支持 Intel / Apple Silicon，最低 macOS 11；Windows x64 需要 Microsoft Edge WebView2 Runtime。Windows 播放 HEVC 还需要安装 HEVC Video Extensions；商店无法获取时，可参考 https://github.com/Ayx03/HEVCVideoExtension。Linux x86_64 AppImage 测试版在独立的 `linux-v0.2.140-test.1` 预发行版中提供，依赖系统 WebKitGTK 和 GStreamer。

通过设置检查更新并下载 ZIP，退出后手动替换完整程序。账号及本地记录保存在独立用户目录。
未做 Apple 公证或 Windows 代码签名。Windows 实体播放仍待实测。
