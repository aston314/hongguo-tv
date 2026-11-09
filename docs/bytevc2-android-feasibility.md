# ByteVC2 Android 独立解码实验（2026-11-09）

## 结果

参考仓库的 BVC2 补丁可以在 Android arm64 上构建，并对本轮真实 ByteVC2 样本
完成整集软件解码。它证明了原生解码的可行性，尚未证明正式 MPV 应用集成可用。

- 实验分支：`codex/bytevc2-android-validation`，不合并主线。
- GitHub 构建提交：`b8e59408f9b821a1da12017e94efa353b3ac77c5`。
- [成功的 GitHub Actions 构建](https://github.com/aston314/hongguo-tv/actions/runs/42595944819)。
- 实机：NVIDIA Shield TV / darcy，Android 11，arm64-v8a。
- FFmpeg 8.1.3 + 参考仓库 BVC2 补丁；NDK 27.2.12479018 / API23。
- 独立命令行解码器通过 ADB 运行，没有安装/覆盖 APK。

## 真实样本与实测

用项目现有签名、匿名注册、旧 `multi_video_model` 接口和 Go 媒体解密获取
同一集的两个清晰度。临时 Go overlay 只在实验采样进程中选择 ByteVC2；
工作树中的生产过滤保持原样。上游明确报告 `bytevc2`，解密文件包含 `bv2C`，
媒体 sample entry 为 `hvc1`。

| 样本 | 实际尺寸 | 视频时长 / 帧数 | 整集解码耗时 | 解码速度 | 进程峰值 RSS |
| --- | --- | --- | --- | --- | --- |
| 720P | 1280×720 | 61.875 秒 / 1485 帧 | 10.396 秒 | 5.952× | 175.6 MiB |
| 1080P | 1920×1080 | 61.875 秒 / 1485 帧 | 23.173 秒 | 2.670× | 326.0 MiB |

两份样本均为 24fps，显式 `-c:v bvc2`，自动线程，输出到 null：

```sh
timeout 90 ./ffmpeg -hide_banner -nostdin -loglevel info -xerror -benchmark \
  -threads 0 -c:v bvc2 -i sample.mp4 -map 0:v:0 -an -sn -dn \
  -nostats -progress pipe:1 -f null -
```

两档从头解码 10 秒、从 15 秒位置 seek 后解码 10 秒，均得到 240 帧并退出成功。
分别提取 30 帧 framemd5，每份均有 30 个不同帧校验值；首帧导出为 PPM 并转 PNG
人工查看，画面可见，没有本轮可见的绿屏或花屏。没有用“播放时间推进”替代画面核验。

机器可读数据位于 `scripts/bytevc2/evidence/2026-11-09-shield.json`。
原始本地证据在 `/tmp/hongguo-bvc2-validation/device-report/`；
真实视频、画面、源 URL、身份、密钥未提交或上传到 GitHub。

## 关键发现与限制

1. **自动识别失败，显式 ByteVC2 解码成功。** 相同新解码库自动把 `hvc1` 当 HEVC，
   从头或 seek 后均为零帧，报 NAL 解析错误。不能仅增加解码器就放开生产过滤。
   接入需识别可信的 codec / 容器信息，并把正确类型送入新解码器，防止误送旧 HEVC 路径。
2. **这不是 MPV APK 验证。** 现有正式 libmpv 的 FFmpeg 基线为 6.0；本实验为独立
   FFmpeg 8.1.3。MPV 兼容性、JNI、Surface、音频同步、切集与取消均未修改或验收。
3. **速度是纯解码吞吐。** 未包含 GPU 显示、音频播放、WebView 合成与整集下载等待。
   不能据此承诺旧盒子/ARMv7 流畅播放；1080P 解码进程本身峰值约 326 MiB，需注意资源成本。
4. **一次真实样本的可行性通过。** 尚未覆盖竖屏、多剧、更多码流特性、长时间循环或旧 Android。
   ByteVC2 可解码不等于普通 HEVC 的 MediaCodec 驱动绿屏得到修复。
5. 构建和对应源码留在独立实验产物；正式标准版/MPV 依赖、三路顺序与成功记忆、
   全局 ByteVC2 过滤、版本号和更新通道均保持原样。

若继续集成，应先在独立 MPV 测试包验证新 FFmpeg/MPV 组合与显式编码识别，
再验收真实画面、声音、seek、切集和进程退出；不能直接把本实验二进制替换为现有 libmpv。
