package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestWatchStatisticsRetentionIsolationAndIdempotency(t *testing.T) {
	s := &watchStatisticsStore{dir: t.TempDir()}
	today, _ := watchDate("2026-11-10")
	batch := watchBatch{OwnerID: "", ID: "test-batch-0001", Items: []watchSegment{{Day: "2026-11-10", MS: 30000, Type: "real", Genre: "悬疑"}}}
	if !validWatchBatch(batch, today) {
		t.Fatal("valid batch rejected")
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.apply(batch, today); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	data, err := s.read("")
	if err != nil || data.Days["2026-11-10"].MS != 30000 {
		t.Fatalf("duplicate batch counted: %+v, %v", data, err)
	}
	batch.OwnerID = "account"
	if err := s.apply(batch, today); err != nil {
		t.Fatal(err)
	}
	own, _ := s.read("account")
	if own.Days["2026-11-10"].MS != 30000 {
		t.Fatal("account isolation")
	}
	if s.file("../account") == s.file("account") || filepath.Dir(s.file("../account")) != filepath.Join(s.dir, "watch-statistics") {
		t.Fatal("unsafe owner path")
	}
	for i := 0; i < 420; i++ {
		date := today.AddDate(0, 0, i)
		batch.ID = "retention-" + date.Format("20060102")
		batch.Items[0].Day = date.Format("2006-01-02")
		if err := s.apply(batch, date); err != nil {
			t.Fatal(err)
		}
	}
	data, _ = s.read("account")
	if len(data.Days) != 366 || len(data.Batches) > 64 {
		t.Fatalf("unbounded data %d/%d", len(data.Days), len(data.Batches))
	}
	// No library write or dependency is involved.
	if _, err := os.Stat(filepath.Join(s.dir, "library.json")); !os.IsNotExist(err) {
		t.Fatal("statistics touched library")
	}
}

func TestWatchStatisticsValidationAndGenreBudget(t *testing.T) {
	today, _ := watchDate("2026-11-10")
	valid := watchBatch{ID: "batch-valid-01", Items: []watchSegment{{Day: "2026-11-10", MS: 30000, Type: "real", Genre: "悬疑"}}}
	for _, change := range []func(*watchBatch){func(b *watchBatch) { b.ID = "x" }, func(b *watchBatch) { b.Items[0].MS = 60001 }, func(b *watchBatch) { b.Items[0].Day = "2026-11-11" }, func(b *watchBatch) { b.Items[0].Day = "2026-11-02" }, func(b *watchBatch) { b.Items[0].Type = "unknown-type" }, func(b *watchBatch) { b.Items[0].Genre = "https://token" }, func(b *watchBatch) { b.Items[0].Genre = "__proto__" }} {
		b := valid
		b.Items = append([]watchSegment(nil), valid.Items...)
		change(&b)
		if validWatchBatch(b, today) {
			t.Fatalf("invalid batch accepted %+v", b)
		}
	}
	genres := map[string]int64{}
	for i := 0; i < 200; i++ {
		addWatchGenre(genres, string(rune(0x4e00+i)), 1000)
	}
	if len(genres) > 16 || genres["unknown"] == 0 {
		t.Fatal("genre budget exceeded")
	}
	if validWatchToday("2026-11-13", today) || !validWatchToday("2026-11-09", today) {
		t.Fatal("date timezone boundary")
	}
}

func TestWatchStatisticsHTTPPrivacyAndFailure(t *testing.T) {
	s := &server{watchStatisticsStore: &watchStatisticsStore{dir: t.TempDir()}}
	day := time.Now().UTC().Format("2006-01-02")
	handler := s.withCORS(http.HandlerFunc(s.watchStatistics))
	request := httptest.NewRequest("GET", "http://127.0.0.1/api/v1/watch-statistics?owner_id=&day="+day, nil)
	request.RemoteAddr = "127.0.0.1:20000"
	request.Header.Set("Origin", "https://evil.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatalf("private endpoint leaked: %d", response.Code)
	}
	for _, test := range []struct {
		owner  string
		status int
	}{{"", 200}, {"other", 409}} {
		r := httptest.NewRequest("GET", "/api/v1/watch-statistics?day="+day+"&owner_id="+test.owner, nil)
		w := httptest.NewRecorder()
		s.watchStatistics(w, r)
		if w.Code != test.status {
			t.Fatalf("status %d", w.Code)
		}
	}
	b := watchBatch{ID: "http-batch-001", Items: []watchSegment{{Day: day, MS: 1000, Type: "real", Genre: ""}}}
	body, _ := json.Marshal(b)
	r := httptest.NewRequest("POST", "/api/v1/watch-statistics?day="+day, bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.watchStatistics(w, r)
	if w.Code != 200 {
		t.Fatalf("POST %d: %s", w.Code, w.Body.String())
	}
	// Corrupt statistics fail in isolation; no silent replacement of user data.
	if err := os.WriteFile(s.watchStatisticsStore.file(""), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.watchStatistics(w, httptest.NewRequest("GET", "/api/v1/watch-statistics?day="+day, nil))
	if w.Code != 503 {
		t.Fatal("corruption not reported")
	}
}
