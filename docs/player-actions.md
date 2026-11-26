# 播放操作与评论面板

2026-10-07。独立 TV APK，Android 壳与 Go 内置核心；APK 在 GitHub Actions 构建。

## 当前行为

- 清晰度面板只展示当前视频模型实际提供的兼容 MP4 档位及“自动”。自动策略仍优先选择不高于 720P 的最高档位。切换时暂停原视频，解析成功后恢复原时间与播放/暂停状态；解析失败保留原地址。关闭面板、离开页面或退到后台取消等待，迟到结果不会替换视频或自动播放。
- 清晰度偏好保存在设备上；下一集实际开始解析时才请求该档位，不预解析媒体。下一集缺少该档位时使用自动策略并提示。不同档位缓存独立，仍受既有 TTL 和总容量清理约束；失败可重新解析。
- 暂停超过 30 秒后，若原媒体地址在恢复时已经失效，先保留暂停状态并等待用户按播放，再为当前集和当前位置刷新一次播放地址；MPV 也只允许这一次有界刷新，普通媒体错误不会重启播放会话。后台返回仍保持暂停。
- 评论采用 Mac 参考图的右侧栏布局：头像、作者、正文、时间、右侧爱心与计数、回复及展开回复，底部固定输入区。视频与控件为评论栏留出宽度。主评论、楼中楼分别保留服务器游标，追加不重建原节点。
- 评论点赞成功后更新状态和计数；发表、回复、发弹幕要求登录。弹幕时间固定为打开输入面板时的当前集 VID 与毫秒位置，输入过程中换集会关闭面板，避免发到错误的集。
- 发送失败保留输入，发送成功提示“审核通过后显示”，不伪造已经公开的评论或回复数，也不自动重试写请求。退出面板取消等待；重新打开恢复当前剧/集的草稿，最多保留 20 份内存草稿。切换账号清除草稿。
- 删除仅向实际账号 UID 对应的本人评论提供入口，确认默认取消。成功后焦点落到邻近评论；不能用 `user_action.author` 判断归属，该字段表示剧作者关系。
- 遥控器上下移动评论与回复，右键进入点赞、回复、展开、删除等操作；输入区上下键进出，左右、空格和退格保留输入行为。返回关闭面板并恢复入口焦点。新评论操作按钮最小高度 44px。

原有暂停、进度、选集、倍速、音量、全屏和收藏保留。后续当前集真实点赞与账号点赞列表已接入，见 [短剧点赞](video-likes.md)；未添加下载管理器、分享、关注写入或打赏。

## 接口与证据

| 操作 | 本地接口 | 上游请求 |
| --- | --- | --- |
| 清晰度 | GET `/api/v1/play/info?series_id=…&vid=…&quality=1080P` | 既有签名视频模型、spade_a、CENC 解密链路，按实际档位选源 |
| 发表/发弹幕 | POST `/api/v1/player/action`，action=`comment`/`danmaku` | POST `/novel/commentapi/comment/add/v1/` |
| 回复 | 同上，action=`reply` | POST `/novel/commentapi/reply/add/v1/` |
| 评论点赞/取消 | 同上，action=`comment-like`、value 布尔 | POST `/novel/commentapi/comment/do_action/v1/` |
| 删除本人评论 | 同上，action=`comment-delete` | POST `/novel/commentapi/comment/del/v1/` |
| 回复分页读取 | GET `/api/v1/replies?series_id=…&vid=…&comment_id=…&cursor=…` | **POST** `/novel/commentapi/reply/list/{comment_id}/v1/`，JSON body |

写请求共用字符串 `series_id`、当前集 `vid`；回复/点赞/删除额外提供 `comment_id`。评论/回复最长 500 个 Unicode 字符，弹幕最长 100；弹幕用 `offset_ms`。本地接口限定同源回环请求、严格 JSON 和 8192 字节大小，并检查账号 generation。大整数 ID 全程保持字符串。

发表评论 `commit_source=3,group_type=30,data_type=4`；回复 `commit_source=9`；弹幕 `commit_source=1500,data_type=20`，business_param.offset 为毫秒。评论点赞 object_type=8、comment_type=4，action_type=8/9。删除 service_id=4、data_type=4。发布成功必须同时确认 code=0 与真实返回 ID；回复 ID 从 `data.reply.reply_id` 读取。

回复列表的来源参数与主评论不同：JSON body 为 `comment_source=504,server_channel=18,comment_type=4,group_type=30,count=10`，并发送同值的 `comment-source`、`server-channel` 请求头。business_param 包含 need_count 与 book_id。GET 或只传 query 会返回 103001，不能当作暂无回复。分页信息为 `data.comment_list_info`，数据为 `data.reply_list`，原始回复正文对象名是大写 `Common`。

以上协议从 Mac v1.1.5 静态注册表、反汇编和 Go JSON 类型核对。匿名真实只读请求已确认回复接口 code=0：返回 10 个原始条目，其中 7 条有可展示的正文，total=20、has_more=true。没有向真实账号发送评论、弹幕或点赞/删除请求。

## 验证与限制

Go 测试覆盖写协议、签名、字符串 ID、毫秒、成功确认、字符限制、游客拒绝、严格 JSON、账号切换迟到回复、本人 UID 判断、回复分页及清晰度档位/缓存键。Node 共用分页测试继续适用。

隔离浏览器使用模拟账号接口和 Range 测试 MP4，验证评论 20→40 保留 DOM、回复 20→35、点赞与删除后的焦点、失败保留输入、迟到发送不清新草稿、游客无写请求、输入退格/空格，以及暂停和播放中的清晰度切换、失败、取消、离开页面与后台状态。1280×720 和 1920×1080 检查评论栏与播放器布局。

真实账号发布/点赞/删除、风控与审核、实体 Android TV 输入法和遥控器、真实视频清晰度切换及长期播放仍需 APK 验收；模拟接口与 GitHub 编译不能代替这些验证。
