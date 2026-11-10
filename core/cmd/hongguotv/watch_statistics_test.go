package main

import (
	"bytes"
	"encoding/json"
	"errors"
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

func TestWatchStatisticsResetPersistsStartAndRejectsLateBatches(t *testing.T) {
	dir := t.TempDir()
	store := &watchStatisticsStore{dir: dir}
	today, _ := watchDate("2026-11-11")
	now := time.Date(2026, 11, 11, 14, 30, 0, 0, time.UTC)
	batch := watchBatch{ID: "before-reset-001", Items: []watchSegment{{Day: "2026-11-11", MS: 30000, Type: "real", Genre: "悬疑"}}}
	if err := store.apply(batch, today); err != nil {
		t.Fatal(err)
	}
	batch.OwnerID = "account"
	if err := store.apply(batch, today); err != nil {
		t.Fatal(err)
	}
	otherFile := store.file("account")
	otherBefore, _ := os.ReadFile(otherFile)
	historyFile := filepath.Join(dir, "library.json")
	if err := os.WriteFile(historyFile, []byte("preserved progress"), 0600); err != nil {
		t.Fatal(err)
	}
	fresh, err := store.reset("", today, now)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Since != "2026-11-11" || fresh.ResetAt != now.UnixMilli() || len(fresh.Days) != 0 || len(fresh.Revision) != 32 {
		t.Fatalf("invalid reset %+v", fresh)
	}
	// A new store instance sees the same start, even before any new playback.
	restarted := &watchStatisticsStore{dir: dir}
	saved, err := restarted.read("")
	if err != nil || saved.ResetAt != fresh.ResetAt || saved.Revision != fresh.Revision || len(saved.Days) != 0 {
		t.Fatalf("reset lost after restart %+v %v", saved, err)
	}
	batch.OwnerID = ""
	if err := restarted.apply(batch, today); !errors.Is(err, errWatchStatisticsReset) {
		t.Fatalf("late batch accepted: %v", err)
	}
	batch.Revision = fresh.Revision
	if err := restarted.apply(batch, today); err != nil {
		t.Fatal(err)
	}
	saved, _ = restarted.read("")
	if saved.Days["2026-11-11"].MS != 30000 || saved.ResetAt != fresh.ResetAt {
		t.Fatal("new playback did not resume")
	}
	second, err := restarted.reset("", today, now.Add(time.Minute))
	if err != nil || second.Revision == fresh.Revision || second.ResetAt == fresh.ResetAt {
		t.Fatal("same-day reset did not advance")
	}
	if err := restarted.apply(batch, today); !errors.Is(err, errWatchStatisticsReset) {
		t.Fatal("previous revision accepted")
	}
	otherAfter, _ := os.ReadFile(otherFile)
	historyAfter, _ := os.ReadFile(historyFile)
	if !bytes.Equal(otherBefore, otherAfter) || string(historyAfter) != "preserved progress" {
		t.Fatal("reset changed unrelated data")
	}
	// A failed atomic write leaves the previous statistics file intact.
	restarted.dir = historyFile // A file cannot be used as the parent directory.
	if _, err := restarted.reset("", today, now); err == nil {
		t.Fatal("write failure not reported")
	}
	restarted.dir = dir
	saved, _ = restarted.read("")
	if saved.Revision != second.Revision || saved.ResetAt != second.ResetAt {
		t.Fatal("failed reset changed saved start")
	}
}

func TestWatchStatisticsResetHTTP(t *testing.T) {
	s := &server{watchStatisticsStore: &watchStatisticsStore{dir: t.TempDir()}}
	day := time.Now().UTC().Format("2006-01-02")
	url := "/api/v1/watch-statistics?day=" + day
	w := httptest.NewRecorder()
	s.watchStatistics(w, httptest.NewRequest("DELETE", url+"&owner_id=other", nil))
	if w.Code != 409 {
		t.Fatalf("wrong account reset: %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.watchStatistics(w, httptest.NewRequest("DELETE", url, nil))
	var response struct {
		OK   bool                `json:"ok"`
		Data watchStatisticsData `json:"data"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || !response.OK || response.Data.ResetAt <= 0 {
		t.Fatalf("DELETE failed: %s", w.Body.String())
	}
	body, _ := json.Marshal(watchBatch{ID: "late-http-0001", Items: []watchSegment{{Day: day, MS: 1000, Type: "real"}}})
	w = httptest.NewRecorder()
	s.watchStatistics(w, httptest.NewRequest("POST", url, bytes.NewReader(body)))
	if w.Code != 409 {
		t.Fatalf("late POST accepted: %d", w.Code)
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
