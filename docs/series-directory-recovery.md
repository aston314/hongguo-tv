# 完整分集目录恢复（2026-11-27）

## 根因与实现

官网详情页 `https://hongguoduanju.com/detail?series_id=...` 的
`_ROUTER_DATA.loaderData.detail_page.seriesDetail` 仍报告完整 `episode_cnt`，
但实测 `accessible_episode_cnt=3`、`vid_list` 仅含前三集，且 ID 已变为
`v1_...` 网页专用 ID。不是 UI 限制了选集数量，也不是播放模型请求只能返回三集。

Android、桌面共用的 Go core 和 webOS 独立 Node provider 均作相同处理：

1. 官网返回完整、唯一的数字 VID 目录时，保持原路径，不增加请求。
2. 官网只返回预览、含非数字 VID 或读取失败时，使用现有 Passport 签名请求
   `POST /novel/player/multi_video_detail/preload/v1`，从
   `data[seriesID].video_data.video_list` 补齐真实数字 VID。
3. 请求体为 `dr_scene=preload`、目标 `series_id`，以及现有详情 `biz_param`：
   `detail_page_version=0`、`source=7`，其余布尔项为 false。
   使用独立匿名身份，不读取用户账号 Cookie、不借用播放注册身份、不写入账号。
4. 严格校验 `code=0`、目标系列身份、明确的 `episode_cnt`、完整列表长度、
   `vid_index=1..N`、唯一数字 VID 和 `has_more`。拒绝错剧、重复、漏集和部分目录。
   19 位 JSON 数字保留为精确字符串，不能经过浮点转换。
5. 只替换目录和集数，保留官网片名、简介、评分、演员、剧评和相关推荐。
   官网不可用时使用 App 元数据。App 的显式 `disable_play` 保留为禁播标记。
6. 完整目录补全失败时明确报错，不把三集预览当作成功。未上线的零集详情保留；
   创作者专辑 `1003` 继续走原独立目录接口。

官网读取最多 6 秒，整个详情请求最多 20 秒。取消、超时和错误均清理请求及定时器，
不继续启动补全请求。没有改动播放器、媒体解码或在线 JS/JSON 播放规则。

## 实测证据

默认 `api5-normal-sinfonlineb.fqnovel.com` 和独立探测的 `api5-normal-lq.fqnovel.com`
均能返回完整目录。生产实现使用现有 API 主域，没有新增公共代理或第三方取源服务。

| 剧集 | 系列 ID | 官网目录 | 补全目录 | 实测后续集 VID |
| --- | --- | ---: | ---: | --- |
| 二嫁有喜 | 7687919221593885758 | 3 | 76 | 第4集 7687921227100343358 |
| 全球死考：刚下刑场你让我去考试第六季 | 7704857878514895896 | 3 | 193 | 第153集 7704857946630409240 |
| 万妖图录传第十三季 | 7690163276214176792 | 3 | 209 | 第209集 7690223312324332569 |

Go 生产链路依次测试首集、第4集、另一部剧第153集、另一部剧第209集、再切回首集。
五次均取到兼容源，完整下载、按需解密，经 FFprobe 确认 HEVC 与音轨，
FFmpeg 完整音视频解码通过。该轮取源耗时 165–615 ms（不含目录、下载和解码），
不代表设备首帧速度或所有上游请求的耗时保证。

webOS 生产 provider 使用内置 JSON 参数配置，独立测试第4、153、209集，
三次均完整下载、解密与解码通过：

| 集数 | 实际分辨率 | 媒体大小（字节） | 时长（秒） |
| --- | --- | ---: | ---: |
| 二嫁有喜 第4集 | HEVC 1080×1920 | 9,566,066 | 114.633 |
| 全球死考 第153集 | HEVC 1920×1080 | 2,887,938 | 40.519 |
| 万妖图录传 第209集 | HEVC 1920×1080 | 4,702,416 | 62.485 |

这是本机真实上游/媒体验证，不等于 Android 电视、Windows、Linux 或 LG 实机播放验收。
上游状态可能继续变化；不会将本轮成功概括成所有剧、所有清晰度永久可播。

## 重现与回归

```sh
go test ./...
go test -race ./core/cmd/hongguotv -run 'Test(AppSeriesDirectory|SeriesDirectory|SeriesDetail)'
node --test tests/webos-series-directory.test.cjs
./scripts/verify_webos.sh

# 显式启用真实网络、完整下载和本机 FFmpeg 解码；无需登录。
HONGGUO_LIVE_SERIES_DIRECTORY=1 go test ./core/cmd/hongguotv -run '^TestSeriesDirectoryLivePlayback$' -count=1 -v
HONGGUO_LIVE_SERIES_DIRECTORY=1 node scripts/verify_series_directory_webos.cjs
```

live 检查使用隔离临时目录并清理媒体，不输出签名播放地址、密钥、Cookie 或原始响应。
webOS 目录模块同时在 Node 0.12.2 和 8.12.0 下验证，并加入 CI 的旧运行时检查。

回归覆盖：网页完整时不增加请求、三集预览补全、错剧拒绝、完整性与精确数字 ID、
显式禁播、元数据保留、官网失败后 App 详情可用、未上线零集详情，以及请求取消/超时。
