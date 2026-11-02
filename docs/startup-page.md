# 默认启动页面

对应 [下载仓库 issue #118](https://github.com/aston314/hongguo-tv-releases/issues/118)。

设置中的「启动页面」提供推荐、排行榜、新剧、历史、收藏五项，默认推荐。Android 标准版和 MPV 版、桌面版、webOS 共用这一入口及启动逻辑。选择后仅保存设置，下次打开应用时生效。

## 启动与恢复边界

- 冷启动直接进入所选页面，复用该页原有的数据加载、空态和交互；选择非推荐页面时不请求推荐列表、不先自动播放再跳页，也不产生观看记录写入。
- 返回前台保持原有页面和播放会话，不重新应用启动页设置。
- 电视桌面指定剧入口优先于启动页；账号初始化尚未完成时沿用原有等待流程。
- 未设置、无效值或页面入口不存在时回退到推荐。保存失败会提示，已选状态保持原值。
- 遥控焦点从侧栏显示设置向下进入已选启动项，左右逐项移动，上下连接相邻设置。版本更新仍排在最后。

## 持久化

Android 使用已有 `HongguoTVPreferences` 桥接，将 `startupPage` 独立保存在应用的 `playback` SharedPreferences 中，避免 Go 核心重启更换端口后丢失；仅接受五个合法值，保存后读取确认。

桌面版通过 Wails 的固定页面 origin、webOS 通过已安装应用 origin 的 localStorage 保存 `hongguo-tv-startup-page`，不依赖随机核心端口。普通浏览器预览则按浏览器 origin 保存。所有设置仅保存在本机，不同步到账号。

## 验证

`tests/startup-page.test.cjs` 覆盖五项持久化、无效及失败存储、Android 原生桥接跨 origin、非推荐直接启动、外部指定剧优先及等待账号、恢复前台不重新导航；`tests/sidebar-settings.test.cjs` 覆盖与相邻设置的双向焦点路径。

浏览器 fixture 使用真实共享 UI 和模拟 API，检查了非推荐四页不触发推荐/播放/记录写入请求，保存后重载、生效时机、前后台恢复，以及 960×540、1280×720、1920×1080 下的选项布局。Android 与 webOS 分支使用模拟桥接；这些检查不代表真机播放或真机持久化验收。

原生 Go/Android 构建、Android 单元测试与 lint、webOS 服务及打包目录验证使用 GitHub CI，不在本机编译。
