红果短剧桌面版 0.2.130（macOS / Windows）

- 同步统一主线版本。桌面版保留播放区鼠标操作，并支持在设置中选择下一集的边播边下或整集预下载；推荐自动播放支持全部剧、仅横屏剧和仅竖屏剧；共享播放取源继续使用匿名注册设备和新的多集片源接口。
- 修复系列剧连续播放：结束一季后按完整季列表选择下一季，待上线季保留预约状态，不跳过缺失或不可播放的季。

macOS 通用 ZIP 支持 Intel / Apple Silicon，最低 macOS 11；Windows x64 需要 Microsoft Edge WebView2 Runtime。Windows 播放 HEVC 还需要安装 HEVC Video Extensions；商店无法获取时，可参考 https://github.com/Ayx03/HEVCVideoExtension。Linux x86_64 AppImage 测试版在独立的 `linux-v0.2.130-test.1` 预发行版中提供，依赖系统 WebKitGTK 和 GStreamer。
通过设置检查更新并下载 ZIP，退出后手动替换完整程序。账号及本地记录保存在独立用户目录。
未做 Apple 公证或 Windows 代码签名。Windows 实体播放仍待实测。
