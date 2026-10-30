红果短剧桌面版 0.2.133（macOS / Windows）

- 新增手机红果 App 扫码登录，默认显示二维码；保留原手机号、短信及 MFA 登录方式，沿用原账号记录和云同步。
- 未保存下一集预取设置时，默认使用整集预下载；已有边播边下或整集预下载选择保留。
- 下一集已完整预下载且成功复用时，切集暂时隐藏中央圆圈和集数，并复用已就绪的下一集预览图；800 毫秒仍未出画时显示“正在准备播放…”。未完成预下载或复用失败时保留常规加载提示。
- 修复追更与更新提醒的焦点往返、整行外框高亮和标题随列表滚出的问题。

macOS 通用 ZIP 支持 Intel / Apple Silicon，最低 macOS 11；Windows x64 需要 Microsoft Edge WebView2 Runtime。Windows 播放 HEVC 还需要安装 HEVC Video Extensions；商店无法获取时，可参考 https://github.com/Ayx03/HEVCVideoExtension。Linux x86_64 AppImage 测试版在独立的 `linux-v0.2.133-test.1` 预发行版中提供，依赖系统 WebKitGTK 和 GStreamer。

通过设置检查更新并下载 ZIP，退出后手动替换完整程序。账号及本地记录保存在独立用户目录。
未做 Apple 公证或 Windows 代码签名。Windows 实体播放仍待实测。
