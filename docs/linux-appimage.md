# Linux AppImage 测试版

`0.2.92-linux-test.1` 已在 [同一构建产物的 Ubuntu 24.04 与 Debian 12 测试](https://github.com/aston314/hongguo-tv/actions/runs/39282941741) 中使用真实红果数据播放 HEVC 视频并通过。测试使用 Xvfb、软件图形和软件解码，不代表实体显卡、扬声器或其他发行版均已验证。每次发布仍会用本次版本的 AppImage 重跑这两项检查，确保实际发布的文件通过验证。

## 包含内容和运行依赖

AppImage 包含桌面窗口、Go 核心及共享页面。它依赖系统的 WebKitGTK 4.1、GTK 3、GStreamer 和 HEVC/AAC 解码插件，不是免运行库的通用包。没有混入另一套 GTK/GLib/WebKit，也没有关闭 WebKit 沙箱。

Ubuntu 24.04 / Debian 12 的运行依赖：

```sh
sudo apt-get install libwebkit2gtk-4.1-0 gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-pulseaudio fonts-noto-cjk
```

赋予 AppImage 执行权限后运行。如果系统缺少 FUSE，可以使用运行时提供的解包运行模式：

```sh
chmod +x hongguo-desktop-*-x86_64.AppImage
./hongguo-desktop-版本号-x86_64.AppImage --appimage-extract-and-run
```

Linux 版不接入 macOS / Windows 的 ZIP 更新通道。下载新版本后退出应用并手动替换 AppImage；账号、记录和缓存保存在独立用户目录，无需移动数据。鼠标焦点高亮复用 macOS / Windows 的共享桌面 UI 实现，但 Linux 实体桌面交互仍待验证。

## GPU 合成与兼容回退

从 0.2.134 起，Linux 窗口显式使用 WebKit 按需 GPU 合成（`OnDemand`），避免 Wails 2.11 默认禁用合成加速造成播放时 CPU 占用偏高。此设置控制画面合成，不强制选择视频硬件解码器；实际表现仍取决于显卡、驱动和系统 GStreamer。

如启动后白屏、黑屏或出现显卡兼容问题，完全退出应用，再用原来的软件合成策略启动：

```sh
HONGGUO_WEBKIT_GPU_POLICY=never ./hongguo-desktop-0.2.134-x86_64.AppImage --appimage-extract-and-run
```

环境变量接受 `on-demand` / `1`（默认）、`never` / `2`（兼容回退）和 `always` / `0`（强制 GPU，可能有起播兼容问题，不建议优先使用）。未设置或值无效时使用按需合成。修改后须重新启动应用；此变量仅影响 Linux，不修改保存的播放或预取设置。

## 构建与验证

GitHub Actions 从统一 `vX.Y.Z` tag 在 Debian 12 内编译 AppImage，再由 Ubuntu 24.04 与 Debian 12 两个测试环境接收同一文件并校验 SHA256 和真实播放。只有两边均通过后才发布 Linux 测试版。

手动运行 Linux 工作流时，可关闭 `publish_public`，只构建并检查分支，不发布或更新下载渠道。

实际包具有明确启用的 `--linux-playback-self-test` 诊断模式，供 CI 验证使用。常规运行不载入诊断脚本或注册诊断桥。测试模式复用正式窗口配置、核心启动、Linux 媒体策略和关闭清理，使用临时访客目录，测试真实视频的画面、音频解码、进度、拖动和切集。首播检查要求不借助模拟播放按键；Linux 更新通道保持关闭。

CI 中的候选包 artifact 仅用于两个测试任务间传递，保留 1 天，不是公开下载渠道。验证成功后以 `linux-vX.Y.Z-test.1` 预发行版发布；Android、macOS、Windows 和 webOS 仍从同一源码 `vX.Y.Z` 发布。

容器验证使用 Xvfb 和软件解码，不能证明实体显卡、Wayland、扬声器、1080p 或其他发行版的表现。容器的 namespace 配置仅用于允许 WebKit 正常创建沙箱子进程，不是关闭 WebKit 沙箱。

### 固定打包工具

AppImage 打包使用官方 `appimagetool 1.9.1`，SHA256 为 `ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0`。下载来自版本化 Release，不再跟随会变化的 `continuous` 标签。

Type-2 runtime 保留原来的字节和校验值 `617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46`，改用官方 Release asset ID `657374641` 下载。两项均在执行前验证 SHA256；上游删除或替换时构建失败，不绕过检查。

0.2.133 的其他平台已从统一标签发布后，上游 continuous 工具漂移导致 Linux 构建被校验拦截。因此 Linux 从只补充上述打包修复的最新 main 手动重跑，应用代码与 `v0.2.133` 一致；实际 main 提交仍写入包元数据和核心版本，Ubuntu/Debian 继续验证同一个待发布文件。
