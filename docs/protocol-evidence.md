# 协议证据与待验证接口

日期：2026-10-06。参考 [hongguo-player 发布仓库](https://github.com/yangbin1322/hongguo-player)。该仓库没有公开客户端业务源码。

2026-10-07 补充：排行榜、新剧、日历、预约、推荐四频道、评论/弹幕读取及统一滚动加载的最新实现见 [接口与分页盘点](lists-pagination.md)。下文早期的“待接入”描述保留为研究记录，以最新盘点为当前状态。

2026-10-07 播放操作补充：手动清晰度、评论发表/回复/点赞/本人删除和弹幕发送见 [播放操作](player-actions.md)。回复列表真实匿名读取已验证；账号写入仍只做协议与模拟测试。

2026-10-07 更新：已独立实现完整签名并接入账号登录、MFA 和云同步，见 [账号登录与云同步](account-sync.md)。下文 10 月 6 日专项核对中的“待接入/未复现”描述属于当时状态；真实登录会话验收仍未完成。

## 证据分类

1. 发布版嵌入前端：能够确认前端调用的方法、参数和模型。
2. 二进制符号及字符串：能够确认部分 Go 方法、JSON 标签和 HTTP 路径。
3. 方法定点反汇编及实际请求与响应：用于核对某个方法的接口、参数、签名和组合算法；涉及账号的成功行为仍需真实登录会话验证。

前两种证据不能代替第三种。数据模型存在不代表已确认红果服务端会提供所有对应字段。

## 内部方法

前端通过 Wails 调用 `window.go.app.App.*`，例如：

```javascript
window.go.app.App.SeriesDetail(seriesId)
window.go.app.App.NextSeason(seriesId, seasonIndex)
window.go.app.App.PlayInfo(seriesId, videoId)
window.go.app.App.Danmaku(seriesId, videoId, startMs, endMs)
```

这些是程序内部方法，不是红果公开 HTTP 路由。TV APK 提供对应的本地 HTTP 桥接，Go 核心负责具体网络和本地逻辑。

## 季与集模型

嵌入前端可观察到以下字段：

```text
Episode: index, videoId, title, duration, cover, locked,
         commentCount, likeCount, liked

Series: id, title, cover, intro, tags, episodeCount, episodes,
        watchedEpisode, serializing, startVideoId, startEpisode,
        seasonIndex, multiSeason

SeasonRef: seriesId, firstVideoId, seasonIndex, title, cover
```

前端在本季结束时调用 `NextSeason(series.id, series.seasonIndex || 0)`，若返回有效 `seriesId` 和 `firstVideoId`，再切换播放对象。

二进制包含：

```text
hg-go/internal/app.(*App).NextSeason
hg-go/pkg/service.(*Library).NextSeason
hg-go/pkg/hgapi.(*Client).NextSeason
hg-go/pkg/hgapi/season.go
json:"season_index"
json:"is_multi_season"
```

2026-10-06 补充：已通过 Go `__gopclntab` 恢复函数范围，定点反汇编确认该方法使用注册项 `plan_v`，对应 `GET /reading/bookapi/plan/v`。已在红果 API 主机成功请求并取得真实 `season_index` 关系；该方法内未调用标题解析或搜索。完整请求和验证范围见下方“账号登录与下一季专项核对”。

现有 Lampa 插件已经实现标题规则、搜索建议和详情验证驱动的同系列与下一季。TV APK 现已接入已验证的官方季关系接口，不依赖标题猜测；下面记录实现边界和验收方式。

## 候选上游路径

发布版保留了以下相关路径字符串：

```text
/reading/distribution/category/landpage/v1/
/reading/bookapi/search/tab/v/
/novel/player/video_detail/v1/
/novel/player/multi_video_detail/preload/v1
/novel/player/video_model/v1/
/novel/player/multi_video_model/player/v1
```

这些是分析线索，不是已经测试通过的 Android 接口清单。当前网页分类可用的 `/reading/distribution/category/landpage/v/` 与桌面二进制出现的 `/v1/` 也应分别验证。

## 功能验证表

| 功能 | 已知线索 | 仍需确认 |
| --- | --- | --- |
| 分类、榜单、推荐 | Go 已接入分类 JSON API；找剧动态筛选和游标分页已验证；四个 `/rank/hot-*` 官网真实榜单已提取 | 其它榜单类型、榜单分页仍需扩展验收 |
| 新剧 | 已实测分类 API 的 online_time 排序，男频/女频使用 gender 参数 | 按日期的上新日历、预约状态尚未接入 |
| 搜索 | `Search` 方法、搜索路径 | 远程搜索与本地剧库搜索的组合方式 |
| 详情和集列表 | Go 已解析网页 `_ROUTER_DATA`，已验证完整 `vid_list` 与锁定状态 | 同系列季关系仍需扩展 |
| 下一季 | 签名 `plan/v` 请求、当前季反查及自动跨季已接入；浏览器验证历史、选集、返回及退出竞态 | 更多系列样本、实体 TV 与真实跨季媒体验收 |
| 播放 | APK 内置签名 `video_model`、`spade_a` 解码、CENC AES-CTR 清晰化、MP4 Range 路由已接入并实测 | 清晰度策略和地址过期重试仍需 Android TV 长时间验收；不依赖 8787/57828 回退 |
| 弹幕 | `Danmaku` 及时间段参数 | 实际上游地址、鉴权、颜色、时间基准 |
| 评论、点赞 | 方法与部分 comment 路径 | 读写参数、登录限制、分页 |
| 历史、收藏、进度 | 已实现设备上的持久记录和断点恢复；playing 后写历史，按集保存时间 | 账号数据合并/同步与原版云端删除语义 |
| 登录、预约、下载 | 登录三条 HTTP 路径、主要参数、上行短信分支与会话保存方法已定位；预约/下载仍为前端入口和内部方法线索 | 登录成功会话与云端同步实测；预约/下载完整协议 |

## 请求分析方法

按操作采集：打开详情、打开选集、当前季结束、打开评论、开关弹幕、收藏、登录及退出。对比动作前后的请求，区分缓存命中和真实网络请求。

常规代理只能记录程序实际经过代理的请求；是否使用代理、是否接受其证书需先验证。代理不可见时再评估运行时插桩。不能保证某个工具一定能直接挂钩 Go 方法。

只提交脱敏请求及响应样本。账号凭证、设备身份、原始抓包和媒体文件留在仓库外。

## 账号登录与下一季专项核对（2026-10-06）

本轮只分析发布包并进行无需登录的季关系读取，没有发送验证码、尝试登录或写入账号数据。已发布 APK 的行为仍是本机历史/收藏/点赞和单季自动下一集；本轮没有生成新 APK。

发布包版本为 v1.1.5，通用 Mac 可执行文件 SHA256：`72d00b6af7bb69ea9cfb61344ce4592c9f5ba8c404fde5029aaf89a7713dd22d`。从 x86_64 的 Go 函数表恢复方法地址，核对调用、API 静态注册结构及 Go 反射字段；证据保存于 Lampa 工作区 `tmp/hongguo-account-season-evidence-20261006/`。

### 下一季：已验证真实季关系接口

```text
GET https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/plan/v
```

除设备/应用参数外，`NextSeason` 构造以下查询参数：

```text
scene=10
offset=0
limit=0
from=series_short_play_info
total_chapter_num=0
current_chapter_num=0
post_id=0
is_horizontal_screen=false
bookstore_tab=0
bookstore_tab_type=0
book_id=<当前 series_id>
filter_ids=<当前 series_id>
```

返回 `data:[{video_data:[...]}]`。条目含 `series_id`、`vid`、`season_index`、`episode_cnt`、`disable_play`、`title`、`cover`。当前季在本轮两个样本中被排除。原版方法将非正数的当前季按 1 处理，遍历返回条目，只保留季号大于当前季、集数大于 0、`vid` 非空且未禁播的条目，选择季号最小的一项，映射为 `SeasonRef`；没有候选返回空。

本轮沿用现有播放签名函数生成 `X-Gorgon`、`X-Khronos` 等头，随机设备身份，不带账号 Cookie：

| 当前剧 | 实测结果 |
| --- | --- |
| 万妖图录传第一季 `7621200213801176126` | `code=0`；第二季为 `7628202881140657177`，接口提供的首集 `vid=7628204794481495065` |
| 万妖图录传第十三季 `7690163276214176792` | `code=0`；第十四季 `7691518344146455576` 有季关系，但 `episode_cnt=0`、`vid=""`，应排除；没有可播放的下一季 |

不签名的第十三季请求返回 HTTP 200、空响应体，不能当成“没有下一季”。接口返回失败、无效 JSON、有效响应无候选这三种情况必须分开。此轮只验证季关系和选择规则，未播放第二季媒体，也未验证所有剧都具有服务端季关系。

该接口不返回当前剧自己的 `season_index`。补充实测第二季的关系响应含第一季 `season_index=1`，因此 TV 核心通过另一季的官方关系反查当前剧。当前剧必须以精确字符串 ID 匹配；无法确认当前季时返回错误，不将未知季号当成第一季。此方法保留已稳定的网页详情实现。

本地 `GET /api/v1/series/next-season?series_id=<id>` 返回 `{current_season,next}`，`next` 为精简 Drama 或 `null`。有效空列表代表没有下一季；HTTP 错误、空体、缺少成功状态、错误列表结构、重复 ID 的季号冲突均返回失败。请求总时限 20 秒，并随页面请求的 context 取消。没有永久缓存空结果或失败。

播放器只在当前季最后一集结束后读取完整系列选择器；如果当前季行已提供季号，就按该列表里严格相邻的第 N+1 季处理，从第 1 集、0 秒开始，即使该季已有旧进度。完整列表中的待上线季优先进入预约流程，不能被关系接口跳过。只有当前季行缺少季号时，才调用关系接口补当前季号，并仍从完整季列表确定下一季。完整列表读取失败、存在季号缺口或关系接口无法补齐未知季号时安全暂停自动跨季。当前选集面板若打开，会更新为下一季的标题、完整集列表、继续按钮与高亮。

已验证：Go 真实上游第一季 → 第二季、第十三季 → `next:null`；测试 fixture 覆盖禁播/零集/空首集、未知当前季、签名、ID 精度、响应异常、重试和取消。浏览器使用真实官方详情、VID 和季关系，媒体替换为 Range 测试 MP4，验证第一季第 81 集自然结束 → 第二季第 1 集，分剧历史、第二季选集和继续按钮、高亮、原卡片返回及向右移动。也验证请求延迟期间退出页面、退后台后回前台均不会自动起播，API 失败会暂停连续播放。尚未宣称完成实体 TV 或真实 CENC 跨季长播放验收。

### 登录与账号同步：定位到具体协议，尚未登录实测

用户提供的界面确认“手机号 + 验证码”，以及可能出现的上行短信验证弹窗。发布包中的 API 注册表和 `flow/login.go` 调用关系与之吻合：

| 功能 | 内部方法 / HTTP 路径 |
| --- | --- |
| 获取验证码 | `App.SendCode(phone)` → `Login.SendCode` → `POST /passport/mobile/send_code/v1/` |
| 短信登录 | `App.Login(phone, code)` → `Login.LoginFull` → `POST /passport/mobile/sms_login/` |
| 上行短信验证 | `Login.UpsmsVerify` → `POST /passport/upsms/verify/` |
| 当前用户 | 静态注册项 `user_info` → `GET /reading/user/info/v1/` |
| 历史读取 / 更新 | `GET /reading/bookapi/read_history/list/v`、`POST /reading/bookapi/read_history/update/v` |
| 进度读取 / 上传 | `POST /reading/bookapi/read_progress/get/v`、`GET /reading/bookapi/read_progress/list/v`、`POST /reading/bookapi/read_progress/upload/v` |
| 收藏读取 / 更新 | `GET /reading/bookapi/bookshelf/video/list/v`、`POST /reading/bookapi/bookshelf/video/update/v` |

发送验证码的字段包含 `mobile`、`type`、`mix_mode`、`auto_read`、`account_sdk_source`、`passport_support_flow`、`unbind_exist`。手机号加 `+86` 后调用 XOR 编码；静态注册说明指定 XOR `0x05` 后转 hex。短信登录还包含编码后的 `code`，MFA 重试添加 `passport_mfa_retry_tag` 和 `sms_code_key`。这些参数已在注册表及方法指令中定位，不能将表单替换成只有手机号/验证码的 JSON 请求。

`parseMFA` 解析 `encrypt_uid`、`sms_code_key`、`mobile_ticket`、`passport_scene` 以及验证方式里的 `sms_content`、`channel_mobile`。界面监听 `auth:mfa`，显示 `sendTo` 和 `content`。发送目标还可能被原版远程配置 `login.upsms_number_fix` 调整，因此不能把截图里的号码和 `YZ` 写死到 TV APK。

`LoginFull` 首次调用短信登录，收到 MFA 要求后提示用户，并调用上行验证；默认间隔 3 秒、最多 30 次，等待状态线索为 `error_code=1045`。验证通过取得 ticket 后再次短信登录。成功链路调用会话 Cookie/Token 捕获及 `Store.SaveAccount`；后端持久化与界面“下次启动自动恢复”一致。

登录接口注册的签名模式是 0，季关系/历史等注册为模式 1。数值本身不说明两种模式等价；当前播放签名成功不能证明登录签名已满足要求。登录主机选择、设备身份、完整头/表单、MFA ticket 和会话恢复，以及云端进度/收藏读写仍需真实会话验证。这里的静态 `WithSession=false` 也不能理解成历史/收藏无需账号：通用发送函数仍会附加已保存的 Cookie 和 `x-tt-token`。

进一步定点分析 `SignMode.String` 确认 0 为 `full`、1 为 `minimal`、2 为 `registration`。原版 `Signer.Sign` 的 full/minimal 均调用 `HeliosFor` 与 `BuildMedusaFor`，full 还调用 `xgorgonWith`，`Values.Headers` 映射为 `X-Helios`、`X-Medusa`、`X-Gorgon` 等头。TV 当前签名不包含前两项，不能将季关系请求成功扩大为账号登录验证成功。相关算法还涉及设备 protobuf、哈希变换及自定义 AES；公开搜索未取得可直接复用并校验的本地实现，发现的外部签名服务不作为本 APK 的依赖。本轮未启用未经验证的登录入口，也没有发送验证码或写入任何红果账号。

账号同步接入还需明确本机与云端的合并、失败重试、取消收藏及切换账号行为；当前本机“清空历史/收藏”不能直接改成删除云端数据。

## 排行榜与新剧页面（2026-10-06）

本地 `GET /api/v1/rank?path=/rank/hot-drama` 支持 `hot-drama`、`hot-real-drama`、`hot-comic-drama` 和 `hot-ai-drama`。官网普通 UA 的榜单内容可能为空，本次以 Googlebot UA 实测返回 `_ROUTER_DATA` 中 `content.rankList`。这是一条当前可用的网页数据路径，不等于已复刻 Mac 客户端全部榜单接口。

本地 `GET /api/v1/category?path=/new/recommend` 复用分类 JSON API，只将排序设置为 `online_time`。返回最新列表不表示其中所有剧都在今天上架，因此上新日历只提供日期条和待接入状态，不把新剧列表分配到任意日期。

分类 API 的 HEIC 封面无法由 Chromium / Android WebView 直接显示。本次实测四张封面在官网图片 CDN 的 `/novel-pic/<object>~tplv-shrink:640:0.image` 上返回 JPEG；模型同时保留 `cover` 和 HEIC 专用 `cover_fallback`，普通签名图片地址不变。

本轮验证覆盖 Go 测试与 vet、JS 语法、真实四个热播榜和最新剧 API、1920×1080 / 1280×720 浏览器焦点路径、详情关闭与播放返回、海报加载。Android TV 实体遥控器和长时间播放验收仍未进行。

## 找剧筛选（2026-10-06 实测）

继续使用客户端分类 JSON 接口 `POST /reading/distribution/category/landpage/v/`。请求 `need_selector_panel=true`、`req_type="default"` 时，响应 `data.selector_rows` 提供各组的 `type`、`row_name` 和 `items[].selector_item_id/show_name`，同时返回第一页内容。`only_content` 不返回面板，`req_type="all"` 实测返回空内容，不能用它请求完整面板。

| 维度 | select_items 字段 | 已验证的示例值 |
| --- | --- | --- |
| 体裁 | genre | short_play / comic_series / ai_series |
| 主题 | category_dim_theme | cate_165（悬疑） |
| 设定 | category_dim_role | cate_36（重生） |
| 背景 | category_dim_epoch | cate_758（古代） |
| 推荐 | sort | hot_score / online_time / hot_collect |
| 受众 | gender | 1（男频）/ 0（女频） |
| 时间 | online_time | days_7 / days_14 / days_30 / days_90 |
| 状态（漫剧）| creation_status | creation_status_0（已完结）/ creation_status_1（连载中） |

选项由上游面板生成，不维护网页 slug 到客户端标签 ID 的猜测映射。真人剧/全部面板实测 7 组，主题 29 项、设定 42 项；漫剧面板实测 8 组，主题/设定各 8 项，并增加状态。AI剧实测 7 组。Mac 截图中的长度条件尚未取得已验证的参数，不提供虚假按钮。

选择“全部”传递空数组；特别是 `genre=[]` 才表示全部体裁。省略字段与显式空值有区别：现有频道仍保留默认体裁和热度排序，找剧页面则明确传入所选条件。选择体裁时同步切换 `req_scene`；主题、设定、背景、状态清空后重新请求面板，避免沿用其它体裁的标签。

本地 `/api/v1/category` 增加与表中同名的单值查询参数，以及 `selectors=1`。返回 `filters:[{type,label,options:[{id,label}]}]`。不合格式的筛选值返回 400。分页继续传上次的 `next_offset`、`session_id` 与已显示的字符串 ID 列表 `shown`；客户端追加、去重并在游标不前进时停止继续请求。

实测悬疑、重生、古代、男频、女频、7 天内上新、最高收藏、漫剧、AI剧均返回不同的有效内容；悬疑第二页返回 15 个新条目。UI 验证追加后原卡片 DOM 保留。关键词搜索仍使用已确认的官网搜索实现，单独展示结果，筛选条件不假装作用于关键词搜索。

## 本机记录（2026-10-06）

本地 `GET /api/v1/library` 读取记录；`POST` 的 `action` 支持 `progress`、`favorite`、`like`、`remove`、`clear`。移除和清空以 `kind=history/favorites/likes` 分别处理。历史、收藏与点赞不再按数量截断；仅保存精简卡片与当前集的 ID、时间，不复制完整集列表。当前集 ID 单独存为 `video_id`，重新播放仍按详情解析第一集，避免将上一集误当作第一集。

Android 使用应用私有 files 目录下的 `hongguo-tv/library.json`，与可清理的视频 cache 目录分开；Go 通过临时文件落盘后替换，失败时不公布新状态。桌面验证可通过 `-data-dir` 指定隔离目录。本机收藏/点赞尚不代表红果账号的云端状态。

本轮浏览器使用真实分类、详情和集 ID，媒体响应替换为支持 Range 的测试 MP4，验证实际开始播放才记历史、暂停保存、服务重启恢复、断点 seek、自然结束后的下一集及整季结束重播第一集。也验证两种分辨率的网格导航、清空确认默认取消、逐卡移除后的焦点以及播放返回原卡片。此轮没有新增 Android TV 真机遥控器或真实 CENC 长时间播放验收。

## 播放控制（2026-10-06）

进度、倍速、音量、全屏和控件隐藏由当前视频组件实现，不增加上游请求。实际清晰度来自现有 `play/info` 响应的 `quality`；当前自动选择清晰度，尚未扩展手动选择和切换清晰度的解析协议。后台状态同时接收 WebView 的 visibility 和 Android 生命周期桥接，解析返回时检查前台状态，避免后台自动开始播放。

本轮采用隔离的推荐卡片 fixture、真实详情与集 ID、Range 测试 MP4；验证 10 秒跳转与首尾边界、两行控制区的遥控器路径、倍速/音量保存及重载恢复、面板焦点约束、控件自动隐藏、浏览器全屏及返回顺序、失败重试、解析中后台暂停、下一集后继续按钮与高亮更新，以及播放返回历史卡片后继续移动。1280 和 1920 宽的浏览器页面检查了控件边界和简介间距。Android 返回/媒体键和生命周期代码由 Actions 编译验证，未宣称完成真机操作和长时间播放验收。


## Mac v1.1.6 系列剧选择器（2026-10-07）

新增 `SeriesSeasons` 调用 GET `/reading/bookapi/plan/v`，`from=single_col_same_ip_series`、scene=10、limit=0。原版模型包含 seriesId、firstVideoId、title、cover、label、sub、upcoming、reserved。匿名真实响应可取得《万妖图录传》完整14季（包括当前第13季及待上线第14季）。预约ID来自 `subscribe_item.item_id`，不能把预告ID用于播放。自动跨季现以完整选择器为准，`from=series_short_play_info` 仅用于补齐缺失的当前季号，不再作为必须成功的前置请求；完整参数、映射、TV焦点和验证范围见 [系列剧说明](series-seasons.md)。
