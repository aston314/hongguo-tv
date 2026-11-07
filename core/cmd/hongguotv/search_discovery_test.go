package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func hotSearchFixture() map[string]any {
	row := func(id, title, kind string) map[string]any {
		return map[string]any{"series_id": id, "title": title, "content_type": kind, "episode_cnt": 24, "card_tips": "120万热搜值"}
	}
	short := row("7391234567890123456", "短剧热搜样例", "1")
	comic := row("7391234567890123457", "漫剧热搜样例", "1004")
	cells := []any{
		map[string]any{"cell_name": "猜你想搜", "video_data": []any{short, map[string]any{"title": "都市逆袭"}}},
		map[string]any{"cell_data": []any{
			map[string]any{"cell_name": "短剧热搜榜", "video_data": []any{short, short, row("0", "无效项目", "1"), row("7391234567890123458", "小说", "3")}},
			map[string]any{"cell_name": "漫剧热搜榜", "video_data": []any{comic}},
			map[string]any{"cell_name": "热点话题榜", "video_data": []any{short}},
		}},
	}
	encoded, _ := json.Marshal(cells)
	return map[string]any{"code": json.Number("0"), "data": []any{map[string]any{"lynx_data": string(encoded)}}}
}

func TestSearchDiscoveryParsesSearchCellsWithoutInventingPlayableRows(t *testing.T) {
	out, err := parseSearchDiscovery(hotSearchFixture())
	if err != nil || len(out.Guesses) != 2 || len(out.Boards) != 2 {
		t.Fatalf("unexpected search cells: %+v %v", out, err)
	}
	if out.Guesses[1].Query != "都市逆袭" || out.Guesses[1].SeriesID != "" {
		t.Fatal("keyword-only guess became a playable drama")
	}
	if len(out.Boards[0].Items) != 1 || out.Boards[1].Items[0].ContentType != "1004" || out.Boards[0].Items[0].SearchScore != "120万热搜值" {
		t.Fatalf("duplicate, invalid or novel rows leaked: %+v", out.Boards)
	}
	for _, payload := range []map[string]any{
		{"code": 0, "data": []any{map[string]any{"lynx_data": "invalid"}}},
		{"code": 0, "data": []any{map[string]any{"cell_name": "图书榜", "video_data": []any{map[string]any{"series_id": "123", "title": "图书"}}}}},
	} {
		result, err := parseSearchDiscovery(payload)
		if err != nil || len(result.Guesses)+len(result.Boards) != 0 {
			t.Fatalf("unknown/invalid optional cell: %+v %v", result, err)
		}
	}
	if _, err := parseSearchDiscovery(map[string]any{"code": 1}); err == nil {
		t.Fatal("business failure accepted")
	}
}

func TestSearchDiscoveryCacheCoalescesAndSeparatesAccountGenerations(t *testing.T) {
	var cache searchDiscoveryCache
	var calls atomic.Int32
	start, done := make(chan struct{}), make(chan struct{})
	fetch := func(context.Context) (searchDiscoveryResult, error) {
		if calls.Add(1) == 1 {
			close(start)
			<-done
		}
		return parseSearchDiscovery(hotSearchFixture())
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = cache.get(context.Background(), 1, fetch) }()
	}
	<-start
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.get(cancelled, 1, fetch); err != context.Canceled {
		t.Fatalf("waiting request did not cancel: %v", err)
	}
	close(done)
	wg.Wait()
	_, _ = cache.get(context.Background(), 1, fetch)
	if calls.Load() != 1 {
		t.Fatal("cache did not coalesce public reads")
	}
	_, _ = cache.get(context.Background(), 2, fetch)
	if calls.Load() != 2 {
		t.Fatal("previous generation reused")
	}
}

func TestSearchDiscoveryCurrentGenericBoardAndTagShape(t *testing.T) {
	cells := []any{
		map[string]any{"cell_name": "猜你想搜", "search_tag_data": []any{map[string]any{"tag_title": "都市逆袭", "tag_id": "7391234567890123456"}}},
		map[string]any{"cell_data": []any{map[string]any{"cell_name": "热搜榜", "video_data": []any{
			map[string]any{"series_id": json.Number("7391234567890123456"), "title": "漫剧样例", "content_type": 1004, "card_tips": "120万热搜值"},
			map[string]any{"series_id": "7391234567890123457", "title": "短剧样例", "content_type": 1},
			map[string]any{"series_id": "7391234567890123458", "title": "未知类型"},
		}}}},
	}
	encoded, _ := json.Marshal(cells)
	result, err := parseSearchDiscovery(map[string]any{"code": 0, "data": []any{map[string]any{"lynx_data": string(encoded)}}})
	if err != nil || len(result.Boards) != 2 || len(result.Guesses) != 1 {
		t.Fatalf("current cells: %+v %v", result, err)
	}
	if result.Guesses[0].Query != "都市逆袭" || result.Guesses[0].SeriesID != "" {
		t.Fatal("search tag treated as playable drama")
	}
	if result.Boards[0].Items[0].Position != 2 || result.Boards[1].Items[0].SeriesID != "7391234567890123456" {
		t.Fatal("official position or exact ID changed")
	}
}

func TestSearchDiscoveryUsesSignedPublicRequestAndKeepsSearchIndependent(t *testing.T) {
	var reads atomic.Int32
	m := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/service/2/device_register/" {
			ioJSON(w, `{"device_id_str":"7391234567890123456","install_id_str":"7391234567890123457"}`)
			return
		}
		reads.Add(1)
		if r.Method != "GET" || r.URL.Path != "/reading/bookapi/plan/v1/" || r.URL.Query().Get("from") != "search_input_page" || r.URL.Query().Get("search_middle_page_version") != "4" || r.URL.Query().Get("user_is_login") != "0" || r.Header.Get("X-Gorgon") == "" {
			t.Errorf("incorrect search discovery request")
		}
		if r.Header.Get("X-Tt-Token") != "" || strings.Contains(r.Header.Get("Cookie"), "private") || r.URL.Query().Get("query") != "" {
			t.Error("private account/search state leaked")
		}
		writeJSON(w, 200, hotSearchFixture())
	})
	m.disk.Session.Registered = true
	m.disk.Session.Token = "private-token"
	m.disk.Session.Cookies["sessionid"] = "private-cookie"
	s := &server{accounts: m}
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		s.searchDiscovery(w, httptest.NewRequest("GET", "/api/v1/search/discovery", nil))
		if w.Code != 200 {
			t.Fatalf("discovery response: %d %s", w.Code, w.Body.String())
		}
	}
	if reads.Load() != 1 {
		t.Fatal("optional public read not cached")
	}
	if m.disk.Session.Token != "private-token" || m.disk.Session.Cookies["sessionid"] != "private-cookie" {
		t.Fatal("public read mutated account credentials")
	}
	w := httptest.NewRecorder()
	s.searchDiscovery(w, httptest.NewRequest("POST", "/api/v1/search/discovery", nil))
	if w.Code != 405 {
		t.Fatal("unexpected write accepted")
	}
}

func TestLiveSearchDiscovery(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_SEARCH_DISCOVERY") != "1" {
		t.Skip("opt-in anonymous read-only probe")
	}
	device, err := newPassportDevice()
	if err != nil {
		t.Fatal(err)
	}
	c := newPassportClient(accountSession{Device: device, DeviceID: miniReelRandomID(), InstallID: miniReelRandomID(), Cookies: map[string]string{}})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := c.registerDevice(ctx); err != nil {
		t.Fatal(err)
	}
	p, err := c.cloudJSON(ctx, "/reading/bookapi/plan/v1/", "GET", searchDiscoveryQuery(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if target := os.Getenv("HONGGUO_SEARCH_DISCOVERY_RAW"); target != "" {
		body, _ := json.Marshal(p)
		if err := os.WriteFile(target, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	out, err := parseSearchDiscovery(p)
	if err != nil || len(out.Boards) == 0 {
		t.Fatalf("no live search boards: guesses=%d boards=%d err=%v", len(out.Guesses), len(out.Boards), err)
	}
	t.Logf("guesses=%d boards=%d", len(out.Guesses), len(out.Boards))
	for _, board := range out.Boards {
		t.Logf("%s: %d items", board.ID, len(board.Items))
	}
	if target := os.Getenv("HONGGUO_SEARCH_DISCOVERY_RESULT"); target != "" {
		body, _ := json.MarshalIndent(out, "", "  ")
		if err := os.WriteFile(target, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
