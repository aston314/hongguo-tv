package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func boolPtr(value bool) *bool { return &value }

func TestNormalizeAnnouncementsRequiresExplicitEnabledAndExpiry(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	items := normalizeAnnouncements([]announcementItem{
		{ID: "missing", Title: "missing", Enabled: nil},
		{ID: "off", Title: "off", Enabled: boolPtr(false)},
		{ID: "expired", Title: "expired", Enabled: boolPtr(true), ExpiresAt: "2026-11-24T11:00:00Z"},
		{ID: "bad-time", Title: "bad-time", Enabled: boolPtr(true), ExpiresAt: "not-a-time"},
		{ID: "live", Title: "live", Enabled: boolPtr(true), PublishedAt: "2026-11-24T11:00:00Z", ExpiresAt: "2026-11-24T13:00:00Z"},
	}, now)
	if len(items) != 1 || items[0].ID != "live" {
		t.Fatalf("normalized items = %#v, want only live", items)
	}
	if items[0].Dismissible == nil || !*items[0].Dismissible {
		t.Fatal("dismissible should default to true")
	}
}

func TestFilterAnnouncementsByPlatformAndVersion(t *testing.T) {
	items := []announcementItem{
		{ID: "android", Enabled: boolPtr(true), Title: "android", Platforms: []string{"android"}, BeforeVersion: "0.2.181"},
		{ID: "all", Enabled: boolPtr(true), Title: "all", Platforms: []string{"all"}},
		{ID: "new", Enabled: boolPtr(true), Title: "new", BeforeVersion: "0.2.100"},
	}
	got := filterAnnouncements(items, "android", "0.2.180")
	if len(got) != 2 || got[0].ID != "android" || got[1].ID != "all" {
		t.Fatalf("filtered items = %#v", got)
	}
	if len(filterAnnouncements(items, "desktop", "0.2.181")) != 1 {
		t.Fatal("desktop at the cutoff should only see the global item")
	}
}

func TestAnnouncementServiceUsesFallbackAndCache(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/announcements.json" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if calls == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		io.WriteString(w, `{"schema":1,"channel":"stable","items":[{"id":"one","enabled":true,"title":"One"}]}`)
	}))
	defer server.Close()
	s := &announcementService{client: server.Client(), primaryBase: server.URL, rawBase: server.URL}
	// Both configured bases point to the same test server. The first request
	// exercises the fallback, then the successful result is cached.
	if got := s.active(context.Background(), "android", "0.2.180"); len(got) != 1 || got[0].ID != "one" {
		t.Fatalf("first active result = %#v", got)
	}
	if calls != 2 {
		t.Fatalf("calls after fallback = %d, want 2", calls)
	}
	if got := s.active(context.Background(), "android", "0.2.180"); len(got) != 1 {
		t.Fatalf("cached active result = %#v", got)
	}
	if calls != 2 {
		t.Fatalf("cached calls = %d, want 2", calls)
	}
}

func TestAnnouncementServiceIgnoresUnsupportedDocument(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"schema":2,"channel":"stable","items":[{"id":"bad","enabled":true,"title":"Bad"}]}`)
	}))
	defer server.Close()
	s := &announcementService{client: server.Client(), primaryBase: server.URL, rawBase: ""}
	if got := s.active(context.Background(), "android", "0.2.180"); len(got) != 0 {
		t.Fatalf("unsupported document = %#v", got)
	}
}

func TestAnnouncementsHandlerIsSafeWhenRemoteConfigIsUnavailable(t *testing.T) {
	server := &server{announcementsService: &announcementService{client: http.DefaultClient, primaryBase: "http://127.0.0.1:1", rawBase: ""}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/announcements?platform=android&version=0.2.180", nil)
	server.announcements(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var payload struct {
		OK   bool `json:"ok"`
		Data struct {
			Items []announcementItem `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.OK || len(payload.Data.Items) != 0 {
		t.Fatalf("payload = %#v", payload)
	}
}
