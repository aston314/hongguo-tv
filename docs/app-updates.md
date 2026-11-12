# 应用内更新

源码保持在私有仓库 `aston314/hongguo-tv`。公开仓库 `aston314/hongguo-tv-releases` 只保存 README、最新 update.json 和正式 Release 文件。任何人可以下载正式 APK。

Android 6/API 23 起支持。首次安装带更新功能的版本（0.2.7 或更高）需要手动覆盖升级，此后可从“设置 → 版本更新”检查并下载安装新版本。系统安装界面仍需要用户确认。正式版包名和签名保持不变，升级保留账号与记录；调试版不覆盖安装正式版。

## 检查与操作

- 每次启动，若距离上次自动检查不足 24 小时则复用缓存。失败也计入自动检查次数，手动检查始终可用。播放页和其他弹窗期间不弹更新提示；待回到普通页面再提示。对同一版本选择“稍后”后不再自动重复提示，手动检查仍可查看。
- 原生壳负责网络和安装；UI 只调用受本机页面限制的桥接接口。更新器固定依次尝试 `https://gh-proxy.com/`、`https://v4.gh-proxy.org/`、`https://gh-proxy.org/`、`https://ghfast.top/`，全部失败后再尝试 GitHub 直连；用户不需要也不能配置代理。检查入口固定为公开仓库 main/update.json，带检查时间参数并请求禁缓存；APK 固定版本路径，不能用可变的 latest APK 路径。
- JSON 包含 schema、package_name、version_code、version_name、min_sdk、size、sha256、download_url、release_notes、published_at。按整数 versionCode 判断升级；下载地址仅允许公开发行仓库的对应版本 APK。
- 下载必须在用户确认后进行。最多 100 MiB，通过 size、SHA256、实际 APK 包名/版本及当前安装应用的完整签名集合核验；降级、外来包、截断或代理 HTML 被拒绝。
- 安装交接首先用带只读授权与 `ClipData` 的 APK `content://` URI 尝试 `ACTION_VIEW`，启动失败再尝试 `ACTION_INSTALL_PACKAGE`。不会用 `canRequestPackageInstalls()` 的单次返回值提前拦截这两个系统安装器入口，兼容错误报告无授权但能正常拉起安装器的设备。两个入口均无法启动时，Android 8+ 才引导用户打开逐应用未知来源授权；获得授权后可继续重试或使用 `PackageInstaller` 安装会话。Android 6 使用系统安装器；若系统阻止安装，仍需按系统提示处理未知来源设置。
- 若系统安装器已打开但用户返回时更新尚未完成，保留已验证 APK，并提供另一安装入口或授权设置供用户选择；不自动反复弹安装器。PackageInstaller 会话状态由显式、非导出的 receiver 接收；`STATUS_PENDING_USER_ACTION` 必须启动系统返回的确认 Intent。安装结果以已安装 `versionCode` 和会话结果为准，不把 `startActivity()` 成功当作安装成功。
- 安装未完成弹窗还提供“保存安装包”：复用已下载且验证过的 APK，在后台复制到公共 `Download/` 目录，复制时再次核验大小与 SHA256。Android 5～9 使用公共下载目录，Android 6～9 仅在用户选择保存时申请存储权限；Android 10+ 使用 `MediaStore.Downloads`，无需存储权限。已存在的文件不覆盖；复制失败、取消时清理导出半成品，私有缓存原包仍保留。保存成功显示实际文件名和位置，由用户在电视文件管理器中自行安装；不自动打开文件管理器或安装器，也不承诺系统允许安装。
- `INSTALL_FAILED_USER_RESTRICTED` 表示系统限制了本次安装，即使旧系统把它映射成 `STATUS_FAILURE_INCOMPATIBLE`，也不显示为“安装包与设备不兼容”；保留系统原始错误供排查。
- app-updates 缓存最多保存一个完整 APK 和一个当前半成品，下载前替换旧包，失败/取消清理半成品。升级后启动删除已安装版本的完整包，未安装文件最迟在超过 24 小时后的下一次启动清理。与视频缓存、账号文件分离；缓存不足失败可重试，不清账号数据。
- 断网、错误 HTML、大小不符、校验值不符和签名不符均不会交给系统安装；每条更新线路失败后切换下一条并重新完整下载，不复用坏的前缀文件。取消安装或拒绝安装权限时保留验证过的包供重试，绝不把下载成功当作升级成功。更新器不卸载应用、不写账号或剧库，不自动静默降级；安装后的新版本若启动失败，保留原生启动错误与重试入口。
- 更新源返回比当前已安装版本更旧的 versionCode，或相同 code 却不同版本名时，按陈旧/不一致元数据处理并尝试备用源；两个来源都无有效信息时显示检查失败，不误报“已是最新版本”。

## 发布

私有仓库 Actions Secret `HONGGUO_RELEASES_TOKEN` 需为专用 Fine-grained PAT：仅公开发行仓库、Contents Read and write。配置并确认凭证后，将 Actions Variable `HONGGUO_PUBLIC_RELEASES_ENABLED` 设为 `true` 启用自动发布。默认关闭，未配置时正式编译和私有 Release 正常完成；可用本机已登录的 gh 调用公开上传脚本完成本次发行。不能使用私有仓库自带 GITHUB_TOKEN 写另一个仓库，也不将本机 gh 的广泛权限登录凭证复制到 Actions 或 APK。Token 过期后需在 Secrets 更新。

Release workflow 从 build.gradle 读取版本，生成 APK/SHA256SUMS/update.json，先发布私有签名 Release，再将验证过的 APK、更新清单和校验和同步到公开仓库。MPV 对应的 LGPL 库源码 ZIP 只保留在私有 Release，不进入公开下载仓库。公开发布任务串行，同版本不替换不同 APK，旧版本不能覆盖较新的 update.json。上传脚本只允许明确的发行文件，不上传工程源码或打包整个目录。

创建草稿后沿用接口返回的 Release ID，不依赖尚未生效的标签查询。中断后重试保留已有且校验一致的附件，只补齐缺失文件；所有附件校验完成并正式发布后才更新稳定 JSON。已发布附件不覆盖，重复执行且内容一致时不产生多余提交。

凭证迟到、短暂断网或公开上传失败时，可以手动运行 `Publish signed download` 并指定已完成的版本标签。它下载原有正式 Release 的签名文件并核验 SHA256 后，只重试公开发布，不重新编译或更换同版本的安装包。

测试区分 Go/JS/JVM/Android Lint/签名和包内容验证，与真实 Android 6 安装来源、遥控器、代理网络及跨版本覆盖安装验收；浏览器模拟不能替代后者。
