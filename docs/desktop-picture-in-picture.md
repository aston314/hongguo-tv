# 桌面版悬浮小窗播放方案

本文记录桌面版悬浮小窗播放的实现方案。当前仅为设计记录，尚未实现，也不代表任何桌面平台已经支持系统级画中画。

## 目标

桌面版在播放视频时提供悬浮播放能力，用户可以继续使用其它应用，同时保持当前集、播放位置、音量、弹幕和播放历史状态。

实现必须继续复用当前唯一的 HTML5 video 元素。不得为了悬浮播放创建第二个视频播放器，否则容易造成重复请求、重复解码、双重声音和切集状态不同步。

## 两种模式

### 原生画中画

页面先按运行时能力检测是否支持原生 PiP：

    const supported =
      typeof video.requestPictureInPicture === 'function' ||
      (video.webkitSupportsPresentationMode &&
       video.webkitSupportsPresentationMode('picture-in-picture'));

标准 HTML 视频使用 requestPictureInPicture()、document.exitPictureInPicture() 和 enterpictureinpicture / leavepictureinpicture 事件。

macOS WKWebView 使用 WebKit Presentation Mode：

    video.webkitSetPresentationMode(
      video.webkitPresentationMode === 'picture-in-picture'
        ? 'inline'
        : 'picture-in-picture'
    );

按钮只在桌面版、视频已经加载并且运行时能力检测通过时显示。不能仅根据 macOS、Windows 或 Linux 平台名称显示按钮。

### 应用内悬浮小窗 fallback

如果系统 PiP 不可用，提供应用内小窗模式：

- 使用 Wails 的窗口大小、位置和置顶接口；
- 把当前窗口缩小到约 480x270，保持视频继续播放；
- 隐藏侧栏、详情和普通页面，只保留视频与必要的播放控制；
- 提供“恢复主窗口”操作；
- 退出小窗时恢复原来的窗口大小、位置、全屏状态和页面焦点。

该模式是缩小当前应用窗口，不是系统级 PiP。它不能让用户在同一个应用窗口中继续浏览其它页面，但在不支持原生 PiP 的 Linux 环境中仍能提供可用的悬浮播放体验。

## 页面状态

新增桌面播放器状态：

    inline -> entering-pip -> pip
    inline -> entering-mini -> mini
    pip -> leaving-pip -> inline
    mini -> restoring -> inline

状态至少记录：

- 当前集和当前媒体源；
- currentTime、暂停状态、静音状态和音量；
- 进入前的窗口大小、位置、全屏状态；
- 进入前的焦点目标；
- 当前是原生 PiP 还是应用内小窗；
- 当前播放代次，防止旧的 PiP 回调影响新集。

## 播放和页面生命周期

### 进入悬浮模式

1. 只允许从实际播放页进入。
2. 确认视频有有效媒体源，并且已经有元数据或首帧。
3. 保存当前播放状态和焦点。
4. 原生 PiP 调用失败时，回退到应用内小窗；回退失败则恢复原页面并提示用户。
5. 进入成功后不重新解析媒体、不重置 video.src，也不改变播放位置。

### PiP 期间切集

第一版建议手动切集时先退出原生 PiP，再执行现有切集流程。原因是当前切集逻辑包含过渡图、首帧等待和播放器状态交接，直接在 PiP 中替换媒体源会增加黑屏、旧画面残留和焦点恢复风险。

应用内小窗可以继续复用现有切集逻辑，但仍然必须保持唯一的 video 元素。

### 退出和恢复

- 用户点击 PiP 系统恢复按钮时，恢复主页面播放器和原焦点；
- 用户点击应用内小窗的恢复按钮时，恢复窗口状态和原页面布局；
- 应用退出、播放器失败、账号切换和离开播放页时，先退出 PiP/小窗，再执行现有清理逻辑；
- 任何过期或旧代次回调不得重新显示旧的播放界面。

## UI 设计

播放器控制区新增一个 PiP 图标按钮：

- 仅桌面版使用；
- 能力不支持时完全隐藏，不显示不可用的空按钮；
- 原生 PiP 时按钮文案为“进入悬浮播放”或“退出悬浮播放”；
- fallback 小窗时按钮文案为“缩小为悬浮窗口”或“恢复主窗口”；
- 鼠标、键盘和已有焦点路由使用同一按钮；
- 进入或退出后恢复原来的控制焦点，不抢占搜索、选集或其它页面焦点。

## 平台边界

| 平台 | 第一阶段策略 | 说明 |
| --- | --- | --- |
| macOS | 原生 PiP 优先 | WKWebView 支持 WebKit Presentation Mode，需实机确认 Wails 配置和媒体源行为 |
| Windows | 能力检测后使用原生 PiP | 依赖 WebView2 Runtime 版本，不能只按 Windows 版本判断 |
| Linux | 能力检测，失败时应用内小窗 | WebKitGTK 和窗口管理器差异较大，Linux 不默认宣称原生 PiP |
| Android 标准版 | 不修改 | 继续使用现有播放器控制 |
| Android MPV 版 | 不修改 | 不引入桌面窗口行为 |
| webOS | 不修改 | 不引入桌面 PiP 或窗口缩放 |

Wails v2 提供窗口大小、位置和置顶接口，可作为应用内小窗 fallback。Linux 的置顶效果仍取决于桌面窗口管理器。

## 不采用的第一版方案

第一版不创建第二个 Wails 窗口或第二个 WebView。这样会增加以下同步问题：

- 登录和账号状态同步；
- 媒体源、播放位置和历史同步；
- 弹幕、集数和切集状态同步；
- 多个播放器的解码和音频竞争；
- 主窗口与小窗之间的焦点、关闭和异常恢复。

只有在原生 PiP 和应用内小窗都无法满足需求时，才重新评估独立窗口方案。

## 实现阶段

1. 增加桌面 PiP 能力检测适配器和播放器按钮。
2. 实现 macOS WebKit Presentation Mode，并覆盖进入、退出和恢复。
3. 验证 Windows WebView2 的标准 PiP；不支持时显示应用内小窗 fallback。
4. 实现 Wails 窗口缩小、置顶、恢复和状态保存。
5. 验证 Linux WebKitGTK；按实际能力决定是否开放原生 PiP。
6. 补齐播放、切集、后台、失败和焦点回归测试。

## 验收清单

- 进入和退出原生 PiP；
- 进入和退出应用内小窗；
- 暂停、继续、定位和音量状态保持；
- PiP 退出后主播放器恢复到原集和原位置；
- 切集时没有重复音频、黑屏残留或旧集回调；
- 播放失败后能退出悬浮模式并显示重试；
- 应用退出、后台和前台恢复正常；
- 鼠标、键盘、PiP 系统按钮和应用内按钮焦点一致；
- 不支持 PiP 的平台不显示误导性的入口；
- 安卓、MPV、webOS 和标准播放器行为不发生变化。

## 参考

- [W3C Picture-in-Picture](https://www.w3.org/TR/picture-in-picture/)
- [Apple WebKit Picture in Picture](https://developer.apple.com/documentation/webkitjs/adding_picture_in_picture_to_your_safari_media_controls)
- [Wails Window API](https://wails.io/reference/window/)
