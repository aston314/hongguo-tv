红果短剧桌面版 0.2.135（macOS / Windows）

- 同步共享界面的旧浏览器请求参数兼容修复，按实际能力处理对象参数编码。
- 保留现有 HTML5 播放、切集预览图、扫码与手机号登录及下一集预取设置。
- 公开下载仓库新增播放问题、其他问题和功能建议表单，README 提供反馈入口。

macOS 通用 ZIP 支持 Intel / Apple Silicon，最低 macOS 11；Windows x64 需要 Microsoft Edge WebView2 Runtime。Windows 播放 HEVC 还需要安装 HEVC Video Extensions；商店无法获取时，可参考 https://github.com/Ayx03/HEVCVideoExtension。Linux x86_64 AppImage 测试版在独立的 `linux-v0.2.135-test.1` 预发行版中提供，依赖系统 WebKitGTK 和 GStreamer。

通过设置检查更新并下载 ZIP，退出后手动替换完整程序。账号及本地记录保存在独立用户目录。
未做 Apple 公证或 Windows 代码签名。Windows 实体播放仍待实测。
