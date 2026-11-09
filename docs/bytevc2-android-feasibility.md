# ByteVC2 Android 独立解码实验（2026-11-09）

## 结果

参考仓库的 BVC2 补丁可以在 Android arm64 上构建，并对本轮真实 ByteVC2 样本
完成整集软件解码。后续独立 MPV APK 也已在 Shield 上实际出画面，720P 通过
基本交互检查，但 1080P 存在掉帧和音画偏差；目前不满足正式接入条件。

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

## 第二阶段：独立 MPV APK 实测

- 应用源码提交：`82cbaa2e3eb63efaa01a70561f7787e010d6c8db`。
- [GitHub 原生库、APK、测试及 Lint 构建成功](https://github.com/aston314/hongguo-tv/actions/runs/42604429691)。
- MPV 0.41.0 + FFmpeg 8.1.3 + BVC2 补丁；新增 MOV `bv2C` 识别，自动选择 BVC2 解码器。
- 包名：`rocks.aston.hongguotv.mpv.bytevc2test.debug`，仅 arm64/API23+，与正式版并存。
- APK 15,632,871 字节，SHA256：`28a249d8a925f327839b567864e9860e1fa58351063f4448bb99f5cc30dbd66c`。
- APK、完整对应应用/原生源码及生成补丁存入未发布草稿 `bytevc2-preview-42604429691`。
  新工作流提交的草稿创建曾被 Actions token 拒绝；维护者先创建同名实验 tag 后成功，未扩大 token 权限。

所有 Android/原生编译均在 GitHub；本机只下载、校验、安装及通过 ADB/CDP 测试。
生产应用文件仍未提交变更：`prepare_preview.py` 只在 CI 临时工作树应用精确补丁。
标准版、正式 MPV 库、主线与稳定更新通道未修改。

### 已测行为与实际结果

| 项目 | 结果 |
| --- | --- |
| 真实竖屏 720×1280、横屏 1280×720 | 截屏核对画面可见；实际解码器 `byteVC2`、`hwdec=no`、`vo=gpu` |
| 音频路径 | AAC → AudioTrack，48kHz/双声道、未静音；采集音画时钟，未人工听音 |
| 720P seek、暂停/恢复 | 20 秒位置 seek 后继续推进；暂停期间位置不变，恢复后继续播放 |
| 720P 手动上下集 | 遥控器第一集切第二集，返回第一集后仍正常出画面 |
| 快速来回切集 | 第二集→第一集→第二集→第一集，最终请求正确播放，未观察到闪退 |
| 自动下一集 | 实际 seek 至片尾后收到 `ended`，随后第二集 `playing`，没有伪造结束事件 |
| 后台/返回 | 后台暂停且 Surface 脱离；返回并播放后 Surface 恢复、时钟继续 |
| 正常退出 | 点击原生“退出”，回到桌面，本地 CoreService 与子进程停止；Android 缓存 UI 进程仍可存在 |
| HEVC 1080P 硬解对照 | `mediacodec-copy`，10 秒观测窗口内渲染掉帧为 0，音画时钟偏差约几十微秒 |
| HEVC 软件解码对照 | 实际选中 HEVC，1080×1920、`hwdec=no`，采样点掉帧为 0；本轮未取得自然选中的 AVC 源 |
| ByteVC2-only 第三集 | 返回 `VIDEO_MODEL_NO_QUALITY`；兼容模式第三集可播放 HEVC，不能让测试模式替代生产选源 |

### 尚未通过：1080P ByteVC2 性能

真实取源返回的 1920×1080/30fps 样本虽能出画面，但渲染掉帧持续增加，
音画时钟偏差一度约 17 秒，不能视为播放正常。原来命令行验证过的
1920×1080/24fps 解密文件，通过受限本地 HTTP/ADB reverse 再送入同一 APK，
约 15 秒观测到 86 个渲染丢帧，短时偏差约 162ms，也未达到稳定零掉帧。

两份码流不同，不能用先前 null 输出的 2.67× 解码速度推导新 30fps 样本的
应用内流畅度；现在只确定完整音视频/显示路径存在性能限制，尚未定位到单一原因。
测试未修改线程数、Surface 尺寸或生产回退逻辑。真实媒体、截图、URL、密钥和账号
均只保留本地；结构化证据为 `scripts/bytevc2/evidence/2026-11-09-shield-mpv-preview.json`。

### 当前结论

Android arm64 的原生解码和独立 MPV 集成已证明可行，720P 的基本观看操作通过；
1080P 性能仍是正式接入阻碍，旧盒子/ARMv7 未验证。现有兼容源仍应优先，
ByteVC2 将来只能作为额外能力评估，不能全局放开过滤或强制改选。
桌面版尚未接入或测试，不能因为参考项目桌面实现存在就宣布我们的桌面版已支持。
