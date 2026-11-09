# 独立 Android ByteVC2 验证

此目录只用于可行性实验，不接入应用，不修改三路取址、ByteVC2 安全过滤、
正式 libmpv 依赖、版本号或更新通道。构建只在 GitHub Actions 运行。

`bytevc2-experiment.yml` 产出 Android arm64 / API 23 的独立 FFmpeg / FFprobe，
包含固定源码、补丁、构建参数及校验值。原生实验工具 artifact 保留一天；
不上传真实视频、解密密钥、匿名设备身份或签名 URL。

参考补丁来自 `zfdang/hongguo-open-player` 提交
`36316dcbe35aa05cfa0176036e56edba17188567`，原始来源为
`wxyzh/ffmpeg-bvc2` 的 `04f87d26d67162c0f73c3d9bd1870fd5900f3aee`。
FFmpeg 固定为 `jellyfin/jellyfin-ffmpeg`
`f6e945886e17c2cf882143bd98222b1bd66ffe28`（8.1.3）。实验使用 GPLv3 构建，
不把它链接到正式版 LGPL libmpv；正式集成的源码授权和依赖方案需另行评估。

与桌面参考不同，本实验只解码、不做 H.264 重编码，保留 ARM 汇编优化。
先用真实 ByteVC2 样本在实机运行，核对实际解码帧、首帧、逐帧校验、拖动后解码、
解码耗时及峰值内存。仅构建成功或 `-decoders` 出现 bvc2 均不能证明可播放。
解码到 null 的速度不包含音频同步、GPU 渲染及 WebView 合成开销。

样本使用既有取址/下载/解密协议在本机临时目录获取，实验采样通过 Go overlay
放开过滤；工作树中的生产过滤保持不动。对 `hvc1 + bv2C` 的样本分别尝试自动识别
和显式选择 bvc2 解码器，保留实际失败结果，不把 HEVC 误认当成 ByteVC2 通过。

```sh
# Only the capture test compiles locally; no Android/native library build.
python3 scripts/bytevc2/capture.py --video-id 7702841953875938328 --out /tmp/bytevc2-samples
# Download the successful GitHub workflow's native artifact first.
python3 scripts/bytevc2/check_device.py --artifact /tmp/bytevc2-arm64 \
  --serial DEVICE_SERIAL --samples /tmp/bytevc2-samples/720P.mp4 \
  /tmp/bytevc2-samples/1080P.mp4 --out /tmp/bytevc2-report
```
