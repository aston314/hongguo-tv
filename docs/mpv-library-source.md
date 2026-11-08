# MPV 库源码、构建与替换

此附件对应 media-kit/libmpv-android-video-build v1.1.11 的 **default** 库。
`scripts/mpv_sources.json` 固定各依赖的提交和 SHA256，`BINARY-PINS.json` 固定
发行库的下载地址及 SHA256。不是 full/encoders-gpl 构建，不包含其辅助库。
mpv 使用 `-Dgpl=false`，FFmpeg 使用 `--disable-gpl --disable-nonfree
--enable-version3`；FFmpeg 及与它组合的库适用 LGPLv3 要求。完整版权和许可在
`NOTICE.txt`、各源码归档内，应用“设置 → 开源许可”也可离线查看。
FreeType 选择 FTL 许可，完整声明在 NOTICE。其他依赖保留各自原始许可。

附件自动包含库的对应源码、上游补丁/构建脚本、独立 MIT JNI 桥和库替换工具。
不包含红果账号协议、业务核心、应用源码或签名私钥。源码提供不代表承诺答疑，
但许可授予的研究、修改、为调试修改后的库进行必要逆向工程的权利不受限制。

## 重建 libmpv

在 Linux 使用 Python 3.12+、Git、CMake、Meson、Ninja、NASM、pkg-config、
Autoconf/Automake、Libtool、Make 和 Android NDK **25.2.9519653**。
先解压附件，运行（out 必须为新目录）：

```sh
python3 scripts/rebuild_mpv_libraries.py --kit . --out /tmp/mpv-library-build
```

该命令只解包所附归档、应用上游 patches/ffmpeg 和 patches/mpv 补丁、选择
default FFmpeg 配置，不执行上游 download-deps.sh（它包含不需要的 GPL 依赖）。
按上游 `buildscripts/include/path.sh`，将已安装 NDK 目录链接到
`/tmp/mpv-library-build/buildscripts/sdk/android-sdk-linux/ndk/25.2.9519653`。
在 buildscripts 中运行：

```sh
bash build.sh --arch armv7l
bash build.sh --arch arm64
bash build.sh --arch x86_64
```

API 基线为上游的 21，应用最低 23。结果在
`prefix/{armeabi-v7a,arm64-v8a,x86_64}/lib/libmpv.so`。支持修改这些源码后重新构建；
版本标识或时间戳差异可能使结果不逐字节相同。保留已导出的 libmpv API 及
`mpv_lavc_set_java_vm`，保持 ABI 一致。上游构建脚本会 sudo chmod 构建脚本，
需在你控制的 Linux 构建环境中使用。

## JNI 桥与替换安装

`android/mpv-jni/bridge.cpp`、`media_codec_layout_parser.h` 与 `MPVLib.java` 采用随附 MIT 许可。桥只调用 libmpv
公开 API。MediaCodec 诊断只把受限的解码器标识和数值字段传入 Java，原始日志不会跨过 JNI。原应用在运行时加载独立的 `libmpv.so`，无需重建整个应用即可替换。
如要重建桥，参考 `scripts/prepare_mpv.py` 的 NDK 27.2.12479018/API23 链接命令。
对库本身重建不需要该桥脚本下载预编译库。

把重建库放入 `modified-libs/{ABI}/libmpv.so`，三种 ABI 都准备好，运行：

```sh
python3 scripts/replace_mpv_library.py --apk hongguo-tv-mpv-VERSION.apk \
  --libraries modified-libs --out hongguo-tv-mpv-modified.apk \
  --build-tools /path/to/android-sdk/build-tools/35.0.0 \
  --keystore /path/to/your-own.keystore --alias your-key
```

工具删除旧签名、替换共享库、zipalign 并用你的密钥重新签名。没有原发行私钥，
系统通常不允许覆盖原签名版本：先导出或同步所需数据，再卸载原 MPV 版，
安装修改版。卸载可能清除该 MPV 版的本地账号、历史、设置；标准版不受影响。
可用 Android 系统安装器或 `adb install`。系统不限制只运行发行方签名版本。
修改版的自动升级会拒绝不同签名，不会覆盖你修改过的库。

运行效率和具体盒子的画面/音画同步需要设备验证；软件 HEVC 不保证低端 CPU
能够流畅处理所有分辨率。
