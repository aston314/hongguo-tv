# 播放解析规则：编写、生成、验收与发布规范

本文固定本项目的 JS 规则生产流程。协议与安全边界保持稳定，具体取源算法允许随上游变化调整。功能状态与实测边界见 [播放自动修复说明](playback-auto-repair.md)。

## 1. 使用定位与平台

目标是：在已接入、已开启并通过验收的 Android／桌面客户端上，将独立规则更新作为播放地址修复的优先交付渠道，减少为接口参数、签名或响应结构变化重新打整包。

这不等于现在默认开启或全面验收完成。当前开关仍默认关闭；低端设备、长时间播放与桌面实机的验收不能用 CI 或单次成功替代。用户需先安装包含此能力的客户端并开启功能，旧客户端不会因发布了 JS 自动获得此能力。

| 平台 | 在线规则更新 | 当前处理方式 |
| --- | --- | --- |
| Android 标准版／MPV／兼容构建 | 共享 Go 宿主提供能力 | 开启后先尝试已验收的签名规则，失败保留完整原生回退 |
| macOS／Windows／Linux 桌面版 | 共享 Go 宿主提供能力 | 同上；构建成功不代表每个平台已经实机验收 |
| webOS | 当前未接入此更新器 | 保留自身 JS 服务；取源修复需要同步源码、测试并发布应用 |

webOS 本身能运行 JS，且目前 bundle 复用了它的一些纯函数。但它没有因此自动获得 Go 内的验签、受限宿主与运行时隔离。不要在其共享 Node／账号进程里直接执行下载脚本来冒充适配完成。

规则分发只使用公开发布仓库中的静态清单和 JS；执行及上游请求发生在用户本机，不需要解析服务器或 Worker。下载规则经过已有代理与直连；代理不是取播放地址的远程解析服务。

## 2. 哪些改动适合规则更新

- 适合：已有能力范围内的匿名注册流程、请求参数／请求体、接口签名计算、域名选择、重试顺序、模型／密钥解析和兼容编码请求。
- 需要客户端版本：现有宿主无法提供的新能力、不受允许的上游域名、宿主 API／规则协议／信任公钥变更，以及播放器、媒体解密、缓存、JNI、UI 或平台实现的变化。
- 已验证修复在后续正常应用版本中同步到 Go 内置解析及相应 webOS 实现，避免关闭开关或尚不支持规则更新的用户长期使用旧逻辑。原生兜底也需要维护。

当前规则保持 `video_tab` 优先；其余来源与兼容编码回退按代码和测试维护。不要为追求“固定流程”永久冻结上游算法，也不要无证据地改变已正常的快路径。

## 3. 源文件与生成入口

| 内容 | 权威位置 |
| --- | --- |
| JS 取源编排、身份生命周期、错误分类、输出归一 | `core/internal/jsresolver/source/resolver.js` |
| 字节原语适配、大整数 JSON、Buffer 兼容 | 同目录 `crypto.js`、`exact-json.js`、`buffer-compat.js` |
| 允许打包的模块／纯函数列表 | `scripts/resolver_js_codegen/main.go` |
| 复用的签名／协议／模型纯函数 | 生成器明确列出的 `webos/service/` 模块和函数 |
| 生成的规则 bundle | `core/internal/jsresolver/resolver.js`，禁止直接手改 |
| Go 宿主、协议与限制 | `core/internal/jsresolver/runtime.go`、`http.go`；`core/internal/resolverwire/wire.go` |
| 验签／下载／激活／回滚 | `core/internal/jsupdate/` |
| 签名发布器／发布工作流 | `core/cmd/resolver-publish/main.go`；`.github/workflows/resolver-rules.yml` |

修改上面实际使用的源文件后，在仓库根目录执行：

```sh
go run ./scripts/resolver_js_codegen
go run ./scripts/resolver_js_codegen -check
```

生成器只打包白名单模块，且从 `account.js`／`provider.js` 提取指定纯函数；不得把完整账号、存储或播放器模块塞入 bundle。它还生成 `sm3_generated.go`，来源为现有标准 SM3 原语，而非将上游签名算法转回 Go。

复用模块修改会同时影响 webOS 源码，必须验证其真实旧 Node 运行时兼容性。只改 JS 专用编排则不会自动修复 webOS；需要明确记录是否另有同步改动。

## 4. 脚本接口合同（protocol 1／host_api 1）

bundle 是自包含表达式，求值后返回带 `metadata`、`selfTest`、`resolve` 的对象。不要将独立的顶层 `module.exports`、动态 import 或浏览器页面脚本直接作为发布文件。

### 元数据与自测

`metadata()` 返回普通对象，包含：

```json
{"name":"hongguo-playback-resolver","version":"2026.11.24.1","protocol":1,"native_sm3":true}
```

这里的版本只是接口示例；实际发布器会为生成 bundle 写入本次 `module_version`。不要手改输出文件来换版本；只有随客户端升级嵌入的基线变更才需要同步维护源码元数据与 `jsresolver.Version`。

`selfTest(vectorsJSON)` 接收宿主提供的独立签名向量 JSON，执行计算后返回通过条数。当前要求为 4 条。初始化、元数据和自测均不得联网；禁止直接返回常数假装通过，禁止删掉旧向量来掩盖签名差异。

### 取源输入

`resolve(requestJSON)` 接收 JSON 字符串：

```json
{"vid":"123","codec_mode":"default","content_type":"1004"}
```

- VID、设备身份和上游大整数 ID 保持十进制字符串；使用现有精确 JSON 解析，禁止经 `Number`／浮点数往返。
- `codec_mode` 按现有映射处理：`default`／`standard`、`auto`／`mpv_auto`、`software`／`mpv_software`。不能将未知值默认为可用模式。
- 缺省 `content_type` 由当前编排设为 `1004`；不得把错误内容类型的数据当成目标集。

### 成功与失败输出

返回 JSON 字符串，成功形状如下；这是合成示例，不是可用片源：

```json
{"options":[{"URL":"https://cdn.example/episode.mp4","Key":null,"Codec":"h265","Width":1280,"Height":720,"Quality":"720P","Duration":90}]}
```

`options` 内字段大小写必须与现有 Go 合同一致。`Key` 是现有媒体约定的 Base64 密钥或 `null`；不在诊断或报告中输出。保留真实 codec 和清晰度，不得将 ByteVC2 重命名成 HEVC，不得用 10 秒试看片段冒充整集。候选必须对应请求的同一集；兼容编码回退也要验证内容一致性。

失败只返回经过归一的错误码与阶段，例如：

```json
{"error_code":"VIDEO_MODEL_EMPTY","error_stage":"video_tab"}
```

错误码符合 `[A-Z0-9_]{1,64}`，阶段符合 `[a-z_]{1,40}`。保留“上游空体／业务失败／超时／取消”与“脚本执行失败”的区别，避免把上游故障误判成坏脚本并回滚。不要返回原始异常、请求 URL、响应正文或账号信息。

现有脚本可使用 Promise 链；Go 宿主使用同步受限 HTTP，并要求调用结束时 Promise 已完成。没有浏览器 `fetch`、定时器或通用 Node 事件循环可供脚本等待。

## 5. 职责与资源边界

JS 负责匿名注册、请求构造、签名、模型与密钥解析、候选排序及兼容编码请求。Go 仅提供字节原语与受限网络，负责规则管理，并继续拥有媒体下载／解密／缓存、原生回退与播放器生命周期。

当前 `__resolverHost` 只有 `hash`、`cipher`、`random`、`gzip`、`gunzip`、`http`。签名协议逻辑应留在 JS；不得通过新增 `nativeResolve`／`nativeSign` 高层入口把“热更新”变成调用旧算法的空壳。

当前限制来自源码，以下只是维护提示；限制改动必须同时更新合同与测试：

- JS 上限 1 MiB；取源输入 16 KiB，结果 256 KiB，候选 1～32 个。
- 上游 HTTP 仅允许指定域族的 HTTPS、GET／POST，每次调用最多 24 次请求，单次最长 8 秒，正文上限 5 MiB。禁用账号 CookieJar、Authorization 和自动跟随重定向；匿名 Cookie 只有明确白名单。
- 正常应用只给修复规则原有 30 秒取源预算中的最多 8 秒，余下时间保留原生回退；不能因脚本内部较长预算而突破宿主取消。
- 禁止读取文件、账号、UI 或调用播放器。允许模块来自 bundle 自身白名单，而非磁盘／网络加载。
- 使用一个常驻 VM，更新时至多一个校验候选；不为每一集创建 VM，不无界缓存身份／响应／历史模型。关闭后的新请求立即走原生，在途请求按其生命周期退出。
- Goja 没有硬堆配额。栈、请求、大小与超时限制不等于硬内存隔离；不能声称“签过名所以不会卡顿或泄漏”。

## 6. 验收：不能把“回退成功”算成 JS 成功

每次修复先补能重现差异的脱敏 fixture，再验证以下层次：

1. **离线行为**：精确 ID、签名 query／body／时间戳一致性、主／备用域、同身份与新身份回退、空体／业务失败／限流、取消、仅 ByteVC2、兼容来源集数匹配。保留已有正常快路径。
2. **真实 JS 取源**：直接调用 `jsresolver.Resolve` 或明确确认规则实际命中；同时报告 JS 成功与原生兜底成功，不能只看应用最终播放成功。
3. **可播放性**：验证候选编码、实际媒体字节／解密与播放器就绪，至少覆盖切集、切剧。HTTP 200、非空模型或一个 URL 均不足以认定可播。
4. **更新生命周期**：从应用取到本次发布字节，确认实际活动规则版本、重启缓存、离线旧规则、坏签名／坏脚本、远程停用、本地关闭、重复更新与回滚。不要只测内嵌开发副本。
5. **性能与采用范围**：需要扩大默认采用范围时，对同设备、同播放器／编码／档位、同网络做原生与 JS 成对对照。冷启动与热运行分开；CPU／签名解析时间与上游网络等待分开；报告样本数、p50／p95，以及应用总 PSS 和 Go core PSS 随连续集数变化。低端设备和长时间播放不能用 Shield 或 CI 结论替代。

现有可重复检查：

```sh
go run ./scripts/resolver_js_codegen -check
go test -race ./core/internal/jsresolver ./core/internal/jsupdate
go test -race ./core/cmd/hongguotv -run 'TestPlaybackRepair|TestMiniReelRepair'
node --test tests/resolver-js-bundle.test.cjs tests/playback-repair*.test.cjs tests/announcements.test.cjs
```

微基准可用 `go test ./core/internal/jsresolver -run '^$' -bench BenchmarkResolverStages -benchmem`。显式联网单样本检查可用 `HONGGUO_CURRENT_LIVE=1 go test ./core/internal/jsresolver -run '^TestCurrentJSLive$' -count=1 -v`；该测试仅证明代码中固定样本的取源情况，不是整套媒体、设备或发布验收。

实测记录包含提交、规则版本／哈希、样本类型、JS 命中／原生回退、编码与媒体验证结果，以及未覆盖边界。设备地址、原始日志、带签名 URL、身份、密钥和原始内存报告留本地；公共记录只放匿名汇总。

## 7. 签名分发与公告

稳定分发目录为 `hongguo-tv-releases/main/resolver-js/`：`manifest.json` 加不可变的 `modules/<sha256>.js`。这与 `experimental/resolver-js` 独立；不得串用产品、密钥或清单。

正式清单是 `payload`＋`signature` 的 Ed25519 信封。被签名的内容包含产品、schema、递增 `revision`、启停、签发／到期时间，以及模块版本、protocol、host_api、URL、大小、SHA256。必须由现有发布器生成并验签；不能手改 JSON、覆盖同哈希文件或跳过检查。

在已获得本次发布授权、源码已进入允许的主线并通过验收后，从 `main` 运行 **Publish signed playback resolver rules** 工作流：

- `revision`：严格大于当前已发布控制版本，启用、停用、续签均如此。
- `module_version`：脚本字节变化使用新版本；同版本变字节会被拒绝。日期样式只是约定，不是应用版本号。
- `disable`：正常更新为 `false`；紧急停用为 `true`，发布更高 revision 的签名控制，后续解析回到原生。恢复也需更高 revision。离线客户端不能立即获知远程停用。

签名 seed 只在加密 Repository Secret `PLAYBACK_RESOLVER_SIGNING_SEED`，发布令牌为 `HONGGUO_RELEASES_TOKEN`。客户端与仓库只含公钥。不要导出、打印或复制私钥到 skill、日志、APK 或公共仓库。

当前新清单的接受有效期最长 30 天：正式运营要在到期前续签更高 revision；代码没变时可沿用模块版本与哈希。已经接受的缓存不会仅因接受期限过期而失去离线使用资格。不要因此误认为长时间未续签对新安装用户没有影响。

规则字节会下载到用户设备，也位于公开发布仓库，因此可被读取；签名保证来源和完整性，不负责隐藏算法。保持第三方代码的来源和许可声明。

先验证签名规则，再发对应公告。公告操作只用 `repair_playback`＋`min_revision` 指向规则，不能携带 JS 执行地址或代替用户开启开关；“规则已就绪”依据实际活动 revision，不是仅凭清单见过的最高版本。公告规范见 [announcements.md](announcements.md)。

## 8. 每次交付明确报告

报告“改了什么、哪些平台能接收、JS 是否独立成功、媒体／设备验证了什么、是否已签名发布／是否仍为候选、是否还要应用发版”。

文档、skill 和此前的实现／测试授权不会自动授权后续主线合并、稳定规则发布或应用 release；依照当前任务的明确授权执行。若仅要求讨论或生成候选，就停在可审查的结果，不改默认开关或正式更新通道。
