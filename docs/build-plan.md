# GitHub Actions 构建方案

日期：2026-10-06。本项目在 GitHub Actions 编译 APK，参考 [vidsrc-local-proxy](https://github.com/aston314/vidsrc-local-proxy) 的 Android 壳与 Go 构建流程。

## 已核对的参考流程

本项目当前的 Android 构建配置：

| 项目 | 当前配置 |
| --- | --- |
| Runner | `ubuntu-latest` |
| Go | `1.25.x` |
| Java | Temurin 17 |
| Android compile SDK | 36 |
| Android target SDK | 35 |
| Android 最低版本 | API 23 |
| Build Tools | 35.0.0 |
| NDK | 27.2.12479018 |
| Gradle | 8.13 |
| Android Gradle Plugin | 8.13.2 |
| ABI | arm64-v8a、armeabi-v7a、x86_64 |

Media3 1.11.1 的 AAR 要求 compileSdk 36，因此升级 AGP/Gradle 并提高 compileSdk；targetSdk 35 和 minSdk 23 保持不变。TV 项目把播放能力编进 Go 核心，不依赖 8787 或 57828 进程；CI 仍分别验证三个 ABI 的构建产物和 Android TV 播放运行态。

## 构建链路

```text
源码推送 / Pull Request / 手动触发
    → 安装 Go、Java、Android SDK、NDK、Gradle
    → Go 检查和行为测试
    → 交叉编译三个 Android ABI
    → Gradle 构建 APK
    → 上传 GitHub Actions Artifact

版本标签
    → 构建 release
    → 使用新项目的签名配置
    → 上传私有 GitHub Release
```

Android 壳启动 Go 二进制的参考做法：Go 按 `GOOS=android` 编译 PIE 可执行文件，打包进 `jniLibs/<abi>/`，使用 `.so` 文件名携带，由壳通过进程启动。这不同于 JNI 共享库，具体进程、权限、缓存路径和退出逻辑需在新项目实现。

新应用使用独立的 applicationId、本地通信端口和签名配置，方便与 8787 APK 同时安装。TV 播放仍由本 APK 内的 Go 服务处理。Android 使用动态本机端口承载自身 UI、API 和媒体路由，8797 仅作为桌面预览默认值。

## 签名与下载

现有 release 流程参考的 Secrets 为：

```text
ANDROID_KEYSTORE_BASE64
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
```

正式版 Gradle signingConfigs 已接入上述四项 GitHub Secrets；缺少任一项时中止正式构建，产物上传前通过 apksigner 验证。项目签名材料不写入代码。私有仓库的 Artifact 和 Release 下载需要有仓库访问权限，不能假定 APK 可以匿名访问私有 Release 实现自动更新。

## 当前状态

Android 工程、Go 入口、分类/详情/播放 API、MiniReel CENC 播放服务和 workflow 已经就绪。Go 核心的本地验证包括真实分类响应、详情集数、内置播放解析、MP4 清晰化以及 `HEAD`/`Range` 媒体请求；GitHub Actions 仍需验证最新提交的三个 ABI APK 构建和 Android TV 真机操作。
