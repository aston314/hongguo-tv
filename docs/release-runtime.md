# 正式构建与核心身份（0.2.2）

## 统一发布线

`main` 是所有平台共同的源码线。功能确认且检查通过后，即使用户没有要求发布，也要先整合进 `main`。这样已确认但尚未发布的功能不会只留在某个工作树里。

只有用户明确要求 release 时才递增版本并创建 `vX.Y.Z` 标签，标签必须指向 `main` 历史中的提交。Android、macOS/Windows 和 webOS 都从这个标签构建。手动发布只能从 `main` 发起；功能分支可以运行 CI 或打包预览，但不能发布正式资产。工作树切换前检查已确认提交都已整合，未确认内容则留在原分支。详见 [development-and-release-flow.md](development-and-release-flow.md)。

## 正式签名

正式版包名 `rocks.aston.hongguotv`，名称“红果短剧 TV”，versionName 0.2.2、versionCode 4。后续正式发布需递增 versionCode，并持续使用现有 GitHub Secrets 中的同一把密钥。

Release APK workflow 用四项 ANDROID_KEYSTORE/KEY Secrets 恢复临时密钥，Gradle 明确配置 signingConfigs.release，运行 JVM 单元测试、assembleRelease、lintRelease 和 apksigner 验证。签名缺失或错误禁止交付；Runner 临时密钥最后删除。不在本机编译 APK。

调试版包名 `rocks.aston.hongguotv.debug`，名称改为“红果短剧 TV 调试版”。此前 Actions debug 密钥未固定，不能保证不同 debug 构建之间覆盖安装。正式版与这些调试包分别安装，无须卸载旧包；Android 私有数据不能跨包名自动继承，正式版首次需要重新登录，账号收藏和历史可重新同步。不要通过卸载旧应用来处理签名冲突或界面问题。

## 防止新版壳连接旧界面

用户已确认应用信息为 0.2.1-dev-debug，且已下载 APK 中六个界面文件与对应源码完全一致。因此不能仅依据截图推断“装错了 APK”。此前 Android 代码只检查固定 8797 端口上的 HTTP 200，不能证明响应来自当前 APK。这是已确认的连接缺陷；设备上具体哪个进程在响应，尚无 adb 证据。

0.2.2 的 Android 子进程使用 `-port 0 -instance-id <随机实例> -parent-pid <Android宿主PID>`。Go 完成绑定后在自身 stdout 输出 `HONGGUO_TV_READY <端口> <实例>`。壳只解析自己启动的子进程输出，随后核对 `/api/v1/status` 的服务名、实例和精确构建版本，核对通过才加载 WebView。壳和 Go 的版本均来自同一个 HONGGUO_CORE_VERSION（版本号+commit）。错误实例、旧版本和不完整响应不会进入页面。

Android 核心只由前台 Activity 启动，`CoreService` 使用 `START_NOT_STICKY`，不会在开机、应用更新或系统回收后自行重建。用户确认退出或移除应用任务时，Activity 停止该服务，服务再销毁 Go 核心。Go 仍检查实际父进程变化并退出，作为异常终止时的孤儿核心保护；它不会终止其它应用或此前未知的旧进程。桌面端在窗口关闭时主动停止核心，并继续使用 `parent-pid` 作为异常退出保护。Android MPV 是嵌入式 `libmpv`，没有需要 `--exit-with-parent` 的独立 mpv 进程。

账号、历史与收藏仍存 files/hongguo-tv，媒体仍存 cache/minireel。动态端口会改变浏览器 origin，APK 的倍速、清晰度、弹幕设置因此改存 Android SharedPreferences；桌面预览仍用 localStorage。版本显示在原生启动页，网页连接状态的 title 显示实际核心版本。

## 验证边界

Go 测试覆盖两个同时运行的核心、无关旧监听、READY 输出失败、错误参数、状态身份和父进程监视。JVM 测试覆盖错误实例、服务名、构建版本、端口及损坏 READY。Go/JS 和 GitHub Android 编译通过后，还需核对实际下载 APK 的签名、包名、版本、三 ABI 与六个嵌入 UI 文件。

以上不能代替用户 Android 6 设备上的实际运行验收，也不能证明已观察到设备上旧界面的具体进程来源。
