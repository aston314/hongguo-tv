package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	announcementRawBase    = "https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main"
	announcementGhfastBase = "https://ghfast.top/https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main"
	announcementPath       = "announcements.json"
	announcementMaxPayload = 128 << 10
	announcementCacheTTL   = 5 * time.Minute
)

type announcementsDocument struct {
	Schema  int                `json:"schema"`
	Channel string             `json:"channel"`
	Items   []announcementItem `json:"items"`
}

type announcementAction struct {
	Type  string `json:"type,omitempty"`
	Label string `json:"label,omitempty"`
}

type announcementItem struct {
	ID            string              `json:"id"`
	Enabled       *bool               `json:"enabled"`
	Kind          string              `json:"kind,omitempty"`
	Status        string              `json:"status,omitempty"`
	Level         string              `json:"level,omitempty"`
	Title         string              `json:"title"`
	Summary       string              `json:"summary,omitempty"`
	Body          string              `json:"body,omitempty"`
	Platforms     []string            `json:"platforms,omitempty"`
	BeforeVersion string              `json:"before_version,omitempty"`
	PublishedAt   string              `json:"published_at,omitempty"`
	ExpiresAt     string              `json:"expires_at,omitempty"`
	Dismissible   *bool               `json:"dismissible,omitempty"`
	Action        *announcementAction `json:"action,omitempty"`
}

type announcementService struct {
	mu          sync.Mutex
	client      *http.Client
	primaryBase string
	rawBase     string
	items       []announcementItem
	fetchedAt   time.Time
}

func newAnnouncementService(client *http.Client) *announcementService {
	if client == nil {
		client = &http.Client{Timeout: 6 * time.Second}
	}
	return &announcementService{client: client, primaryBase: announcementGhfastBase, rawBase: announcementRawBase}
}

func (s *announcementService) fetch(ctx context.Context) ([]announcementItem, error) {
	var failures []string
	for _, base := range []string{s.primaryBase, s.rawBase} {
		if strings.TrimSpace(base) == "" {
			continue
		}
		target := strings.TrimRight(base, "/") + "/" + announcementPath
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "HongguoTV-Announcements/1.0")
		resp, err := s.client.Do(req)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, announcementMaxPayload+1))
		resp.Body.Close()
		if readErr != nil {
			failures = append(failures, readErr.Error())
			continue
		}
		if resp.StatusCode != http.StatusOK {
			failures = append(failures, fmt.Sprintf("HTTP %d", resp.StatusCode))
			continue
		}
		if len(body) == 0 || len(body) > announcementMaxPayload {
			failures = append(failures, "响应大小无效")
			continue
		}
		var document announcementsDocument
		if err := json.Unmarshal(body, &document); err != nil {
			failures = append(failures, err.Error())
			continue
		}
		if document.Schema != 1 || document.Channel != "stable" {
			failures = append(failures, "公告清单版本或渠道无效")
			continue
		}
		return normalizeAnnouncements(document.Items, time.Now().UTC()), nil
	}
	if len(failures) == 0 {
		return nil, fmt.Errorf("公告数据源未配置")
	}
	return nil, fmt.Errorf("公告数据源不可用: %s", strings.Join(failures, "; "))
}

func normalizeAnnouncements(items []announcementItem, now time.Time) []announcementItem {
	result := make([]announcementItem, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		item.ID = strings.TrimSpace(item.ID)
		item.Title = strings.TrimSpace(item.Title)
		item.Summary = strings.TrimSpace(item.Summary)
		item.Body = strings.TrimSpace(item.Body)
		if item.ID == "" || item.Title == "" || item.Enabled == nil || !*item.Enabled || seen[item.ID] {
			continue
		}
		if !announcementPlatformAllowed(item.Platforms, "") {
			continue
		}
		if item.PublishedAt != "" {
			published, err := time.Parse(time.RFC3339, item.PublishedAt)
			if err != nil || published.After(now) {
				continue
			}
		}
		if item.ExpiresAt != "" {
			expires, err := time.Parse(time.RFC3339, item.ExpiresAt)
			if err != nil || !expires.After(now) {
				continue
			}
		}
		if item.Action != nil {
			item.Action.Type = strings.TrimSpace(item.Action.Type)
			item.Action.Label = strings.TrimSpace(item.Action.Label)
			if item.Action.Type != "check_update" {
				item.Action = nil
			}
		}
		if item.Dismissible == nil {
			dismissible := true
			item.Dismissible = &dismissible
		}
		seen[item.ID] = true
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].PublishedAt > result[j].PublishedAt
	})
	return result
}

func announcementPlatformAllowed(platforms []string, platform string) bool {
	platform = strings.ToLower(strings.TrimSpace(platform))
	if len(platforms) == 0 || platform == "" {
		return true
	}
	for _, value := range platforms {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "all" || value == platform {
			return true
		}
	}
	return false
}

func announcementVersionBefore(current, before string) bool {
	current = strings.TrimPrefix(strings.TrimSpace(current), "v")
	before = strings.TrimPrefix(strings.TrimSpace(before), "v")
	if current == "" || before == "" {
		return true
	}
	parse := func(value string) []int {
		parts := strings.SplitN(value, "-", 2)[0]
		pieces := strings.Split(parts, ".")
		result := make([]int, 0, len(pieces))
		for _, piece := range pieces {
			n := 0
			for _, char := range piece {
				if char < '0' || char > '9' {
					return nil
				}
				n = n*10 + int(char-'0')
			}
			result = append(result, n)
		}
		return result
	}
	a, b := parse(current), parse(before)
	if a == nil || b == nil {
		return true
	}
	for len(a) < len(b) {
		a = append(a, 0)
	}
	for len(b) < len(a) {
		b = append(b, 0)
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func (s *announcementService) active(ctx context.Context, platform, version string) []announcementItem {
	s.mu.Lock()
	if time.Since(s.fetchedAt) < announcementCacheTTL {
		items := filterAnnouncements(s.items, platform, version)
		s.mu.Unlock()
		return items
	}
	s.mu.Unlock()

	items, err := s.fetch(ctx)
	if err == nil {
		s.mu.Lock()
		s.items, s.fetchedAt = items, time.Now()
		s.mu.Unlock()
	} else {
		// A stale successful fetch is safer than turning a temporary network
		// failure into a UI error. The first fetch simply returns an empty list.
		s.mu.Lock()
		items = append([]announcementItem(nil), s.items...)
		s.mu.Unlock()
	}
	return filterAnnouncements(items, platform, version)
}

func filterAnnouncements(items []announcementItem, platform, version string) []announcementItem {
	result := make([]announcementItem, 0, len(items))
	for _, item := range items {
		if !announcementPlatformAllowed(item.Platforms, platform) || !announcementVersionBefore(version, item.BeforeVersion) {
			continue
		}
		result = append(result, item)
	}
	return result
}

func (s *server) announcements(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	platform := r.URL.Query().Get("platform")
	version := r.URL.Query().Get("version")
	items := []announcementItem{}
	if s.announcementsService != nil {
		items = s.announcementsService.active(r.Context(), platform, version)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"items": items}})
}
