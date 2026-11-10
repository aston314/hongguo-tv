# Android 应用推荐

侧栏入口为「应用」，仅 Android 壳拥有推荐应用安装桥时显示，位于打赏之后。桌面和 webOS 不显示入口。当前固定推荐豆逗 TV（`rocks.aston.doudoutv`）和球赛直播（`cc.kafeizhibo.tv`），均至少 Android 6.0 / API 23。

## 行为

- 页面为两张横向卡片，包含原图标、真实界面截图、简介、最低 Android 版本、正式版本与文件大小。上下选择应用，左键或返回回到侧栏；每张卡片一个操作焦点，异步状态不重建卡片，不抢焦点。
- 仅在用户打开本页时读取未安装应用的最新正式安装清单。APK 仅在用户选择「下载安装」后下载。已安装只显示「已安装」，不比较版本、不显示打开或更新按钮、不定时检查其他应用更新。
- 下载可取消，失败可重试；成功核验后，本页仍在前台才打开系统安装器，否则保留「继续安装」。安装器返回后读取目标包是否安装，取消安装不误报成功；Android 8+ 可显式进入未知来源授权再继续。
- 复用更新器的 `UpdateInstallPolicy`：先 `ACTION_VIEW`，再 `ACTION_INSTALL_PACKAGE`，最后 `PackageInstaller` 会话；不以 `canRequestPackageInstalls()` 提前拒绝前两个入口。安装未完成可通过同一按钮改用备用入口。会话的 `STATUS_PENDING_USER_ACTION` 拉起系统确认，确认 Intent 缺失/失败时保留 APK 的 URI 安装回退；来源授权页不可用时回退应用设置页。推荐应用使用独立结果接收器，不写入红果更新状态。
- 页面退出或隐藏停止 UI 轮询；原生任务在 Activity 销毁时断开连接并释放线程。无启动推广弹窗，也不接入播放流程。

## 下载与校验

使用 `UpdatePolicy.BUILTIN_PROXIES` 的四个内置代理获取安装清单和 APK；推荐应用不直连 GitHub。每条线路失败后重新完整下载并核验，不拼接失败文件。

推荐应用的策略、状态、缓存目录与 FileProvider 独立于红果自身更新器。只接受固定应用及正式仓库的版本固定 APK 路径，校验大小（不超过 100 MiB）、SHA256、实际包名、版本和固定正式签名证书。签名指纹来源为两个已发布 APK 的证书，不能从远程清单任意替换。未增加任意网址下载/安装桥，也不放宽红果更新器的任何校验。

缓存目录 `recommended-apps/` 每个应用最多一个完成包和一个临时包；全局只下载一个应用。失败/取消清理临时文件，安装成功清理完成包；超过 24 小时的完成包在下一次启动清理。未知来源和最终安装仍由系统确认，不静默安装，不卸载应用。

## 素材与发行来源

- 豆逗：`aston314/doudou-tv-releases/main/update.json`，初始核验版本 0.1.45。图标由原 Android VectorDrawable 转成 SVG；截图为本地运行豆逗实际页面截取。
- 球赛直播：`aston314/kafeizhibo-tv/releases/latest/download/update.json`，初始核验版本 0.1.19。图标由其原 VectorDrawable 转成 SVG；截图取该仓库 `artifacts/screenshots/1280x720/home.png`，缩小压缩为 JPEG。
- 两个 APK 证书 SHA256：`117dc57341c638a6f416ef256e0d9893bcdf7961acfc4c1b270b79bea8b6785f`。

JS 测试覆盖平台限制、页面轮询清理、允许的应用 ID、安装/不兼容/失败状态；JVM 测试覆盖正式路径、包身份、签名、大小和代理策略。GitHub CI 执行 Android 编译及 lint；浏览器模拟桥只验证布局/焦点/状态，不能代替实体设备的系统安装验收。
