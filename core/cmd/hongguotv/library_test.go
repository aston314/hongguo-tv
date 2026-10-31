package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func libraryFixture() Drama {
	return Drama{SeriesID: "7690163276214176792", Title: "记录测试", EpisodeCount: 13, Vid: "7654933376318589977", VidList: []string{"7654933376318589977"}, Episodes: []Episode{{Index: 1, VideoID: "7654933376318589977"}}}
}

func TestLibraryProgressPersistsAndCollectionsAreIndependent(t *testing.T) {
	dir := t.TempDir()
	store, err := newLibraryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	on := true
	drama := libraryFixture()
	drama.Cover = "https://p3-reading-sign.fqnovelpic.com/novel-pic/test-cover~tplv-tt-cs0:400:572.heic?signature=fixture"
	for _, change := range []LibraryChange{
		{Action: "favorite", Drama: drama, Value: &on},
		{Action: "like", Drama: drama, Value: &on},
		{Action: "progress", Drama: drama, Episode: 8, VideoID: drama.Vid, Position: 42, Duration: 180},
	} {
		if _, err := store.apply(change); err != nil {
			t.Fatal(err)
		}
	}
	reopened, err := newLibraryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	data := reopened.snapshot()
	if data.Entries[0].Drama.Cover != drama.Cover || data.Entries[0].Drama.CoverFallback != "https://p3-novel.byteimg.com/novel-pic/test-cover~tplv-shrink:640:0.image" {
		t.Fatal("restored cloud HEIC cover lost its original URL or browser alternative")
	}
	if len(data.Entries) != 1 || data.Entries[0].Episode != 8 || data.Entries[0].Position != 42 || data.Entries[0].Drama.SeriesID != drama.SeriesID {
		t.Fatalf("progress not persisted: %#v", data)
	}
	if len(data.Entries[0].Drama.VidList) != 0 || len(data.Entries[0].Drama.Episodes) != 0 {
		t.Fatal("entire episode lists should not be stored")
	}
	if data.Entries[0].Drama.Vid != "" || data.Entries[0].VideoID != drama.Vid {
		t.Fatal("saved card must not confuse a current-episode ID with episode one")
	}
	data.Entries[0].Drama.Title = "changed snapshot"
	if reopened.snapshot().Entries[0].Drama.Title != drama.Title {
		t.Fatal("snapshot aliases store")
	}
	if _, err = reopened.apply(LibraryChange{Action: "clear", Kind: "history"}); err != nil {
		t.Fatal(err)
	}
	entry := reopened.snapshot().Entries[0]
	if entry.Episode != 0 || entry.Position != 0 || entry.LastPlayedAt != 0 || entry.FavoriteAt == 0 || entry.LikedAt == 0 {
		t.Fatalf("history clear changed unrelated collections: %#v", entry)
	}
	if _, err = reopened.apply(LibraryChange{Action: "remove", Kind: "favorites", SeriesID: drama.SeriesID}); err != nil {
		t.Fatal(err)
	}
	if reopened.snapshot().Entries[0].LikedAt == 0 {
		t.Fatal("removing favorite must preserve like")
	}
	if _, err = reopened.apply(LibraryChange{Action: "clear", Kind: "likes"}); err != nil {
		t.Fatal(err)
	}
	if len(reopened.snapshot().Entries) != 0 {
		t.Fatal("unused entry was not removed")
	}
}

func TestLibraryPreservesAllSavedAndHistoryEntries(t *testing.T) {
	data := LibraryData{Version: 1}
	for i := 1; i <= 1201; i++ {
		data.Entries = append(data.Entries, LibraryEntry{Drama: Drama{SeriesID: fmt.Sprint(7000000000000000000 + int64(i))}, Episode: 1, LastPlayedAt: int64(i), FavoriteAt: int64(i), LikedAt: int64(i)})
	}
	data.Entries = append(data.Entries, LibraryEntry{Drama: Drama{SeriesID: "999"}})
	pruneLibraryEntries(&data)
	if len(data.Entries) != 1201 {
		t.Fatalf("lost records: %d", len(data.Entries))
	}
	if data.Entries[0].LastPlayedAt != 1 || data.Entries[0].FavoriteAt != 1 || data.Entries[0].LikedAt != 1 {
		t.Fatal("old records were trimmed")
	}
	// A normal save and restart must preserve older memberships as well.
	store, e := newLibraryStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	store.data = data
	saved, e := store.apply(LibraryChange{Action: "like", Drama: Drama{SeriesID: data.Entries[0].Drama.SeriesID, Title: "older entry"}, Value: func() *bool { v := false; return &v }()})
	if e != nil || len(saved.Entries) != 1201 {
		t.Fatal("normal write lost records", e)
	}
	reopened, e := newLibraryStore(filepath.Dir(store.path))
	if e != nil || len(reopened.snapshot().Entries) != 1201 {
		t.Fatal("restart lost records", e)
	}
}

func TestLibraryDiskFailureDoesNotPublishMutation(t *testing.T) {
	store, err := newLibraryStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(store.path, 0700); err != nil {
		t.Fatal(err)
	}
	on := true
	if _, err := store.apply(LibraryChange{Action: "favorite", Drama: libraryFixture(), Value: &on}); err == nil {
		t.Fatal("expected rename failure")
	}
	if len(store.snapshot().Entries) != 0 {
		t.Fatal("failed write was published in memory")
	}
	temps, _ := filepath.Glob(filepath.Join(filepath.Dir(store.path), ".library-*.tmp"))
	if len(temps) != 0 {
		t.Fatalf("temporary files leaked: %#v", temps)
	}
}

func TestLibraryConcurrentWritesAndHTTPValidation(t *testing.T) {
	store, err := newLibraryStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			on := true
			drama := libraryFixture()
			drama.SeriesID = fmt.Sprint(7000000000000000000 + int64(i))
			if _, err := store.apply(LibraryChange{Action: "favorite", Drama: drama, Value: &on}); err != nil {
				t.Error(err)
			}
		}(i)
	}
	group.Wait()
	if len(store.snapshot().Entries) != 8 {
		t.Fatal("concurrent mutation lost an entry")
	}
	s := &server{libraryStore: store}
	for _, body := range []string{`{"action":"progress","drama":{"series_id":"7690163276214176792","title":"test"},"episode":0}`, `{"action":"clear","kind":"all"}`, `{"action":"clear","kind":"history"} {}`, `{"action":"clear","kind":"history","unknown":true}`} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/library", bytes.NewBufferString(body))
		response := httptest.NewRecorder()
		s.library(response, request)
		if response.Code != 400 {
			t.Fatalf("accepted invalid body: %s, %d", body, response.Code)
		}
	}
	response := httptest.NewRecorder()
	s.library(response, httptest.NewRequest(http.MethodGet, "/api/v1/library", nil))
	var payload struct {
		OK   bool        `json:"ok"`
		Data LibraryData `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || !payload.OK || len(payload.Data.Entries) != 8 {
		t.Fatalf("GET library failed: %s", response.Body.String())
	}
}

func TestLibraryRequestDecodeErrorsAreSpecificAndPrivate(t *testing.T) {
	store, err := newLibraryStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &server{libraryStore: store}
	for _, tc := range []struct {
		name, body, code, field string
		status                  int
	}{
		{"oversized detail", `{"action":"progress","drama":{"intro":"` + strings.Repeat("剧", libraryRequestLimit) + `"}}`, "LIBRARY_REQUEST_TOO_LARGE", "", 413},
		{"oversized trailing whitespace", `{"action":"clear","kind":"history"}` + strings.Repeat(" ", libraryRequestLimit), "LIBRARY_REQUEST_TOO_LARGE", "", 413},
		{"wrong nested type", `{"action":"progress","drama":{"tags":"private-value"}}`, "LIBRARY_FIELD_TYPE", "drama.tags", 400},
		{"wrong episode type", `{"action":"progress","episode":"private-value"}`, "LIBRARY_FIELD_TYPE", "episode", 400},
		{"unknown nested field", `{"action":"progress","drama":{"private-field":"private-value"}}`, "LIBRARY_FIELD_UNKNOWN", "", 400},
		{"unknown root field", `{"action":"progress","private-field":"private-value"}`, "LIBRARY_FIELD_UNKNOWN", "", 400},
		{"invalid JSON", `{"private-value":`, "LIBRARY_REQUEST_INVALID", "", 400},
		{"empty JSON", ``, "LIBRARY_REQUEST_INVALID", "", 400},
		{"trailing object", `{"action":"clear","kind":"history"} {}`, "LIBRARY_REQUEST_TRAILING", "", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			s.library(response, httptest.NewRequest(http.MethodPost, "/api/v1/library", strings.NewReader(tc.body)))
			var payload struct {
				OK    bool   `json:"ok"`
				Code  string `json:"code"`
				Field string `json:"field"`
				Error string `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			if response.Code != tc.status || payload.OK || payload.Code != tc.code || payload.Field != tc.field || payload.Error == "" {
				t.Fatalf("unexpected rejection: status=%d payload=%+v", response.Code, payload)
			}
			if strings.Contains(response.Body.String(), "private-") {
				t.Fatal("decoder leaked request values or unknown field names")
			}
			if len(store.snapshot().Entries) != 0 {
				t.Fatal("rejected request changed records")
			}
		})
	}
}

func TestLibraryBoundedDetailProgressSurvivesHTTPAndRestart(t *testing.T) {
	dir := t.TempDir()
	store, err := newLibraryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	drama := libraryFixture()
	drama.Intro = strings.Repeat("剧情🎬", 333) + "完"
	drama.Tags = []string{"一", "二", "三", "四", "五", "六", "七", "八"}
	drama = cleanLibraryDrama(drama)
	body, err := json.Marshal(LibraryChange{Action: "progress", Drama: drama, Episode: 3,
		VideoID: "7654933376318589977", Position: 12.5, Duration: 180.25})
	if err != nil || len(body) >= libraryRequestLimit {
		t.Fatalf("invalid bounded fixture: bytes=%d err=%v", len(body), err)
	}
	// Also exercise the inclusive HTTP byte boundary, not only small bodies.
	body = append(body, bytes.Repeat([]byte(" "), libraryRequestLimit-len(body))...)
	response := httptest.NewRecorder()
	s := &server{libraryStore: store}
	s.library(response, httptest.NewRequest(http.MethodPost, "/api/v1/library", bytes.NewReader(body)))
	if response.Code != http.StatusOK {
		t.Fatalf("bounded detail rejected: %d %s", response.Code, response.Body.String())
	}
	reopened, err := newLibraryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	entries := reopened.snapshot().Entries
	if len(entries) != 1 || entries[0].Episode != 3 || entries[0].VideoID != "7654933376318589977" ||
		entries[0].Position != 12.5 || entries[0].Duration != 180.25 || entries[0].Drama.Intro != drama.Intro || len(entries[0].Drama.Tags) != 8 {
		t.Fatalf("progress lost after restart: %+v", entries)
	}
}
