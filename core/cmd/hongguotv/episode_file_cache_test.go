package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func addPreparedCacheSource(t testing.TB, source *miniReelRangeSource, token string) string {
	t.Helper()
	ready := make(chan struct{})
	close(ready)
	miniReelState.Lock()
	miniReelState.jobs[token] = &miniReelMediaJob{Ready: ready, Range: source, Mode: "range", Quality: "720P", Qualities: []string{"720P"}, Accessed: time.Now()}
	miniReelState.Unlock()
	return "/minireel-proxy/media/" + token + ".mp4"
}

func cacheRangeFixture(t testing.TB, data []byte, before func(http.ResponseWriter, *http.Request) bool) (*miniReelRangeSource, *atomic.Int32) {
	t.Helper()
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if before != nil && !before(w, r) {
			return
		}
		start, end, _, err := parseMiniReelByteRange(r.Header.Get("Range"), int64(len(data)))
		if err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if end-start+1 > miniReelRangeChunkBytes {
			t.Error("unbounded cache read")
		}
		w.Header().Set("ETag", `"cache-fixture"`)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(data)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data[start : end+1])
	}))
	t.Cleanup(srv.Close)
	return &miniReelRangeSource{URL: srv.URL, ETag: `"cache-fixture"`, Length: int64(len(data)), VID: "456", Quality: "720P"}, &requests
}

func TestEpisodeFileCacheServesCompletedBytesOfflineAndReusesJob(t *testing.T) {
	isolatedMediaJobs(t)
	data := bytes.Repeat([]byte("episode-fixture-"), 80000)
	source, requests := cacheRangeFixture(t, data, nil)
	// The cache must use the exact prepared/modified prefix served by Range.
	source.Prefix = []byte("prepared-prefix")
	want := append([]byte(nil), data...)
	copy(want, source.Prefix)
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	result, err := cachePreparedEpisode(context.Background(), media)
	if err != nil {
		t.Fatal(err)
	}
	if result["mode"] != "full" || result["vid"] != "456" {
		t.Fatal(result)
	}
	count := requests.Load()
	if count != 3 {
		t.Fatalf("chunk count = %d", count)
	}
	again, err := cachePreparedEpisode(context.Background(), media)
	if err != nil || result["path"] != again["path"] || requests.Load() != count {
		t.Fatal("cache was downloaded again", err)
	}
	source.mu.Lock()
	source.URL = "http://127.0.0.1:1/unreachable"
	source.mu.Unlock()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, result["path"].(string), nil)
	handleMiniReelMedia(w, r)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), want) {
		t.Fatal("completed file did not serve exact bytes without network", w.Code)
	}
	if requests.Load() != count {
		t.Fatal("playback used network")
	}
}

func TestEpisodeFileCacheRejectsInvalidOversizedAndInsufficientBudget(t *testing.T) {
	root := isolatedMediaJobs(t)
	for _, path := range []string{"https://example.invalid/video", "/minireel-proxy/media/../secret", "/minireel-proxy/media/" + strings.Repeat("a", 24) + ".mp4"} {
		if _, err := cachePreparedEpisode(context.Background(), path); err == nil {
			t.Fatal("invalid media accepted", path)
		}
	}
	source, requests := cacheRangeFixture(t, bytes.Repeat([]byte("x"), 32), nil)
	source.Length = episodeFileCacheLimit + 1
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	if _, err := cachePreparedEpisode(context.Background(), media); err == nil {
		t.Fatal("oversized episode accepted")
	}
	source.Length = 32
	f, err := os.Create(filepath.Join(root, "occupied"))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Truncate(miniReelMaxCache); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err := cachePreparedEpisode(context.Background(), media); err == nil {
		t.Fatal("budget exceeded")
	}
	if requests.Load() != 0 {
		t.Fatal("rejected cache contacted upstream")
	}
}

func TestEpisodeFileCacheCancelCleansPartialAndAllowsRetry(t *testing.T) {
	root := isolatedMediaJobs(t)
	started := make(chan struct{})
	var block atomic.Bool
	block.Store(true)
	source, _ := cacheRangeFixture(t, bytes.Repeat([]byte("x"), int(miniReelRangeChunkBytes)+32), func(w http.ResponseWriter, r *http.Request) bool {
		if block.Load() && strings.HasPrefix(r.Header.Get("Range"), "bytes=524288-") {
			close(started)
			<-r.Context().Done()
			return false
		}
		return true
	})
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := cachePreparedEpisode(ctx, media); done <- err }()
	awaitMediaSignal(t, started)
	cancel()
	if err := awaitMediaResult(t, done); err == nil {
		t.Fatal("cancellation ignored")
	}
	waitMediaCondition(t, func() bool { return len(episodeFileCacheSlot) == 0 })
	if miniReelDirectorySize(root) != 0 {
		t.Fatal("partial file retained")
	}
	block.Store(false)
	if _, err := cachePreparedEpisode(context.Background(), media); err != nil {
		t.Fatal("retry failed", err)
	}
}

func TestEpisodeFileCacheSharesPendingJobAndLimitsConcurrentEpisodes(t *testing.T) {
	isolatedMediaJobs(t)
	started, release := make(chan struct{}), make(chan struct{})
	source, requests := cacheRangeFixture(t, bytes.Repeat([]byte("x"), 32), func(w http.ResponseWriter, r *http.Request) bool {
		close(started)
		select {
		case <-release:
			return true
		case <-r.Context().Done():
			return false
		}
	})
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	other := addPreparedCacheSource(t, source, strings.Repeat("b", 24))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	one, two := make(chan error, 1), make(chan error, 1)
	go func() { _, err := cachePreparedEpisode(ctx, media); one <- err }()
	awaitMediaSignal(t, started)
	go func() { _, err := cachePreparedEpisode(context.Background(), media); two <- err }()
	waitMediaCondition(t, func() bool {
		miniReelState.Lock()
		defer miniReelState.Unlock()
		for _, j := range miniReelState.jobs {
			if !isMiniReelReady(j.Ready) && j.Waiters == 2 {
				return true
			}
		}
		return false
	})
	if _, err := cachePreparedEpisode(context.Background(), other); err == nil {
		t.Fatal("parallel episode download allowed")
	}
	cancel()
	if err := awaitMediaResult(t, one); err == nil {
		t.Fatal("request cancellation ignored")
	}
	close(release)
	if err := awaitMediaResult(t, two); err != nil {
		t.Fatal("shared consumer canceled", err)
	}
	if requests.Load() != 1 {
		t.Fatal("duplicate network downloads", requests.Load())
	}
}

func TestEpisodeFileCacheRouteIsPrivateAndPostOnly(t *testing.T) {
	s := &server{}
	for _, x := range []struct {
		method, origin string
		code           int
	}{
		{http.MethodPost, "https://external.invalid", 403},
		{http.MethodGet, "http://127.0.0.1", 405},
		{http.MethodPost, "http://127.0.0.1", 409},
	} {
		r := httptest.NewRequest(x.method, "http://127.0.0.1/api/v1/play/cache?media=invalid", nil)
		r.RemoteAddr = "127.0.0.1:51234"
		r.Header.Set("Origin", x.origin)
		w := httptest.NewRecorder()
		s.withCORS(http.HandlerFunc(s.cachePreparedEpisode)).ServeHTTP(w, r)
		if w.Code != x.code {
			t.Fatal(x, w.Code)
		}
	}
}

func TestEpisodeFileCacheDecryptsAcrossChunksAndServesHeadAndRanges(t *testing.T) {
	key := bytes.Repeat([]byte{0x37}, 16)
	iv := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	plain := bytes.Repeat([]byte("encrypted synthetic sample "), 40000)
	encrypted := append([]byte(nil), plain...)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	counter := make([]byte, aes.BlockSize)
	copy(counter, iv)
	cipher.NewCTR(block, counter).XORKeyStream(encrypted, encrypted)
	input := makeRangeMP4Fixture(t, encrypted, iv)
	serverSource, requests := cacheRangeFixture(t, input, nil)
	root := isolatedMediaJobs(t)
	source, err := openMiniReelRangeSource(context.Background(), miniReelOption{URL: serverSource.URL, Key: key, Quality: "720P"}, "456")
	if err != nil {
		t.Fatal(err)
	}
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	result, err := cachePreparedEpisode(context.Background(), media)
	if err != nil {
		t.Fatal(err)
	}
	want := append([]byte(nil), input...)
	copy(want, source.Prefix)
	copy(want[source.Samples[0].Offset:], plain)
	count := requests.Load()
	for _, check := range []struct {
		method, byteRange string
		status            int
		body              []byte
	}{
		{http.MethodGet, "", 200, want},
		{http.MethodGet, "bytes=524280-524310", 206, want[524280:524311]},
		{http.MethodGet, "bytes=-17", 206, want[len(want)-17:]},
		{http.MethodHead, "", 200, nil},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(check.method, result["path"].(string), nil)
		r.Header.Set("Range", check.byteRange)
		handleMiniReelMedia(w, r)
		if w.Code != check.status || !bytes.Equal(w.Body.Bytes(), check.body) {
			t.Fatal("cached HTTP representation differs", check.method, check.byteRange, w.Code)
		}
	}
	if requests.Load() != count || miniReelDirectorySize(root) != int64(len(want)) {
		t.Fatal("cached reads used network or stored extra bytes")
	}
}

func TestEpisodeFileCacheFailurePreservesRangeAndRetries(t *testing.T) {
	for _, failure := range []string{"etag", "length", "ignored-range", "truncated", "oversized"} {
		t.Run(failure, func(t *testing.T) {
			var failing atomic.Bool
			failing.Store(true)
			data := bytes.Repeat([]byte("x"), int(miniReelRangeChunkBytes)+32)
			source, _ := cacheRangeFixture(t, data, func(w http.ResponseWriter, r *http.Request) bool {
				if !failing.Load() || !strings.HasPrefix(r.Header.Get("Range"), "bytes=524288-") {
					return true
				}
				w.Header().Set("ETag", `"cache-fixture"`)
				w.Header().Set("Content-Range", fmt.Sprintf("bytes 524288-%d/%d", len(data)-1, len(data)))
				switch failure {
				case "etag":
					w.Header().Set("ETag", `"changed"`)
				case "length":
					w.Header().Set("Content-Range", fmt.Sprintf("bytes 524288-%d/%d", len(data)-1, len(data)+1))
				case "ignored-range":
					w.WriteHeader(200)
					return false
				}
				w.WriteHeader(206)
				if failure == "truncated" {
					return false
				}
				_, _ = w.Write(bytes.Repeat([]byte("x"), 33))
				return false
			})
			root := isolatedMediaJobs(t)
			media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
			if _, err := cachePreparedEpisode(context.Background(), media); err == nil {
				t.Fatal("invalid response cached")
			}
			if miniReelDirectorySize(root) != 0 || len(episodeFileCacheSlot) != 0 {
				t.Fatal("partial file or slot leaked")
			}
			failing.Store(false)
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, media, nil)
			r.Header.Set("Range", "bytes=0-31")
			handleMiniReelMedia(w, r)
			if w.Code != 206 || !bytes.Equal(w.Body.Bytes(), data[:32]) {
				t.Fatal("failure damaged original Range source")
			}
			if _, err := cachePreparedEpisode(context.Background(), media); err != nil {
				t.Fatal("failed cache cannot retry", err)
			}
		})
	}
}

func TestEpisodeFileCacheYieldsToForegroundPreparationAndRangeRead(t *testing.T) {
	for _, action := range []string{"prepare", "range-read"} {
		t.Run(action, func(t *testing.T) {
			started, canceled := make(chan struct{}), make(chan struct{})
			source, _ := cacheRangeFixture(t, bytes.Repeat([]byte("x"), 32), func(w http.ResponseWriter, r *http.Request) bool {
				close(started)
				<-r.Context().Done()
				close(canceled)
				return false
			})
			foregroundSource, _ := cacheRangeFixture(t, bytes.Repeat([]byte("y"), 32), nil)
			root := isolatedMediaJobs(t)
			media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
			foregroundMedia := addPreparedCacheSource(t, foregroundSource, strings.Repeat("b", 24))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := cachePreparedEpisode(ctx, media); done <- err }()
			awaitMediaSignal(t, started)
			if action == "prepare" {
				err := awaitMediaResult(t, resolveTestMedia(context.Background(), "720P", true,
					func(_ context.Context, job *miniReelMediaJob, _, _, _, _ string, _ bool) {
						job.Err = errors.New("foreground ran")
					}))
				if err == nil || err.Error() != "foreground ran" {
					t.Fatal("foreground was held up", err)
				}
			} else {
				w := httptest.NewRecorder()
				handleMiniReelMedia(w, httptest.NewRequest(http.MethodGet, foregroundMedia, nil))
				if w.Code != 200 || w.Body.Len() != 32 {
					t.Fatal("foreground read was held up")
				}
			}
			if err := awaitMediaResult(t, done); !errors.Is(err, context.Canceled) {
				t.Fatal("optional download not canceled", err)
			}
			awaitMediaSignal(t, canceled)
			if miniReelDirectorySize(root) != 0 || len(episodeFileCacheSlot) != 0 {
				t.Fatal("canceled data retained")
			}
		})
	}
}

func TestEpisodeFileCacheDeclinesWhileForegroundIsPreparing(t *testing.T) {
	source, requests := cacheRangeFixture(t, bytes.Repeat([]byte("x"), 32), nil)
	isolatedMediaJobs(t)
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	ready := make(chan struct{})
	defer close(ready)
	miniReelState.Lock()
	miniReelState.jobs[strings.Repeat("b", 24)] = &miniReelMediaJob{Ready: ready, Accessed: time.Now()}
	miniReelState.Unlock()
	if _, err := cachePreparedEpisode(context.Background(), media); err == nil || requests.Load() != 0 {
		t.Fatal("speculation competed with existing preparation", err)
	}
}

func TestEpisodeFileCacheCountsDiskAndRangeMemoryBeforeDownloading(t *testing.T) {
	source, requests := cacheRangeFixture(t, bytes.Repeat([]byte("x"), 32), nil)
	root := isolatedMediaJobs(t)
	source.Prefix = []byte("prepared-prefix")
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	f, err := os.Create(filepath.Join(root, "foreground-occupied"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	available := int64(miniReelMaxCache) - source.Length - miniReelRangeMemorySize(source)
	if err := f.Truncate(available + 1); err != nil {
		t.Fatal(err)
	}
	if _, err := cachePreparedEpisode(context.Background(), media); err == nil || requests.Load() != 0 {
		t.Fatal("Range metadata was not included in budget")
	}
	if size, _ := f.Stat(); size.Size() != available+1 {
		t.Fatal("optional work evicted foreground data")
	}
	if err := f.Truncate(available); err != nil {
		t.Fatal(err)
	}
	if _, err := cachePreparedEpisode(context.Background(), media); err != nil {
		t.Fatal("exact budget rejected", err)
	}
	if requests.Load() != 1 {
		t.Fatal("unexpected download count", requests.Load())
	}
}

func TestEpisodeFileCacheMissingFileAndRenewedRepresentationDoNotHitStaleCache(t *testing.T) {
	source, requests := cacheRangeFixture(t, bytes.Repeat([]byte("x"), 32), nil)
	otherSource, otherRequests := cacheRangeFixture(t, bytes.Repeat([]byte("y"), 64), nil)
	isolatedMediaJobs(t)
	token := strings.Repeat("a", 24)
	media := addPreparedCacheSource(t, source, token)
	result, err := cachePreparedEpisode(context.Background(), media)
	if err != nil {
		t.Fatal(err)
	}
	cacheToken := strings.TrimSuffix(strings.TrimPrefix(result["path"].(string), "/minireel-proxy/media/"), ".mp4")
	miniReelState.Lock()
	path := miniReelState.jobs[cacheToken].Path
	miniReelState.Unlock()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := cachePreparedEpisode(context.Background(), media); err != nil || requests.Load() != 2 {
		t.Fatal("missing file did not redownload", err)
	}
	addPreparedCacheSource(t, otherSource, token)
	renewed, err := cachePreparedEpisode(context.Background(), media)
	if err != nil || renewed["path"] == result["path"] || otherRequests.Load() != 1 {
		t.Fatal("renewed representation reused stale bytes", err)
	}
}

func TestEpisodeFileCacheStorageFailureReleasesSlotWithoutDownloading(t *testing.T) {
	source, requests := cacheRangeFixture(t, bytes.Repeat([]byte("x"), 32), nil)
	root := isolatedMediaJobs(t)
	token := strings.Repeat("a", 24)
	blocked := filepath.Join(root, token)
	if err := os.WriteFile(blocked, []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	job := &miniReelMediaJob{}
	if err := prepareEpisodeFileCache(context.Background(), job, token, source); err == nil {
		t.Fatal("storage failure ignored")
	}
	if len(episodeFileCacheSlot) != 0 || job.Path != "" || requests.Load() != 0 {
		t.Fatal("storage failure leaked slot/path/network request")
	}
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	if err := prepareEpisodeFileCache(context.Background(), job, token, source); err != nil {
		t.Fatal("storage retry failed", err)
	}
}

func TestEpisodeFileCacheAcceptsExactly64MiBWithBoundedReads(t *testing.T) {
	var downloaded atomic.Int64
	var requests atomic.Int32
	chunk := bytes.Repeat([]byte("x"), int(miniReelRangeChunkBytes))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start, end, partial, err := parseMiniReelByteRange(r.Header.Get("Range"), episodeFileCacheLimit)
		if err != nil || !partial || end-start+1 > miniReelRangeChunkBytes {
			t.Error("unbounded or malformed request", r.Header.Get("Range"))
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		requests.Add(1)
		w.Header().Set("ETag", `"boundary"`)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, episodeFileCacheLimit))
		w.WriteHeader(http.StatusPartialContent)
		n, _ := w.Write(chunk[:end-start+1])
		downloaded.Add(int64(n))
	}))
	t.Cleanup(upstream.Close)
	root := isolatedMediaJobs(t)
	source := &miniReelRangeSource{URL: upstream.URL, ETag: `"boundary"`, Length: episodeFileCacheLimit, VID: "456", Quality: "720P"}
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	if _, err := cachePreparedEpisode(context.Background(), media); err != nil {
		t.Fatal(err)
	}
	waitMediaCondition(t, func() bool { return downloaded.Load() == episodeFileCacheLimit })
	if downloaded.Load() != episodeFileCacheLimit || miniReelDirectorySize(root) != episodeFileCacheLimit || requests.Load() != 128 {
		t.Fatal("size or chunk bound changed", downloaded.Load(), miniReelDirectorySize(root), requests.Load())
	}
}

func TestEpisodeFileCachePrivatePOSTOverHTTP(t *testing.T) {
	data := bytes.Repeat([]byte("HTTP cache fixture "), 100)
	source, upstreamRequests := cacheRangeFixture(t, data, nil)
	isolatedMediaJobs(t)
	media := addPreparedCacheSource(t, source, strings.Repeat("a", 24))
	s := &server{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/play/cache", s.cachePreparedEpisode)
	mux.HandleFunc("/minireel-proxy/media/", handleMiniReelMedia)
	api := httptest.NewServer(s.withCORS(mux))
	t.Cleanup(api.Close)
	client := &http.Client{Timeout: 3 * time.Second}
	endpoint := api.URL + "/api/v1/play/cache?media=" + media
	for _, check := range []struct {
		method, origin string
		status         int
	}{
		{http.MethodPost, "https://foreign.invalid", http.StatusForbidden},
		{http.MethodOptions, "https://foreign.invalid", http.StatusForbidden},
		{http.MethodGet, api.URL, http.StatusMethodNotAllowed},
		{http.MethodOptions, api.URL, http.StatusNoContent},
	} {
		req, err := http.NewRequest(check.method, endpoint, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", check.origin)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != check.status {
			t.Fatal("HTTP route boundary changed", check, resp.StatusCode)
		}
	}
	if upstreamRequests.Load() != 0 {
		t.Fatal("rejected or preflight request downloaded bytes")
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", api.URL)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	err = json.NewDecoder(resp.Body).Decode(&result)
	resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusOK || !result.OK || result.Data["mode"] != "full" {
		t.Fatal("same-origin POST failed", resp.StatusCode, err)
	}
	count := upstreamRequests.Load()
	resp, err = client.Get(api.URL + result.Data["path"].(string))
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusOK || !bytes.Equal(got, data) || count != 1 || upstreamRequests.Load() != count {
		t.Fatal("HTTP cache hit did not preserve exact bytes without network", err)
	}
}
