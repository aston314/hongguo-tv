# 红果短剧 Linux AppImage 测试版

本次 0.2.136 在连续收到空播放信息时提供有上限的匿名身份恢复，并补齐播放准备失败诊断。本机记录发送前按保存规则裁剪简介和标签，记录校验失败可显示具体原因。

延续 0.2.134 的按需 GPU 合成配置，减少兼容设备播放时的软件合成开销。如有白屏或显卡兼容问题，完全退出后通过 `HONGGUO_WEBKIT_GPU_POLICY=never ./hongguo-desktop-0.2.136-x86_64.AppImage --appimage-extract-and-run` 恢复原来的软件合成方式。也接受数值 `2`；未设置时使用 `on-demand`（`1`）。此项仅影响 Linux 窗口合成，不修改解码器或其他平台。

本次 Linux x86_64 AppImage 须通过 Ubuntu 24.04 与 Debian 12 容器中的真实红果数据和视频播放检查后才发布。测试使用 Xvfb、软件图形和软件解码，不能替代用户机器上的安装、硬件解码、显示器或扬声器验证。

AppImage 依赖系统提供 WebKitGTK 4.1、GTK 3、GStreamer 及 HEVC/AAC 解码插件。推荐在 Ubuntu 24.04 或 Debian 12 使用；其他发行版和桌面环境尚未验证。安装所需运行库：

```sh
sudo apt-get install libwebkit2gtk-4.1-0 gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-pulseaudio fonts-noto-cjk
```

下载 `hongguo-desktop-VERSION-x86_64.AppImage`，赋予执行权限后运行。没有 FUSE 时使用解包运行模式：

```sh
chmod +x hongguo-desktop-VERSION-x86_64.AppImage
./hongguo-desktop-VERSION-x86_64.AppImage --appimage-extract-and-run
```

Linux 当前不提供应用内更新。下载新版本后退出应用并替换 AppImage；账号和本地记录保存在用户数据目录。桌面版鼠标焦点高亮使用与 macOS、Windows 相同的共享 UI 实现，Linux 实体桌面仍待用户验证。
