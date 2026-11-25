# 原生 JSON 播放协议规则

## 用户行为

JSON 使用内置默认规则，**自动启用、启动时后台检查**。用户无需打开设置、填写地址或选择规则。离线／下载或验证失败时继续使用已接受的缓存，否则使用内置规则；后台更新不阻塞界面，不重启播放器。设置中的现有“检查修复”操作同时检查 JSON 和可选 JS；关闭 JS 仅关闭 JS。

Android 标准版、MPV、Android 5 及桌面共用 Go 解释器；webOS 由现有 Node 服务解释数据，不启动规则工作进程。这套机制首次安装仍需新版客户端。已经安装的旧版不能通过一个 JSON 文件自动获得新宿主能力。

若用户明确开启 JS 且已下载有效修复，保留原有 JS 优先级；之后是自动 JSON，最后是完整的旧原生取源序列。JSON 内固定先 `video_tab`，成功即返回，然后按允许的主机尝试 V5 POST。每次 JSON 取源最多占原有 30 秒取源预算中的 3 秒；媒体失败后进入余下来源，不重新循环 JSON。匿名注册、目标分集校验、仅 ByteVC2 时兼容源回退、媒体解密／缓存／播放器边界继续由原有模块承担。

## JSON 能修改什么

唯一源文件是 `webos/service/playback-profile.json`，通过 `go run ./scripts/profile_codegen` 同步嵌入 Go。固定原生算法解释这些数据，不执行 JSON 中的代码：

- schema 1、档案 revision、更新时间和说明。
- V5 签名 magic、license、key、S-box、flags 及三种现有签名头。
- 设备 query 的有序字段、值、显式身份引用；`video_tab` 有序附加字段。
- 既有 protobuf message/device/env/envSub13/nested 的 tag、类型和字面量／引用。
- 白名单内的上游主机、固定接口路径、User-Agent 和 V5 请求体模板。

不支持任意表达式、循环、导入代码、自定义网络目的地、注册流程、来源编排或新算法。当前 schema 无法表达的协议变化，应准备现有 JS 候选或升级客户端，不把可执行脚本塞进 JSON。

字段只允许 `sint`、`float`、`string`、`bytes`。引用必须整值为 `${名称}`，引用类型与目标字段一致，且依赖已构建；不能将 `${ts}` 放进 bytes。字节字面量为十六进制；整数需在跨平台精确范围（绝对值不超过 4503599627370495）内。时间、随机数、身份等动态值由宿主提供，生产身份／Cookie／URL／密钥不得写入档案。

请求体必须保留 `${id}`、`${content_type}` 和 `${device_level}`，恰好请求指定 content type 下的一集。VID 始终为字符串。规则校验拒绝重复键、未知字段、不支持的 schema、非法主机／路径、错误引用类型、过深结构、超过 256 KiB 的内容及展开后超过 16 KiB 的任一签名消息，并进行四种 carrier 的离线签名试跑。

## 分发与更新

所有静态文件均发布到公开仓库 `aston314/hongguo-tv-releases` 的独立目录：

```text
resolver-profile/manifest.json
resolver-profile/profiles/<sha256>.json
```

清单地址内置为 `https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/resolver-profile/manifest.json`。使用现有 JS 下载器的四个代理，随后直连；webOS 保留原有 TLS 证书链兼容。每条线路先验签／校验摘要与长度，HTTP 200 的 HTML 不算成功。

清单沿用既有 Ed25519 信任锚，product 为 `hongguo-playback-profile`。签名覆盖 enabled、递增控制 revision、接受有效期、文件版本、固定协议／宿主版本、URL、大小和 SHA256。JS 的 `resolver-js/` 使用另一个 product、目录和最高 revision；互不接受对方清单。

发布使用主线手动工作流 `resolver-rules.yml`，指定 `kind=json`、递增 `revision`、新 `module_version`。工具只读取已生成的内置 JSON；签名密钥仍仅在 Actions 的 `PLAYBACK_RESOLVER_SIGNING_SEED` 中，分发使用 `HONGGUO_RELEASES_TOKEN`。`disable=true` 发布更高 revision 的停用控制，恢复内置 JSON及原生后备。首次接入提交代码与通过 CI **不会自动发布清单或应用**。

JSON 内的 revision 是档案元数据；签名清单的控制 revision 才是防回放依据。内容变化必须使用新 module_version；禁用后恢复也必须提高控制 revision。有效期仅限制接受新控制，已接受缓存可离线继续使用。

## 激活、回退和并发

签名、摘要、长度、schema、字段依赖及离线签名试跑全部成功后，才原子切换活动规则。请求从 query 到签名、响应和兼容源解析始终使用同一快照；更新只影响后续请求。当前活动文件与上一份实际取源成功的文件保留，其他旧缓存清理。

损坏缓存／执行结构错误返回上一份可用档案，再返回内置规则；上游空体、业务拒绝、取消或超时不能据此隔离一个规则。最高控制 revision 单独保留，回退不会允许旧清单再次覆盖。新候选验证失败不替换可用版本。存储错误应继续保留正常原生来源，不以新配置阻断播放。

## 验证与交付

```sh
go run ./scripts/profile_codegen -check
go run ./scripts/resolver_js_codegen -check
go test -race ./core/internal/playbackprofile ./core/internal/jsupdate
go test -race ./core/cmd/hongguotv -run 'TestNativeProfile|TestPlaybackRepair|TestMiniReelRepair'
node --test tests/webos-playback-profile.test.cjs tests/webos-playback-repair.test.cjs
bash scripts/verify_webos.sh
```

旧 Node 通过 `WEBOS_LEGACY_NODE` 指向实际 Node 0.12/8 后运行相同测试。Go 与 webOS 都必须通过独立 Kotlin 签名向量，不能把自生成签名作为正确性证据。实网时以 `HONGGUO_LIVE_PROFILE=1` 运行 `TestNativeProfileLiveMedia`，验证精确分集、切集切剧、兼容编码、完整媒体解密和整集音视频解码；日志只记录匿名结果。

新增 JSON 原生解释器不创建 Goja VM，但这不等于已经证明所有设备的内存增量为零。Android PSS、低端盒子长播、LG 电视播放仍须实机验收；CPU／分配基准、Node 兼容检查和本机 FFmpeg 结果各自明确边界。参见 [初始验证与接入结果](playback-profile-json-validation.md)。
