# 应用图标

采用用户提供的 `files (4).zip` 中的“果实＋播放键”设计，品牌色为 `#DB411E`。保留方形和圆形矢量源文件，去除不参与绘制的导出元数据。

- Android 默认入口使用方形 `ic_launcher.xml`；系统桌面请求 `roundIcon` 时使用圆形 `ic_launcher_round.xml`。标准版、MPV 版、Android 5 兼容版共用资源。
- Android 和桌面启动页使用圆形标识，保留独立旋转的外圈和现有启动状态，加载圆弧使用品牌色 `#DB411E`。应用内侧栏使用方形标识。
- `hongguo-tv-banner.svg` 将原横幅重新排为 320×180。标题“红果短剧”已用黑体轮廓固定成路径，打包和显示时不依赖字体。
- Windows 和 Linux 使用 1024×1024 方形 PNG；macOS 使用独立的 `appicon-macos.png`，沿用原来的 85px 四边安全留白。
- webOS 使用独立的 80×80 `icon.png` 和 130×130 `largeIcon.png`，不继承 macOS 留白。

PNG 已提交，正式构建不增加绘图依赖。修改 SVG 后，可在安装了开发工具 `sharp` 的 Node 环境执行：

```sh
node scripts/render_brand_icons.mjs
```

若 `sharp` 位于独立工具目录，可用 `HONGGUO_SHARP_MODULE` 指定其绝对模块路径。Android VectorDrawable、共享页的 `icon-brand` 和桌面启动页内嵌矢量同步使用这些源文件的形状；不额外发起图标网络请求。
