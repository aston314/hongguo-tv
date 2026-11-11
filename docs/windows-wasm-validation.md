# Windows 可选 WASM 软解验证

实现分支：`codex/windows-wasm-decoder`，审查：[PR #40](https://github.com/aston314/hongguo-tv/pull/40)。这是独立测试版，尚未正式发布。

## 行为与范围

- Windows 设置 → 播放解码：默认播放 / CPU 软解（WASM）。默认播放保持原有 WebView2 HTML5 路径；选择保存后在下次播放或切集时生效。
- WASM 支持 MP4 中的 HEVC、H.264 视频和 AAC 音频；不支持 ByteVC2/VVC。视频由 FFmpeg CPU 解码、WebGL 绘制，音频由 Web Audio 播放；不调用系统 HEVC 扩展。
- 暂停、恢复、跳转、音量、静音、倍速、自然播完与换源已接入现有播放生命周期。倍速目前会改变音调。
- 新源/跳转终止旧 Worker，关闭旧 AudioContext 并释放 WebGL 资源；默认模式不创建这些资源。浏览器阻止 Web Audio 自动播放时，返回可再次点击播放的暂停状态，避免一直停在加载画面。
- Android、macOS、Linux、webOS 不安装此播放适配器。FFmpeg WASM 与 LGPL 源码/重链接材料仅进入 Windows 包。

## 可重复的构建

GitHub Actions 使用 Emscripten 4.0.19 编译官方 FFmpeg n8.0.1（`894da5ca7d742e4429ffb2af534fcda0103ef593`）。没有分发从其他应用提取的二进制。

本轮测试 decoder.wasm 的 SHA256：
`4111596ab72235cd927a9db6eab530d3be5d8b01127588e70cd6dcfbe6128b8e`。

私有草稿 `windows-wasm-test-42934571708` 保存同一份解码器及许可证/重链接材料。真实媒体片段只用于私有测试，不进入应用 ZIP 或公开下载仓库。

## 验证范围

- 834 项 JavaScript 测试、58 项 Python 测试通过。
- Go 核心完整竞态测试、桌面 Go 测试和 vet 通过。
- macOS Chrome 156：720P/1080P 合成 HEVC/AAC、同一集的真实 720×1280 与 1080×1920 HEVC/AAC 片段，均完成出画、暂停恢复、跳转、倍速、音量、自然结束、快速换源、资源释放和恢复默认 HTML5 的检查。约四秒连续采样窗口保持 30fps、没有渲染丢帧；这不代表整集或所有电脑的长期表现。
- 真实应用浏览器：推荐播放《装穷提亲，娶到全家嫌弃的她》，从第 2 集继续到第 3/4 集，验证手动/自动切集；切至 1080P 后保持原进度；再切《小镇是非多之同床异梦》《离婚后我收回一切，前妻悔疯了》。切回默认播放并换剧后，Worker 数为 0、AudioContext 已关闭，HTML5 继续播放。
- Windows Actions 用实际打包的 Wails/WebView2 运行同一适配器。报告分开记录 `ok`（功能）和 `performanceOK`（采样窗口是否实时），不能把功能通过解读为每台电脑都能实时播放 1080P。

初次 Windows 性能对照：[run 42936739148](https://github.com/aston314/hongguo-tv/actions/runs/42936739148)，代码 `2be35f5`。720P 合成/真实片段约 30fps；1080P 合成/真实片段能够完成所有功能检查，但该虚拟机中约 4 秒媒体推进需要约 6.4–6.5 秒实际时间，未达到实时目标。记录这一限制，不放宽采样指标，也不据此否定普通 Windows 电脑的性能。

最终应用代码 `68fe3d9` 的打包验证：[run 42937021657](https://github.com/aston314/hongguo-tv/actions/runs/42937021657)。该版本另补齐了自动播放受限后的恢复处理。

音频验证检查实际提交的非零 PCM 与运行中的音频时钟，没有验证实体扬声器的主观听感。CI 为无人操作的播放检查单独允许自动播放；生产版不添加这一浏览器参数。真实 Windows 电脑的长期 1080P 流畅度和主观声画同步仍需试用确认。
