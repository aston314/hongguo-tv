# 红果短剧 webOS 实验版

这个目录是 LG webOS TV 的实验性 Web App 外壳。它复用 Android、桌面和浏览器预览使用的 Web UI，并通过 webOS JavaScript Service 提供本机 HTTP 边界。

当前源码已接入并验证的链路：

- `file://` 页面加载和相对资源路径；
- TV Web App 的应用元数据、图标和 Luna Service 注册；
- 本机 `127.0.0.1` 健康检查、状态诊断和结构化错误；
- 红果 `video_model` 请求、一次性设备身份和 Passport 签名（`X-Gorgon`、`X-Helios`、`X-Medusa`）；
- `main_url` 地址解析、`spade_a` CENC 密钥解码、MP4 AES-CTR 样本解密和 `hvc1/mp4a` 恢复；
- 本地媒体缓存和 `Range` 代理，页面继续使用同一套 HTML5 播放接口；
- 分类（含筛选器和连续分页）、推荐、排行榜、日历、搜索和剧集详情的真实数据接口；
- 搜索建议、演员作品、分季、榜单雷达、评论/弹幕/回复读取和本地播放记录；
- `ares-package` 生成 `.ipk` 的构建链。
- 随包提供 LG 官方 `webOSTV.js`，并使用兼容 webOS 5.x 的 Luna 调用格式。
- 与 Android TV / 桌面版同步的榜单雷达页面（官方榜分类与飙升榜数据）。

协议、解密和媒体文件已在 macOS 网络环境中用真实上游数据验证。优先使用 Range/CENC 按需读取；缺少强 ETag 等条件时仍安全回退到完整下载后解密，不会将失败的预取变为整集后台下载。磁盘缓存具有 512 MiB 总预算、2 小时闲置清理和播放占用保护，详见 [缓存策略](../docs/webos-media-cache.md)。

0.2.126 在 0.2.125 的唯一 HTML5 主视频元素和下一集 Service 预取基础上，继续使用匿名注册设备和新的多集片源接口；旧格式仍安全回退到受信任域名的备用片源。详见[下一集准备机制](../docs/episode-prefetch.md)。[下载 webOS 0.2.126 测试版](https://github.com/aston314/hongguo-tv-releases/releases/tag/webos-v0.2.126-test.25)；0.2.123 的 LG C5 回归反馈见 [Issue #70](https://github.com/aston314/hongguo-tv-releases/issues/70)。

2026-10-25，用户在 [Issue #57](https://github.com/aston314/hongguo-tv-releases/issues/57) 回报 LG OLED65C5PTA（台湾版，固件 43.21.77、webOS SDK 11.2.0）安装 `hongguo-webos-0.2.117-test.25.ipk` 后，安装、启动、1080P 视频画面、声音、账号登录及原生遥控器滚轮均正常。安装方式为 Developer Mode + webOS Dev Manager 1.99.20，网络为台湾 Wi-Fi。

另已在重新安装的 LG Simulator 中通过 HTTP 直连播放真实红果第 1、2 集、方向键切集及 seek，加载层退出、静音解除。缓存还有真实视频暂停期间容量清理和恢复播放验证；记录见 [Issue #55 修复与验证](../docs/webos-issue55-playback.md)。

webOS Service 已接入账号登录、国际手机号发码/MFA、预约、追更、通知、评论/弹幕/回复发布、点赞以及云端收藏/历史同步。登录已有上述真机回报；预约、追更等账号写入尚需逐项补充验收，未登录时按接口契约返回 `ACCOUNT_REQUIRED`。当前版本仍是测试版，其他电视型号欢迎继续反馈。

## 有声倍速（暂停）

有声倍速实验代码暂时保留，但从 webOS 播放控制和设置中隐藏，当前固定使用正常 1 倍速。待 LG 真机上的性能、听感和长时间同步验证完成后再恢复入口。详见[实现与验证说明](../docs/webos-audible-speed.md)。

## 版本检查（0.2.118 起支持）

设置内支持手动检查，启动后每天最多自动检查一次；发现新版会在非播放状态提示，并展示更新说明、发布页地址和 webOS Dev Manager 安装方法。内置代理失败后回退直连；不会自动下载或安装 IPK。详见 [版本检查机制](../docs/webos-update-check.md)。

## 构建

在仓库根目录执行：

```sh
bash scripts/verify_webos.sh
bash scripts/build_webos.sh --check-only
```

安装了 LG webOS CLI 后，去掉 `--check-only` 即可生成 `dist/*.ipk`：

```sh
bash scripts/build_webos.sh
```

也可以显式指定 CLI 目录：

```sh
ARES_DIR="$HOME/.local/webos" bash scripts/build_webos.sh
```

应用 ID 是 `com.aston314.hongguo.webos`，Service ID 是 `com.aston314.hongguo.webos.service`。安装和签名需要开发者模式、设备密钥和 LG 的 `ares-install`/`ares-launch` 工具；本仓库不保存这些密钥。

## 当前边界

签名、解密和媒体代理都在 Service 内执行，页面只消费本机 HTTP 地址；不要把签名逻辑放进页面 JavaScript，也不要复制带 GPL 许可限制的第三方 provider 实现。

发布前最低验收要求：

1. 在 macOS 上运行 `bash scripts/verify_webos.sh`，并使用真实上游完成公共接口验收；
2. 在 webOS Simulator 中验证服务唤醒、首页列表、搜索、详情和连续播放；
3. 已有 LG OLED65C5PTA 真机安装、启动、1080P 播放、声音、登录和遥控器滚轮验证；继续补充其他型号、Range/seek、焦点路径及账号写入结果；
4. 当前公开 IPK 保持测试版渠道，明确记录已验证功能及设备。
