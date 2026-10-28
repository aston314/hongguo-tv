# 桌面下一集完整檔案快取

桌面版沿用同季、相鄰集的 Range 索引預取，在目前這集已完整緩衝時，額外嘗試將下一集的已準備來源存成完整檔案。換集只接管已完成的檔案；尚未完成時立即保留原來的 Range 來源，不等待背景下載。

## 與既有預取的差異

原有流程已提供簽名來源解析、Range 索引、共享準備任務、獨立等待者取消與最多 1.2 秒的前台接管等待。webOS 還有最多兩個來源、合計 4 MiB 的開頭分塊快取。本功能只補桌面完整檔案，不替換上述功能，不啟用第二個 video。

- 桌面宿主以 `-desktop-episode-cache` 啟動核心，才註冊 `POST /api/v1/play/cache`；核心預設關閉。共享頁面只有存在 `window.HongguoDesktop` 時才設定此選用回呼。Android 與 webOS 的預取策略維持原狀。
- 沿用連續穩定播放時間、相鄰集、鎖集與帳號／清晰度／播放代次隔離規則。
- 目前集為已完成的完整檔案，或 `buffered` 中一個連續區間涵蓋目前位置至片尾（容許 0.25 秒尾端誤差），且未暫停、跳轉、緩衝時，才可開始。
- 下一集必須已成功準備 Range 來源。索引準備失敗不另啟動整集解析；前台仍使用既有 Range 失敗後的完整檔案回退。

## 資源與取消

| 項目 | 邊界 |
| --- | --- |
| 單檔大小 | 已知長度最多 64 MiB，開始前檢查；較大來源保留 Range |
| 並行下載 | 全核心最多一個選用完整檔案下載；相同來源可共用任務 |
| 請求分塊 | 沿用 512 KiB Range 讀取、ETag／長度驗證與 CENC 分段解密 |
| 嘗試次數 | 每個前端播放上下文一次，取消或失敗後不循環重試 |
| 時限 | 沿用準備任務 95 秒上限及各 Range 請求的既有逾時／有限重試 |
| 儲存 | 沿用 512 MiB 清理目標、2 小時完整檔案 TTL 及程序目錄租約 |

開始前計入目前目錄的磁碟 bytes 與已準備 Range 的記憶體用量，確認可容納整個檔案；不為選用下載額外騰出前景檔案。512 MiB 是既有 LRU 清理目標，仍不是前景下載與使用中資料的全域瞬時硬上限。

已有前景準備時拒絕背景下載；新的正常來源準備或 Range 媒體讀取會立即取消選用下載。暫停、等待資料、跳轉、背景、離頁、換劇、清晰度或帳號切換亦取消背景工作。自然換集取消仍在下載的完整檔案，直接接管既有 Range 結果。遲到回覆不會更換已交給播放器的來源。

檔案使用獨立任務及目錄，完成寫入、同步與關閉後才公開路徑，失敗刪除半成品。Range 來源本身不會被原地改成檔案，既有讀者仍可安全使用。快取鍵包含原 Range token、ETag 與媒體長度，更新後的表示內容不會誤用舊完整檔案。缺失檔案可以重新建立。

API 只接受已準備的相對媒體 token，不接受外部 URL 或新來源解析參數；桌面動態 loopback port 僅在前端轉回精確 token。同來源私有路由檢查與 POST 限制均保留。

## 可重現驗證

在 repository 根目錄執行（Go 1.25、Node）：

```sh
go test ./...
go vet ./...
go test -race ./core/cmd/hongguotv -run 'TestEpisode(FileCache|Preparation)|TestLastConsumer|TestCanceledJob|TestFailedPreparation|TestMediaCache' -count=3
node --check core/cmd/hongguotv/ui/app.js
node --check core/cmd/hongguotv/ui/episode-prefetch.js
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
node desktop/frontend/build.mjs
(cd desktop && go test ./... && go vet ./...)
go test ./core/cmd/hongguotv -run '^$' -bench BenchmarkEpisodeFileCache -benchtime=5x -count=3
```

設定 `HONGGUO_TEST_CORE` 為同版本已編譯的核心可額外執行桌面宿主的子程序整合測試；它使用獨立資料及快取目錄，確認桌面會啟用私有快取路由並正常關閉子程序。一般核心不帶旗標時不提供此路由。

新增測試覆蓋：完整檔案及 HEAD／Range bytes、CENC 樣本跨分塊解密、64 MiB 精確邊界、超額拒絕、磁碟與 Range 記憶體預算、共用下載、單等待者與最後等待者取消、前景搶占、ETag／長度變更、截斷／超額／忽略 Range 的回覆、失敗清理與重試、儲存錯誤、檔案遺失、來源更新，以及前端取消與遲到接管。所有來源都是本機合成 HTTP，不需要帳號或真實影片。

## 合成基準與限制

2026-10-27 在 macOS arm64、Apple M5 Max 上，使用精確 8 MiB 合成 bytes，來源每個 512 KiB 回覆固定延遲 2 ms；每組 5 次操作，重複 3 組。以下耗時為三組 `ns/op` 的中位數，計量的是完整 HTTP body 處理，不是播放器首幀。

| 情境 | 耗時中位數 | 每次來源 bytes | 每次來源請求 | 留存檔案 bytes |
| --- | ---: | ---: | ---: | ---: |
| Range 冷讀取 | 44.09 ms | 8,388,608 | 16 | 0 |
| 完整檔案冷建立＋讀取 | 51.06 ms | 8,388,608 | 16 | 8,388,608 |
| 完整檔案熱接管＋讀取 | 1.02 ms | 0 | 0 | 8,388,608 |

熱測量排除先前建立快取所需的 8 MiB 與時間；冷建立包含寫盤與同步，故比直接 Range 讀取慢。此功能把來源傳輸提前，沒有減少首次下載的 bytes。若使用者不看下一集，預取會增加傳輸及儲存成本。作業系統檔案快取亦影響熱讀取耗時，不能把表格換算為真機換集或實際網路的速度承諾。

已驗證的是合成資料 correctness、取消與資源限制，以及本機核心／桌面宿主整合。尚未驗證真實影片、桌面 WebView 首幀、macOS／Windows／Linux GUI 換集、長時間播放與打包後的裝置行為；本次不涉及 Android 或 webOS 發布。
