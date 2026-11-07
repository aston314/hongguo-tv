# 找剧：猜你想搜与热门搜索

在最近搜索与分类筛选之间增加轻量文字区：最多四个推荐词，短剧／漫剧可用榜单各六条，两列三行。搜索提交后收起，回到分类浏览时恢复。热搜剧集沿用现有播放入口；只有关键词的推荐词执行搜索。整行焦点即时高亮，不使用动画。

## 接口证据

参考 openhongguo SDK `HotSearch` 的公开协议（参考提交 `42b73f201309423f012d483bfc0ce579dcc0937c`），使用项目已有签名和客户端实现，未引入 SDK 依赖。

- 上游：`GET /reading/bookapi/plan/v1/`，`from=search_input_page`、`bookstore_tab=16`、`search_middle_page_version=4`、`user_is_login=0`，其余参数见 `searchDiscoveryQuery`。
- App 契约：`GET /api/v1/search/discovery` → `{ok:true,data:{guesses:[],boards:[{id:"short"或"comic",items:[]}]}}`。
- 支持 `lynx_data` 的字符串／数组形式、`cell_data` 内的具名热搜榜，以及当前 `热搜榜` 按明确 `content_type` 分类的结构。`search_tag_data.tag_title` 作为关键词，不将 tag ID 冒充可播放剧集 ID。
- 2026-11-07，Go 与 webOS 两套真实请求均取到三条推荐、六条漫剧热搜；该次上游只返回漫剧榜，因此不显示短剧空榜。榜单和顺序以实际响应为准，忽略预约、图书、话题等非目标区块。

## 隔离与回退

此功能是匿名元数据读取。Go 请求清除账号 token、UID 与账号 Cookie，不发送搜索历史；webOS 使用既有匿名签名客户端。独立合并并发请求，成功缓存十分钟，失败／空结果缓存一分钟，单次请求设置六秒超时。页面不等待它，失败隐藏该区，原搜索和分类继续工作。

离开页面或提交搜索后，迟到结果不重新打开热搜。播放返回时保留缓存节点和原焦点；榜单切换保留按钮焦点。未改变播放地址解析、解码器或账号写入流程。

## 验证

- Go 解析、签名、账号凭证隔离、并发合并和取消／代际测试；`HONGGUO_LIVE_SEARCH_DISCOVERY=1` 可显式运行匿名真实读取检查。
- JavaScript 缓存、隐藏、迟到响应与播放返回缓存测试；webOS 解析、签名请求和 HTTP 路由检查。
- 同一 UI 的离线夹具验证两榜、两列三行、榜单切换、关键词搜索、播放返回焦点、慢响应切走和错误隐藏。960／1280／1920 宽视口及旧 WebView API 兼容夹具无横向溢出。
- 浏览器真实环境验证上游内容显示。未据此宣称 Android／LG 真机播放通过；Android 构建与 lint 由 GitHub CI 执行。

离线夹具：`HONGGUO_SEARCH_UI_FIXTURE=1 HONGGUO_SEARCH_FIXTURE_DATA=/tmp/hongguo-search-fixture go test ./core/cmd/hongguotv -run '^TestSearchBrowserFixture$' -count=1 -timeout=2h -v`。通过 `/fixture/control?discovery_fail=1` 或 `discovery_slow=1` 验证降级与迟到响应；`?legacy=1` 启用旧 WebView 兼容夹具。
