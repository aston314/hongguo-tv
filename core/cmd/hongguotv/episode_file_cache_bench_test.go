package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Synthetic bytes, not playable media or a real account. All requests go to
// httptest loopback. A fixed 2 ms per 512 KiB response makes the network work
// visible; elapsed times are observations, never pass/fail thresholds.
func BenchmarkEpisodeFileCache(b *testing.B) {
	for _, mode := range []string{"RangeCold", "FileCold", "FileWarm"} {
		b.Run(mode, func(b *testing.B) {
			data := bytes.Repeat([]byte{0x5a}, 8<<20)
			var upstreamBytes atomic.Int64
			source, requests := cacheRangeFixture(b, data, func(w http.ResponseWriter, r *http.Request) bool {
				start, end, _, err := parseMiniReelByteRange(r.Header.Get("Range"), int64(len(data)))
				if err != nil {
					b.Error(err)
					return false
				}
				upstreamBytes.Add(end - start + 1)
				timer := time.NewTimer(2 * time.Millisecond)
				defer timer.Stop()
				select {
				case <-r.Context().Done():
					return false
				case <-timer.C:
					return true
				}
			})
			root := isolatedMediaJobs(b)
			media := addPreparedCacheSource(b, source, strings.Repeat("a", 24))
			if mode == "FileWarm" {
				if _, err := cachePreparedEpisode(context.Background(), media); err != nil {
					b.Fatal(err)
				}
			}
			requests.Store(0)
			upstreamBytes.Store(0)
			b.SetBytes(int64(len(data)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if mode == "FileCold" && i > 0 {
					b.StopTimer()
					miniReelState.Lock()
					for token, job := range miniReelState.jobs {
						if job.Optional {
							if err := os.RemoveAll(filepath.Join(root, token)); err != nil {
								b.Fatal(err)
							}
							delete(miniReelState.jobs, token)
						}
					}
					miniReelState.Unlock()
					b.StartTimer()
				}
				path := media
				if mode != "RangeCold" {
					result, err := cachePreparedEpisode(context.Background(), media)
					if err != nil {
						b.Fatal(err)
					}
					path = result["path"].(string)
				}
				response := &episodeBenchmarkWriter{header: make(http.Header)}
				handleMiniReelMedia(response, httptest.NewRequest(http.MethodGet, path, nil))
				if response.status != http.StatusOK || response.bytes != int64(len(data)) {
					b.Fatal("incomplete synthetic response", response.status, response.bytes)
				}
			}
			b.StopTimer()
			b.ReportMetric(float64(requests.Load())/float64(b.N), "upstream-requests/op")
			b.ReportMetric(float64(upstreamBytes.Load())/float64(b.N), "upstream-bytes/op")
			b.ReportMetric(float64(miniReelDirectorySize(root)), "resident-file-bytes")
		})
	}
}

type episodeBenchmarkWriter struct {
	header http.Header
	status int
	bytes  int64
}

func (w *episodeBenchmarkWriter) Header() http.Header  { return w.header }
func (w *episodeBenchmarkWriter) WriteHeader(code int) { w.status = code }
func (w *episodeBenchmarkWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.bytes += int64(len(p))
	return len(p), nil
}
func (w *episodeBenchmarkWriter) Flush() {}
