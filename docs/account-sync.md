# 账号登录与云同步

2026-10-07。独立 Android TV APK 的账号能力由内置 Go 核心提供，不依赖 8787、57828 或其它签名服务。

## 使用方式

侧栏进入“我的 / 登录”，输入手机号并获取验证码，填写验证码后登录。首次发码前会先匿名注册设备并保存返回的设备身份；注册失败不会继续发码，重试或重启复用已保存的身份。确认发码成功后显示重发倒计时，可以“换手机号”。HTTP 403 等明确拒绝不会显示假重发倒计时；限流遵守上游等待时间，网络超时或响应不完整则保留防重复发送等待，显示“秒后可重试”。红果如果要求进一步短信验证，页面展示本次响应中的收件号码和短信内容；使用登录的手机号发送后，选择“我已发送”。每 3 秒检查一次，最多等待 90 秒，可以取消或按返回。没有写死截图中的号码或短信内容。

登录成功后可查看当前账号及云同步状态，左右键可在账号和同步两栏之间切换。“立即同步”主动触发一轮同步，退出前有确认弹窗。验证码错误、接口失败、验证等待和同步失败分别显示，不把等待或 HTTP 200 当作成功。

登录成功以 Passport 短信登录 / MFA 重试的明确成功响应、有效且一致的账号 ID、会话 Cookie / Token 为依据。立即保存成功会话后再异步同步；同步服务异常只显示在同步状态中，不要求再次输入已经使用过的验证码。

## 记录与合并

- 未登录时继续使用原 `library.json`。登录后使用 `accounts/<uid>/library.json`，不同账号互相隔离；登录前的记录不会自动上传。退出后返回原本机记录，再次登录同一账号会恢复该账号的待同步队列。
- “我的”提供手动“合并登录前记录”，按观看更新时间合并历史与进度；原游客记录保留，使用持久导入标记避免重复加入和删除后复活。详见 [合并登录前观看历史](guest-history-import.md)。
- 云端收藏、历史、进度通过官方接口读取。历史沿用原版 limit=0，每批最多 500 项，按服务端游标读取全部分页；缺失游标时按原版步长 500 前进，重复/空且仍有更多的页、200 页上限或结构错误会报告同步未完成。缺少剧名时通过签名的 multi_video_detail/preload JSON 接口每批 20 项补全；明确遗漏的详情保留收藏身份和“信息暂未加载”状态，不因一个网页失效阻断全库。进度每批最多 200 个 ID。历史、收藏/点赞不设本机总量上限；完整合并云端记录，每次滚动显示 20 部。接口批次和异常分页保护不等于显示上限。
- 批量详情中的创作者合集（`content_type=1003`）直接用 `video_data.series_id[_str]` 标识，不要求搜索接口才有的 `album_info`。同时兼容搜索的嵌套合集资料并核对所有已返回 ID；批量接口的 `episode_cnt=0` 仅表示集数未知，完整目录仍由合集专用接口读取。
- 单条详情缺少剧集 ID 或与请求 ID 不符时，仅丢弃该条资料，保留已有剧名、封面或待加载占位，后续同步重试补全；同批正常资料、历史合并及待上传操作继续处理。不会用错误 ID 的资料覆盖记录，也不放宽账号、完整列表及写入确认校验。
- 同步先完整读取云端，再按观看更新时间合并。本机未上传的收藏操作优先保留；云端进度较新时舍弃对应旧进度操作，本机更新较新时再上传。设备时钟应正常，判断不依赖标题或集号大小。
- 取消收藏及收藏列表里删除单项会提交云端取消收藏。清空本机列表、删除本机历史不批量删除云端；使用本机排除标记防止下次立即重现，最多保留 2000 个标记，超限淘汰最早的标记。再次播放或收藏会解除对应排除标记。当前集真实点赞、取消和账号点赞列表已接入，协议与真实验证见 [短剧点赞](video-likes.md)。
- 同一剧的同类操作合并为最新待上传记录，最多 2000 项。本机记录和队列原子保存；历史及进度两次上报都确认成功后才清除该进度操作。同步失败、写盘失败、旧请求确认不会丢弃更新的操作。自动同步在记录变化后延迟 2 秒触发，另每 90 秒检查一次；单轮总时限 3 分钟。
- 页面写入携带当前 owner，服务器拒绝其它账号的迟到写入；退出取消当前同步，旧登录/同步回复不能恢复已退出的账号。

## 已核对的上游协议

主机 `https://api5-normal-lq.fqnovel.com`。从 Mac v1.1.5 的静态 API 注册表、定点反汇编和 Go 反射标签核对：

| 功能 | HTTP 接口 |
| --- | --- |
| 获取验证码 | POST `/passport/mobile/send_code/v1/` |
| 短信登录 | POST `/passport/mobile/sms_login/` |
| 上行短信验证 | POST `/passport/upsms/verify/` |
| 阅读资料（不用于认证） | GET `/reading/user/info/v1/` |
| 历史读取 / 更新 | GET `/reading/bookapi/read_history/list/v` / POST `/reading/bookapi/read_history/update/v` |
| 进度读取 / 上传 | POST `/reading/bookapi/read_progress/get/v` / POST `/reading/bookapi/read_progress/upload/v` |
| 收藏卡片批量详情 | POST `/novel/player/multi_video_detail/preload/v1` |
| 收藏读取 / 更新 | GET `/reading/bookapi/bookshelf/video/list/v` / POST `/reading/bookapi/bookshelf/video/update/v` |

手机号加 `+86` 后 XOR 0x05、hex 编码；验证码同样编码。MFA ticket 后重试短信登录。`vid_index` 按一基集数，UI 的秒转换为上游毫秒。所有 19 位 ID 在 Go/页面保持字符串，上游要求数字的字段用 `json.Number` 编码，避免 float64 丢精度。

历史响应使用 `data.data_list`、`has_more`、`next_offset`；收藏使用 `data.video_shelf_info[].series_id`。进度读取支持原版的顶层 `video_data`，不强制包在 `data` 内。更新必须明确 `code=0`，同时拒绝内部 `error_code` 非零。

签名包含 SM3、F13 branch2、modified MD5、Helios/SPECK、modified RC4 Gorgon、protobuf、XMXOR 和 AESV3/Medusa。以 `_rticket` 毫秒值选择 branch2，四种 AESV3 timestamp 分支均有固定向量测试。协议静态常量与发布版二进制核对；实现独立于已经稳定的媒体解析签名。没有把外部参考 Python 或发布版二进制纳入 APK。

会话以 0600 原子写入 `account.json`，只保留掩码手机号，不保存验证码。账号/记录接口限制回环连接、回环 Host 和同源页面访问，不使用 wildcard CORS。Android 禁用应用备份。退出清除 Cookie/Token，保留稳定设备身份及该账号记录。

## 设备注册与 HTTP 403 修复

2026-10-07，真实预览发现验证码接口空体 HTTP 403。定点反汇编 Mac v1.1.6 的 `deviceBootstrap`、`register.Client`、`device.AppHeader` 和 `TTEncryptV5` 确认：随机生成的 device_id/iid 不等于可用于 Passport 的已注册身份。匿名对比实测中，注册后同一接口进入 HTTP 200 / error_code=1003 的缺少参数分支。

- 注册主机 `https://log.snssdk.com`，POST `/service/2/device_register/`，`application/octet-stream;tt-data=a`，TTEncrypt V5（gzip、SHA-512 校验、派生密钥、AES-128-CBC）。注册请求不含手机号、验证码、账号 Cookie 或 Token。
- 身份种子 CDID、ClientUDID、OpenUDID 稳定保存；响应严格解析 JSON，支持加密响应，数字 ID 使用 `json.Number` 防止丢精度。只有返回有效的 device_id 和 install_id 并成功保存后，才允许提交验证码请求；不会回退到随机 ID。
- Passport 请求使用注册返回的身份、区域信息，以及核对后的 SDK/BDTuring 请求头。注册与登录沿用当前签名的应用/设备参数；没有修改媒体解析签名或加入其它服务回退。
- 取消注册/登录后，迟到回复不能触发后续发码或恢复旧账号。网络结果不确定时保留发送保护，明确拒绝与服务限流分别处理。
- 独立 Python hashlib/gzip + OpenSSL 固定向量验证设备加密；fixture 验证注册先后顺序、持久保存/重启/退出、失败阻止发码、取消以及计时状态。

## 验证范围

### 短信提交后的身份误判修复

2026-10-07，用户已收到短信，提交验证码后出现“账号会话已失效或身份不一致”。该提示来自本项目 `finishLogin` 中额外的 Reading 资料接口比较，并非发码接口失败。没有读取或记录用户真实登录响应，不能据此断言具体返回 ID 或上游原因。

Mac v1.1.6 `service.Auth.Login` 的静态链路是 `LoginFull` → `Session.SetUID` → 捕获 Cookie / Token → `SaveAccount`，没有 Reading 资料校验门槛。匿名注册设备后，只读请求 Reading 资料接口即返回 `code=0` 和资料字段，说明它的成功状态不能证明账号已登录。移除登录和同步中的这项错误认证依赖，未换用未经账号实测的认证接口。

登录仍拒绝失败响应、缺失 / 零 ID、同一 Passport 响应中数值和字符串 ID 不一致、缺失会话凭证及取消后的迟到回复。同步检查本机账号记录归属及凭证，通过实际历史 / 收藏 / 进度接口的明确成功状态读取和写入；任一步失败或响应结构无效均停止合并和上传，保留本机记录与待上传队列。不能把本机归属检查描述为上游会话身份验证。

新增 fixture 覆盖 19 位 ID 精度、有效 Passport 登录不被无关资料接口否决、同步失败不撤销登录、会话过期 / 嵌套业务错误禁止合并与上传。没有重发或复用截图中的真实手机号 / 验证码；真实登录及跨设备云同步仍由用户在更新后验证。

Go race/vet、签名固定向量、登录/MFA fixture、双向同步字段、进度冲突、失败保留队列、账号隔离、退出取消和写盘失败测试已完成。浏览器验证 1280×720 与 1920×1080 的账号界面、输入删除、方向键、等待/取消及退出焦点。

只读匿名用户接口返回 `code=0`；本次真实匿名注册成功，缺少手机号的 Passport GET 和 POST 均返回 HTTP 200 / error_code=1003。两次请求均没有短信目的号码，不能代替真实发码/账号登录验收。没有自动重发用户截图中的手机号，也未登录或写入真实账号；实际手机号的风控/MFA、真机网络、上行短信号码及跨设备云同步仍待用户在 APK 中验证。验证码只在 APK 输入，不需要发送到聊天。

本地浏览器 fixture：`HONGGUO_ACCOUNT_UI_FIXTURE=1 go test ./core/cmd/hongguotv -run TestAccountBrowserFixture -v -timeout 30m`，访问 `http://127.0.0.1:18797/`。仅测试文件提供此入口，不进入 APK；测试手机号/验证码与短信内容是 fixture，不能用于真实登录。
