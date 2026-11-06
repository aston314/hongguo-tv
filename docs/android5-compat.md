# Android 5 兼容版

Android 5.0/5.1（API 21/22）设备使用独立兼容 APK：`hongguo-tv-android5-<版本号>.apk`。
它与同版本标准版共用主线 Go 内核、UI、播放地址获取和 HTML5 优先 / Media3 1.8.0 兜底策略，不包含 MPV 或额外 FFmpeg 视频软解。
标准版和 MPV 版的最低系统仍是 Android 6/API 23。

## 安装与升级

- 包名沿用 `rocks.aston.hongguotv.android5test`，显示名称改为“红果短剧 · Android 5 兼容版”，使用原正式签名。
- 已安装 `0.2.136-android5-test.1` 的用户，首次手动下载兼容 APK 并覆盖安装；旧测试包禁用了在线更新，无法自行发现新包。
- 同包名、同签名且递增的 `versionCode` 保留账号、历史和设置；无需卸载旧测试包。
- 首次覆盖后，设置中可手动检查更新，也会沿用每日检查、播放中不抢焦点的更新规则。
- 独立更新清单为公开下载仓库的 `update-android5.json`，`variant=android5`、`min_sdk=21`。标准版的 `update.json` 和 MPV 的 `update-mpv.json` 不互相覆盖。
- 下载继续校验包名、版本、大小、SHA256 和安装签名，交给系统安装器确认；Android 5 的“未知来源”开关遵循设备系统设置。

兼容版可与标准版、MPV 版共存，三者数据独立。原 ARM32 测试包与通用测试包使用相同包名和签名，均可升级到通用兼容包；特定厂商固件的 ABI/ART 安装缺陷仍可能影响安装。

## 构建与发布

- 仅在 GitHub Actions 构建 Android APK，不在开发者本机编译。
- `-Pandroid5Compat=true` 复用 standard 源集；使用独立 `android/app/build/android5/` 输出和 `src/android5/jniLibs/` 原生目录。
- Go 内核以 `ANDROID_API=21` 构建 ARM64、ARMv7、x86_64；常规两版仍使用 API 23 的独立输入和输出。
- 版本名与标准版相同，版本号沿用标准版递增数值，不创建长期分叉的旧版代码。
- 发布工作流生成第三个 APK 和独立清单，校验后使用相同字节同步公开 Release；补发工作流同时支持新三渠道和历史一/两渠道。
- API 21 Actions 检查 APK 的 v1 签名、DEX 035、ABI/内核版本和包隔离，运行单元测试与 lint，再在模拟器检查旧测试包覆盖安装、Go 启动、WebView/更新桥初始化、停止后重开。
- 普通 CI 不发布 APK；真实签名包仅由正式发布流程分发。

## 支持边界

提供随主线更新的兼容构建，不承诺逐一适配 Android 5 的厂商固件、WebView、证书或解码器。
模拟器启动与更新桥检查不等同于真实电视播放或实际在线下载覆盖安装验收。
旧设备播放失败仍需区分取地址、媒体网络、WebView 解码和系统 Media3 解码，不能只凭 Android 版本下结论。
