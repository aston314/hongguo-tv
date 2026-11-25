# 远程 JSON 播放协议档案验证

2026-11-25，先独立验证参考 Kotlin 实现，再接入本项目 Go／webOS 原生数据解释器；未发布正式 JSON 清单或应用。

## 结论

固定原生算法配合远程 JSON 字段档案的方案成立。本轮不仅验证配置能解析，还在同一匿名身份、同一集上复现了“只改 JSON 导致上游空体，再只改 JSON 恢复模型”。三个不同样本均取得 1080P HEVC/AAC，完成整集下载、原始 Kotlin 媒体解密和完整音视频解码。

这证明当前字段表／参数类修复可由 JSON 承担，不证明未来算法、身份流程或解析结构变化都能用同一 schema 解决。本项目接入实现由 Go 和 webOS 原生模块解释配置；只给现有 JS VM 再加一个 JSON 输入并不能省掉 JS VM。首次接入仍需客户端升级。

## 已确认的分发要求

用户在本轮验证后确认：JSON 存放于公开发布仓库 `aston314/hongguo-tv-releases`，下载使用与现有 JS 规则相同的代理和直连。客户端内置地址，无需用户填写仓库、清单或代理。

使用独立的 `resolver-profile/` 通道，避免旧客户端把 JSON 当 JS 执行，也避免混用两个通道的最高 revision／停用状态：

```text
hongguo-tv-releases/main/
  resolver-js/                         现有通道
  resolver-profile/
    manifest.json                      签名清单
    profiles/<sha256>.json             不可变协议档案
```

JSON 清单内置地址为 `https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/resolver-profile/manifest.json`。本文件记录约定，不代表目录、清单或客户端下载已经上线。

下载线路复用现有 `core/internal/jsupdate/download.go` 的 `Routes`／`Proxies`，webOS 同步复用 `playback-rule-network.js` 的线路选择逻辑；不复制成两份以后各自漂移的代理表。当前顺序为：

1. `https://gh-proxy.com/`
2. `https://v4.gh-proxy.org/`
3. `https://gh-proxy.org/`
4. `https://ghfast.top/`
5. 直接请求原始 HTTPS 地址。

代理前缀只作用于发布仓库内的清单／档案下载，不代理到另一个远程解析服务。每条线路都要先通过签名／哈希／大小／schema 检查，失败继续下一条；不能让返回 HTTP 200 的 HTML 或旧缓存阻断其他线路。保留 webOS 既有证书链兼容与正常 TLS 校验。

复用已有发布信任公钥、签名发布基础设施及缓存／回滚机制；JSON 自动工作，不依赖用户设置，JS 仍保留原有选择。JSON 使用独立 product 和状态目录，签名覆盖配置版本、revision、有效期、档案地址、SHA256、长度及 schema。接入实现包括候选格式验收和每次取源的独立配置快照；现有 JS 通道不被本文或测试数据覆盖，也没有发布正式 JSON 配置。

## 固定材料与运行方式

- [参考 release kotlin-v1.0.0](https://github.com/miaoxiaohu/hongguoTV/releases/tag/kotlin-v1.0.0)，源码提交 `312e7f210bf37d3b47236426f0292201eb403199`。
- 使用 release 附件源码 ZIP，其 SHA256 与同 release 的 SHA256SUMS 相符：`0487b7bcf0c4589511a661b1d48bed861985607e81365f8064972d1de700bd5b`。
- ZIP 内 `playback-profile.json` 为 14,911 字节、revision 1，SHA256 `15ea8833196da8a8029c431fcf2c69625f691b7422a56cc12f8609362d1649f8`。
- JDK 17 / Kotlin 2.1.20。单独构建 core 源码，隔离验证入口与补充测试；原始 `PlaybackProfile`、`Signer`、`V5Playback`、`PlaybackDevice`、模型挑选及 `MediaCrypto` 未修改。
- 实网由原始 `PlaybackProfileRepository.fetch()` 成功从仓库拉取 revision 1，并由 `PlaybackProfiles.apply()` 激活。新匿名身份现场注册，跨样本复用；不使用捕获 Cookie、外部代签或本项目原生取源兜底。
- 媒体验证使用实际完整下载及原始 `MediaCrypto`。本轮没有将原始 Android `RemoteVideo` 的 Range 读取计为已验收，也没有安装 APK 或进行电视播放测试。

## 离线结果：20 项通过，0 跳过

| 测试组 | 项数 | 结果 |
| --- | ---: | --- |
| 原始 PlaybackProfileTest | 9 | 通过 |
| 原始 PlaybackProfileStoreTest | 7 | 通过 |
| 补充 ProfileValidationTest | 4 | 通过 |

补充测试验证：

1. 固定时钟、身份、进程 nonce 和随机数序列，内置配置与外部 JSON 产生完全相同的 URL、请求头和签名。
2. 只修改 JSON 的 message 字段 21，query 与 Helios 保持相同、Medusa 改变，确认真正影响签名而非仅读到配置。
3. 只修改设备字段字面量，query 和 Medusa 随之改变。
4. 构造 bytes 字段引用整数运行时值的配置：解析及激活成功，但签名发生 ClassCastException。此项是对现有验证缺口的复现，不能理解为格式验证已充分。

## 实网：只改 JSON 的 A/B/A

同一新注册身份、同一分集 `7706514815799282713`；同一进程和同一套 Kotlin 代码，只有本地 JSON 字段及递增 revision 改变。请求时间戳与随机数按正常协议生成。

| 步骤 | JSON 的 message 字段 21 | revision | HTTP | 响应字节 | 目标集模型 |
| --- | ---: | ---: | ---: | ---: | --- |
| 初始 | 312 | 1 | 200 | 23,990 | 成功，bytevc1 |
| 改成旧值 | 377 | 2 | 200 | 0 | 失败 |
| 恢复原值 | 312 | 3 | 200 | 23,971 | 成功，bytevc1 |

只通过 V5 POST 验证，没有让 tab、legacy 或其他原生回退掩盖候选失败。恢复步骤使用更高 revision；没有修改远端仓库或正式规则。

## 实网：兼容整集媒体

三集均由原始 V5 POST 主机 `api5-normal-sinfonlinea.fqnovel.com` 返回 `code=0`，目标 VID 的 envelope 匹配。初始模型均为 bytevc1；本轮未触发或重新验收仅 ByteVC2 的兼容回退。

| 分集 ID | 取模型耗时 | 真实视频尺寸 | 媒体时长 | 完整字节数 | 完整音视频解码 |
| --- | ---: | --- | ---: | ---: | --- |
| 7706514815799282713 | 243 ms | 1080×1920 | 72.144 s | 7,258,839 | 通过 |
| 7702841946812714008 | 151 ms | 1920×1080 | 136.997 s | 23,540,607 | 通过 |
| 7703473857562151961 | 145 ms | 1920×1080 | 91.045 s | 14,369,622 | 通过 |

三个文件 FFprobe 确认 HEVC + AAC，FFmpeg `-xerror` 完整解码无错误；不是仅请求成功、只读取 1 MiB 或 10 秒预览。临时加密及解密媒体在验证后删除。

另运行本项目真实 Go JS 宿主 `TestCurrentJSLive`，同一第一样本返回 5 个 bytevc1 候选，耗时 572 ms。该对照只验证当前 JS 仍能取源；两实现走的网络路径／身份不同、样本数也不同，因此不能据此宣称 JSON 比 JS 快多少。

## 采用前需补的能力与边界

- 复用或扩展本项目的签名分发、可信来源、代理／直连、递增 revision、候选验收和回滚机制。参考代码的 HTTPS 与格式检查不等于本项目已有的发布签名验证。
- 配置在实际签名／离线向量验证成功前不成为活动版本；解析过关不足以证明引用类型正确，更不足以证明上游接受。
- 每次取源固定一份不可变配置快照，避免更新发生在 query、Helios、Medusa 生成之间，混用不同版本。
- 配置 schema 只覆盖明确支持的字段类型／已有运行时值、模板及协议点。新的计算方法、注册流程、回退编排或模型解析变化仍可能需要 JS／客户端升级。
- 上述初始 Kotlin 结果不包含本项目宿主；本项目接入结果见下节。尚未跑 Android 进程 PSS 对照、低端设备、长时间播放或 LG 实机测试。14.6 KiB 是文件大小，不是运行内存，也不能与此前 JS 的 PSS 增量直接相减。

## 本地可复现材料

本轮隔离目录 `/private/tmp/hongguo-profile-v100-validation/` 包含原始 core 源码、单独 Gradle runner、4 项补充测试、实网验证入口及日志。主要结果：

- `profile-tests.log` 及 `runner/build/test-results/test/`。
- `evidence/live-result.json`：模型阶段及整集媒体元数据。
- `evidence-ab/live-result.json`：同身份 JSON-only A/B/A。
- `current-js-control.log`：本项目当前规则控制结果。

报告与结果 JSON 不含设备身份、Cookie、签名请求、媒体 URL 或内容密钥。临时目录可能清理；本文件保留固定材料、方法和汇总，不依赖临时路径证明功能已接入生产。

## 本项目原生接入验证（2026-11-25）

实现及维护规范见 [原生 JSON 规则](playback-profile-authoring.md)。内置默认 JSON 自动工作，启动后台检查，手动检查复用现有入口；无新设置开关或用户输入地址。JSON 不创建 Goja VM／Node 工作进程。可选 JS 的开关、原有更新语义及优先级保留。

本项目 Go 的独立 `TestNativeProfileLiveMedia` 用同一个匿名身份连续解析六集，经过三部剧的切集／切剧，均完成 1080P 整文件下载、解密和完整音视频解码。无 JS 或旧原生取源序列兜底；仅 ByteVC2 时调用既有编码兼容模块，这是候选链路的一部分。

| 分集 ID | 取模型耗时 | 实际尺寸（FFprobe） | 字节数 | 编码兼容回退 | 整集解码 |
| --- | ---: | --- | ---: | --- | --- |
| 7706514645208534041 | 513 ms | 1080×1920 | 22,013,835 | 不需要 | 通过 |
| 7706514815799282713 | 180 ms | 1080×1920 | 7,258,839 | 不需要 | 通过 |
| 7706514627462433817 | 156 ms | 1080×1920 | 3,875,487 | 不需要 | 通过 |
| 7702841946812714008 | 334 ms | 1920×1080 | 27,320,959 | ByteVC2 → HEVC，4→1 | 通过 |
| 7702841953875938328 | 260 ms | 1920×1080 | 7,522,899 | ByteVC2 → HEVC，4→1 | 通过 |
| 7703473857562151961 | 275 ms | 1920×1080 | 16,120,440 | ByteVC2 → HEVC，4→1 | 通过 |

Go 与 webOS 的原生解释器通过四个独立 Kotlin 完整签名向量（query／Helios／Medusa）；新增 fixture 验证精确大整数 ID、请求体 content type、错误分集拒绝、ByteVC2 4→1→0→3 编码回退、业务错误停止、取消、自动更新与 JS 偏好隔离。签名候选测试覆盖坏字段、坏摘要、坏签名、跨通道拒绝、离线缓存、远程停用、防回放与更新快照。真实 Node 0.12.2／8.12.0 用同样向量检查旧运行环境。

本机 Apple M4 的最终微基准（不含网络）：JSON 解析含双接口、四个 carrier 的八次签名试跑约 0.71～0.73 ms、累计分配约 723～724 KiB；单次签名约 22 μs、累计分配约 24.5 KiB。累计分配可被 GC 回收，不是常驻内存、Android PSS 或随播放集数累积的证据，也不能与此前 JS 的 PSS 直接相减。这些数字包含签名消息展开大小限制。

首次应用发版、正式 JSON 通道发布及 Android／LG 实机长播验收尚未执行。
