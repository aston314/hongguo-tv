# 匿名播放身份与空响应恢复

## 当前生产流程（2026-11-11）

Android / 桌面 Go 核心与 webOS 独立服务首次采用相同的默认取源顺序：

1. 保留官方 `GET /reading/bookapi/video_tab/multi_video_model/v1/` 优先。
   它沿用自己的匿名注册身份与允许的注册 Cookie；候选源通过媒体准备即可返回，不预先注册后备身份。
2. GET 失败、缺模型、没有兼容源或其媒体读取失败后才进入 `POST /novel/player/multi_video_model/v1/`。每轮通过
   `POST /service/2/device_register/` 注册新匿名身份，取得 `device_id` / `iid`。
3. 用该轮身份依次请求 `api5-normal-sinfonlineb.fqnovel.com` 与
   `api5-normal-hl.fqnovel.com`，每次独立计算签名。备用主机使用新连接。
4. 第一轮仍为空或出现适用的临时错误，最多再注册一次、重复两个主机。
   旧接口合计最多两轮、四次 HTTP 请求；得到兼容候选后进入原有媒体准备。
5. 前两路仍不可用时才进入 `POST /novel/player/video_model/v1/`。该单集协议使用独立的
   `7.3.9.32` / Xiaomi Android 14 匿名注册身份，不接触账号和已有缓存。请求体为
   `video_id` + `biz_param={video_id_type:0,need_all_video_definition:true,video_platform:3}`；
   未压缩 JSON 与 query 使用当前播放签名实现。空响应或临时网络失败最多两次，
   明确返回不兼容模型时不反复换身份。

### 完整播放签名与兼容编码（2026-11-11）

本轮实网复核发现原 `Argus` / `Ladon` 的四字节时间戳占位已无法取得模型。
根据 [hongguo-open-player PR #92](https://github.com/zfdang/hongguo-open-player/pull/92)
（`3f687c5b`）的协议与固定向量，独立补齐 551 Protobuf / Simon / AES Argus 和
34 轮 Ladon。两端使用同一组固定向量；webOS 使用现有 32 位对运算，未引入新依赖。
账号签名及其固定向量保持原样，不使用参考项目内置身份。

- Argus 绑定最终 query、实际发送 body 的 MD5/SM3、注册设备 / 安装 ID、版本及时间戳；
  每个请求生成新的随机字段。Ladon 绑定时间戳、license ID 与 aid，并生成独立随机数。
- 播放层移除账号 profile 的 `X-Medusa`，保留完整 `X-Argus` / `X-Ladon` 及原
  Gorgon / Helios / Khronos。逐项实网对照表明：带账号 Medusa 时 HTTP 200 / 0 字节，
  只去掉 Medusa 后相同旧接口配置返回完整模型。账号和其他 API 的 Medusa 不受影响。
- 不调整 provider 顺序、版本 profile、注册/主备重试次数、总预算和媒体准备策略。
  `video_tab` 可用时仍优先直接返回；其 GET 认证方式不改。

参考 [LiuWQ0809/hongguo-android](https://github.com/LiuWQ0809/hongguo-android)
（`0814ffa2`）的同集兼容编码回退协议，只有内联列表为空或全部为 ByteVC2 / bvc2 时，
才跟随原 `fallback_api`。原 fallback 仍全部为 ByteVC2 时，再依次尝试
`codec_type=1`、`codec_type=0&force_codec=h264`、`codec_type=3`，取得可解析候选即停止。
正常内联候选不增加请求，指定清晰度不足不触发这组探测。

- 只替换 codec 参数，保留原 signed query 的其他字节、顺序、重复字段及转义。
- 比较原始、原 fallback 与每个候选的 `video_id` 和 `video_duration`：已报告的编号不符、
  已报告的正时长差超过 0.5 秒均拒绝，不将业务 VID 与底层转码 video_id 混为一谈。
- fallback 的 `key_seed` 仅解密媒体 URL；嵌套或顶层 `spade_a` 仍供既有 CENC 内容解密。
  声明加密却缺少可用内容密钥的候选被排除，不能当成明文。
- 最多原 fallback 加三个 codec 变体，共享 provider 截止时间、取消与前台/预取任务；
  保留 HTTPS 主机白名单、重定向次数和响应大小限制。原始带签名 URL 不进入错误诊断。
  全部不可用时仍进入现有剩余 provider，不把 ByteVC2 当成可播放的 HEVC。

实网样本为《我都元婴期了，你跟我说开学第四季》第 1 / 17 / 18 集：原模型全部为
ByteVC2，经 `codec_type=1` 得到 1080P HEVC。Go 与 webOS 均实际读取、解密每集 1 MiB，
通过 FFmpeg 音视频解码检查。CDN 没有强 ETag 时仍走原有整集下载回退。
浏览器真实推荐验证第 1 → 17 → 18 集、自动下一集，以及切换不同剧目、快速连续切剧，
均有画面、`readyState=4` 与推进的播放时钟。
本机样本不保证所有剧都有兼容编码，也不替代 Android / LG 实机解码验证。

`codec_type=3` 补充参考 [miaoxiaohu/hongguoTV kotlin-v0.9.93](https://github.com/miaoxiaohu/hongguoTV/releases/tag/kotlin-v0.9.93)
（源码 `1240f494`）。2026-11-11 本机对《重生后我给emo修士当狗》首集
`7703473857562151961` 与上述真人剧第 17 集 `7702841953875938328` 实测：原备用模型
全部为 ByteVC2，`codec_type=3` 均给出 1920×1080 HEVC / bytevc1；完整媒体下载、解密和
FFmpeg 音视频解码通过。相同样本的 `codec_type=1` 当时也可用，不能将参数 3 视为
所有剧唯一有效的取法；它仅放在已有两个 codec 变体之后，已有成功路径不增加请求。

### 同剧成功路径记忆

首次保持 `video_tab → multi_video_model → video_model`。完成实际媒体准备后，
同剧后续集将该 provider 提到第一位，其余两路保持默认相对顺序；成功即返回。
例如首集在第三路完成准备，下一集顺序为 `video_model → video_tab → multi_video_model`。
这只是减少重复失败等待，不改变上游接口本身的成功率。

- 只在整集下载、解密完成，或 Range 媒体/加密索引初始化成功后记录；只拿到模型、
  URL、命中已有媒体缓存或取消后的迟到结果均不产生新的成功记录。首帧解码仍由播放器负责。
- 本机进程内最多 128 条，有效期自最近成功起 30 分钟；重启清空，webOS Service 关闭也清空。
  key 包含剧 ID、codec 模式、内容类型、请求清晰度及是否允许降档，不跨剧或跨取源条件排名。
  不写磁盘，不保存身份或 URL，也不增加探测请求。
- 每个媒体任务创建独立顺序快照；前台/预取共享任务、剩余请求次数和预算，不中途重排或重访
  已完成的 provider。Go 仍按 provider 分配 8 / 14 / 8 秒；webOS 保留前两路合计 22 秒、
  单集协议 8 秒；总取源预算仍为 30 秒，与媒体下载耗时分开。
- 记住的 provider 返回适用的取源/媒体错误后清除该提示，继续剩余路径；新的媒体准备成功后
  再记住新路径。用户取消、业务拒绝、存储错误、指定清晰度限制不修改提示。
  记忆过期后恢复默认顺序；旧任务的迟到观察不能覆盖新任务已记录的成功或失效结果。

受控测试覆盖同剧优先、跨剧/清晰度/codec 隔离、30 分钟边界、容量淘汰、乱序完成、
三种优先顺序均不重访 provider，以及模型/媒体失败回退、取消与磁盘/清晰度错误不误学习。

2026-11-07 实网验证同剧第 1、17、18 集：Go 首集实际请求三路、约 1.31 秒，
后两集仅请求记住的 `video_model`、约 0.36 / 0.49 秒；三集均读取、解密 1 MiB，
含 `hvcC`、不含 `bv2C`。其中 CDN 缺少强 ETag 时使用原有整集路径，未降低 Range 校验。
webOS 同三集取源约 1.56 / 0.39 / 0.38 秒，均实际读取、解密并经 FFmpeg 验证音视频解码。
浏览器验证第 1 → 17 → 18 集、自动连播第 19 集及切换第二季，均有 1280×720 画面、
`readyState=4` 和推进的播放时钟。这些时延为当时本机网络样本，不保证设备首帧耗时。

顺序意味着寻找“能完成媒体准备的兼容源”，而非收到一个 URL 即宣布成功：
整集模式沿用下载及 CENC 解密，按需模式沿用 Range / ETag / MP4 初始化与加密索引检查。
媒体读取或整集解密失败可继续尚未尝试的 provider；Range 不支持、弱 ETag、特殊 MP4 布局
仍优先使用原有整集下载回退，再由整集失败决定是否换源。指定清晰度不提供且用户禁止降档、
存储错误、业务拒绝及用户取消均不触发换源。播放器实际首帧/解码失败仍由播放器生命周期报告，
媒体准备成功不等于每台设备都具备相应解码能力。正常路径没有增加额外媒体探测。

旧接口身份只属于当前剧集取源任务，不写回 `video_tab` 缓存，不跨集复用，
不读取或修改登录账号。一个身份可供同一轮的主、备用主机尝试；该轮结束即丢弃。
“身份只能使用一次”来自参考仓库的实测描述，并非上游公开承诺的协议。
客户端采用新身份隔离每次取源，避免依赖它可以长期复用的假设。

## 请求字节与签名

参考 [miaoxiaohu/hongguoTV 的修复](https://github.com/miaoxiaohu/hongguoTV/commit/20a34d38f7ad975f7c818c4a3f72f59ab3a72a4b)
调整旧接口的请求流程，不引入其代码、外部签名服务或新依赖：

- 发送未压缩 JSON，`device_level=3`；对最终发送的字节签名。
- 每次播放请求包含 `X-Argus`、`X-Gorgon`、`X-Khronos`、`X-Ladon`、`X-Helios`；
  不发送账号 profile 的 `X-Medusa`。query 的 `ts` / `_rticket` 与签名时间及请求票据一致。
- 换主机、重试都重新签名；不复用上一次请求的签名头。
- 复用本项目已有的第一方 F13 branch 2 实现；参考仓库使用 branch 0，
  因此不宣称签名实现逐字相同。本项目的 branch 2 已通过本次旧接口实网取源和媒体解密验证。
- 播放签名版本保持 `7.1.3.32`，账号签名版本仍为 `7.3.5.32`。
  原账号签名固定向量必须保持不变。
- Go 的 `mixed_video_id_map` 保留原剧目的数字 `content_type`；缺省仍为 `1004`。
  codec 筛选、清晰度选择、CENC 解密和媒体缓存 key 保持原逻辑。

自定义 endpoint / 本机 fixture 继续使用原有隔离路径，不会自动跳到公网主机。
用户主动填写的手机设备身份保留原有最后兜底行为，只在可重试错误且总取源预算尚有剩余时启用。
历史多线路竞速与身份刷新辅助函数保留给既有隔离路径；生产匿名旧接口不再走它们。

## 重试、共享与取消

- HTTP 200 空正文（含纯空白）、暂时性传输/读取错误、部分临时 HTTP 错误
  可继续主备域或下一轮。无效 JSON、缺模型、空列表、codec 不兼容可进入下一个
  provider，但不因此反复轮换当前 provider 的身份；业务拒绝和取消立即停止。
- Go 三路共享 30 秒取源预算，分配上限为 8 / 14 / 8 秒，媒体准备时间另受原有任务总时限约束。
  单次注册最多 8 秒，并接受调用方取消。
- webOS 每次注册有 8 秒总时限，旧接口网络请求使用 8 秒 socket 超时。
  三路共享 30 秒取源预算，前两路至多 22 秒，为单集协议保留至多 8 秒。
  纯预取最多一次旧接口请求；前台接管继续同一个任务的主机位置、身份及剩余预算，
  不重试 `video_tab`，不重置四次总预算。
- 同一媒体任务的前台与预取继续共享结果和取消路径。不同剧集不共享一次性旧接口身份。
- 切剧、退出、Service 关闭会中止不再需要的注册与取源；迟到响应不能复活旧任务。
  Service 重新唤醒时重建原有 `video_tab` 身份缓存。
- 诊断只保留阶段、次数、状态和响应长度；不写账号凭据、设备三元组、签名或完整媒体 URL。

## 验证与限度

本地受控测试覆盖：主接口成功不注册回退身份、主备顺序、每轮新身份、
播放签名头与发送字节/时间戳绑定、四次上限、跨集隔离、`content_type=1003`、
codec 无可用源进入下一协议但不刷新当前身份、取消注册与永久错误停止、
媒体下载/解密失败后顺序换源、磁盘与指定清晰度错误不换源。webOS 另覆盖预取接管不重置预算、
不同剧集并发、迟到响应、Service 关闭及重新唤醒。

2026-11-05 实网验证：

- Go 强制跳过 `video_tab`，使用真实注册、旧接口签名请求及媒体。
  同剧第 2、3 集均取得 1080P HEVC；另一部剧取得 720P HEVC，均读取并解密 1 MiB。
  不以获得一个 URL 作为播放成功依据。
- webOS 在测试 transport 中仅将 `video_tab` 注入为空，注册、旧接口及媒体全部走实网。
  连续两集各取到 1080P 并读取、解密 1 MiB；两集使用不同身份。其一走 Range，
  另一集因 CDN 缺少强 ETag 走原有整集下载兜底。
- 浏览器真实推荐播放、同剧第 1 → 2 → 3 集、连续切剧与快速切剧后均有画面，
  检查了视频尺寸、数据就绪及播放时钟。取源与媒体下载耗时分开观察。
- 单独的一次 `video_tab` 实网探测返回空正文，不能宣称主接口始终可用；
  “成功直接返回”由受控测试验证，失败时由上述真实回退验证补充。

可复现 Go 实网检查（默认跳过，避免普通 CI 依赖上游）：

```sh
HONGGUO_LIVE_FRESH_FALLBACK=1 go test ./core/cmd/hongguotv -run '^TestMiniReelLiveFreshRegisteredFallback$' -count=1 -v
```

可用 `HONGGUO_LIVE_MINIREEL_VIDEO_ID` 指定分集。媒体 Range 不可用时，该检查会验证
既有整集下载与解密路径。实网结果不保证上游长期稳定，也不代替 Android / LG 实机解码验证。


### 单集后备验证（2026-11-07）

参考 [openhongguo SDK](https://github.com/beilunyang/openhongguo) `42b73f2` 的
`ResolvePlayback` 请求协议，使用本项目已有 branch 2 签名、设备注册封装和 CENC 解密；
未引入整个 SDK 或新的 Go 依赖。请求编码顺序和签名内部环境不宣称逐字一致，以实网验证为依据。

- 《我都元婴期了，你跟我说开学第四季》（series `7702841940475120702`）
  第 1、17、18 集旧接口返回五档 bytevc2，被本项目安全过滤。单集协议返回五档 bytevc1。
- 当前 Go 应用生产链路第 1、4、16、17、18 集均通过 Range 准备、实际读取及解密 1 MiB，
  `hvcC` 存在、`bv2C` 不存在；本机 FFmpeg 逐集音视频解码成功。该轮取源/初始化约 0.54–1.44 秒，
  是本机当时网络观测值，不作为设备启动时延保证。
- webOS 独立 JS 链路第 1、17、18 集均实际通过单集协议完成 Range 媒体初始化、读取/解密 1 MiB，
  并逐集经本机 FFmpeg 验证音视频解码；初始化约 0.89–1.48 秒。
- 浏览器应用实际验证第四季第 1 / 17 / 18 集画面、播放时钟及连续自动连播；
  Android / LG 硬件解码不由该结果替代。
- 受控 webOS 测试覆盖第三路请求体、签名头、独立身份、全不兼容上限、取消第三路请求，
  以及共享整集回退后的媒体换源，避免多个前台消费者重复注册。

显式开启当前生产链路的实网媒体验证（默认 CI 跳过）：

```sh
HONGGUO_LIVE_SINGLE_FALLBACK=1 go test ./core/cmd/hongguotv -run '^TestMiniReelLiveSingleModelFallback$' -count=1 -v
```
