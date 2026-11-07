package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type searchHotItem struct {
	Drama
	Position    int    `json:"position,omitempty"`
	SearchScore string `json:"search_score,omitempty"`
	Query       string `json:"query,omitempty"`
}

type searchHotBoard struct {
	ID    string          `json:"id"`
	Items []searchHotItem `json:"items"`
}

type searchDiscoveryResult struct {
	Guesses []searchHotItem  `json:"guesses"`
	Boards  []searchHotBoard `json:"boards"`
}

// This optional search-page read has its own bounded cache. It never changes
// search cursors, playback identities or the user's account/library state.
type searchDiscoveryCache struct {
	mu         sync.Mutex
	generation uint64
	data       searchDiscoveryResult
	err        error
	expires    time.Time
	pending    chan struct{}
}

func (c *searchDiscoveryCache) get(ctx context.Context, generation uint64, fetch func(context.Context) (searchDiscoveryResult, error)) (searchDiscoveryResult, error) {
	for {
		if err := ctx.Err(); err != nil {
			return searchDiscoveryResult{}, err
		}
		c.mu.Lock()
		if c.generation == generation && time.Now().Before(c.expires) {
			data, err := c.data, c.err
			c.mu.Unlock()
			return data, err
		}
		if done := c.pending; done != nil {
			c.mu.Unlock()
			select {
			case <-ctx.Done():
				return searchDiscoveryResult{}, ctx.Err()
			case <-done:
				continue
			}
		}
		done := make(chan struct{})
		c.pending = done
		c.mu.Unlock()
		data, err := fetch(ctx)
		c.mu.Lock()
		c.generation, c.data, c.err = generation, data, err
		ttl := 10 * time.Minute
		if err != nil || len(data.Guesses)+len(data.Boards) == 0 {
			ttl = time.Minute
		}
		// A navigation cancellation must not poison a subsequent visit.
		if ctx.Err() == nil {
			c.expires = time.Now().Add(ttl)
		} else {
			c.expires = time.Time{}
		}
		c.pending = nil
		close(done)
		c.mu.Unlock()
		return data, err
	}
}

func searchDiscoveryQuery() url.Values {
	return url.Values{
		"user_is_login": {"0"}, "bookstore_tab": {"16"}, "bookstore_tab_type": {"16"},
		"scene": {"10"}, "limit": {"0"}, "tab_name": {"feed"}, "from": {"search_input_page"},
		"query_history_removed": {"false"}, "offset": {"0"}, "search_middle_page_version": {"4"},
		"search_source": {"1"}, "new_search_middle_page": {"true"}, "hot_word_exchange": {"false"},
	}
}

func (s *server) searchDiscovery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.accounts == nil {
		writeError(w, http.StatusServiceUnavailable, "热门搜索暂不可用")
		return
	}
	client, generation, err := s.accounts.listClient(false)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "热门搜索暂不可用")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	data, err := s.searchDiscoveryCache.get(ctx, generation, func(ctx context.Context) (searchDiscoveryResult, error) {
		if err := s.accounts.ensureDeviceRegistered(ctx, client, generation); err != nil {
			return searchDiscoveryResult{}, err
		}
		// Public suggestions must not send account cookies/token or search history.
		client.session.Token, client.uid = "", ""
		client.session.Cookies = map[string]string{"install_id": client.session.InstallID}
		payload, err := client.cloudJSON(ctx, "/reading/bookapi/plan/v1/", http.MethodGet, searchDiscoveryQuery(), nil)
		if err != nil {
			return searchDiscoveryResult{}, err
		}
		return parseSearchDiscovery(payload)
	})
	if err != nil || !s.accounts.sameGeneration(generation) {
		writeError(w, http.StatusServiceUnavailable, "热门搜索暂不可用")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": data})
}

// Only known search cells are accepted. Topic, novel and advertising cells
// must not become playable dramas just because they also contain an ID.
func parseSearchDiscovery(payload map[string]any) (searchDiscoveryResult, error) {
	out := searchDiscoveryResult{Guesses: []searchHotItem{}, Boards: []searchHotBoard{}}
	if asString(payload["code"]) != "0" {
		return out, errors.New("hot search request failed")
	}
	boards := map[string][]searchHotItem{}
	var visit func(any, int)
	visit = func(value any, depth int) {
		if depth > 8 {
			return
		}
		switch value := value.(type) {
		case string:
			if len(value) > 2*1024*1024 {
				return
			}
			var decoded any
			decoder := json.NewDecoder(strings.NewReader(value))
			decoder.UseNumber()
			if decoder.Decode(&decoded) == nil {
				visit(decoded, depth+1)
			}
		case []any:
			for i, cell := range value {
				if i >= 128 {
					break
				}
				visit(cell, depth+1)
			}
		case map[string]any:
			name := asString(value["cell_name"])
			if name == "猜你想搜" && len(out.Guesses) == 0 {
				out.Guesses = searchDiscoveryItems(value["video_data"], "", 4)
				if len(out.Guesses) == 0 {
					if tags, ok := value["search_tag_data"].([]any); ok {
						rows := []any{}
						for _, raw := range tags {
							if tag, ok := asMap(raw); ok {
								rows = append(rows, map[string]any{"title": tag["tag_title"]})
							}
						}
						out.Guesses = searchDiscoveryItems(rows, "", 4)
					}
				}
			}
			id := map[string]string{"短剧热搜榜": "short", "漫剧热搜榜": "comic"}[name]
			if id != "" && len(boards[id]) == 0 {
				boards[id] = searchDiscoveryItems(value["video_data"], id, 6)
			}
			// Some current plans name the board simply 热搜榜. Classify its
			// explicit video types instead of guessing from the device/heading.
			if name == "热搜榜" {
				for _, item := range searchDiscoveryItems(value["video_data"], "mixed", 6) {
					id := "short"
					if item.ContentType == "1004" {
						id = "comic"
					}
					duplicate := false
					for _, row := range boards[id] {
						if row.SeriesID == item.SeriesID {
							duplicate = true
							break
						}
					}
					if !duplicate && len(boards[id]) < 6 {
						boards[id] = append(boards[id], item)
					}
				}
			}
			for _, key := range []string{"lynx_data", "cell_data"} {
				visit(value[key], depth+1)
			}
		}
	}
	// Account/list payloads are deliberately not searched recursively.
	visit(payload["data"], 0)
	for _, id := range []string{"short", "comic"} {
		if len(boards[id]) > 0 {
			out.Boards = append(out.Boards, searchHotBoard{ID: id, Items: boards[id]})
		}
	}
	return out, nil
}

func searchDiscoveryItems(value any, board string, limit int) []searchHotItem {
	out := []searchHotItem{}
	seen := map[string]bool{}
	rows, _ := value.([]any)
	for index, raw := range rows {
		row, ok := asMap(raw)
		if !ok {
			continue
		}
		title, valid := normalizeSearchQuery(asString(row["title"]))
		if !valid {
			continue
		}
		id := firstNonEmpty(asString(row["series_id_str"]), asString(row["series_id"]))
		kind := asString(row["content_type"])
		if kind != "" && kind != "1" && kind != "7" && kind != "1004" {
			continue
		}
		if board == "mixed" && kind == "" {
			continue
		}
		key := id
		item := searchHotItem{}
		if !validID(id) || id == "0" {
			if board != "" {
				continue
			}
			item.Query, item.Title, key = title, title, "query:"+title
		} else {
			item.Drama, _ = normalizeDrama(row)
			item.SeriesID, item.Title = id, title
			if kind == "" {
				kind = "1"
				if board == "comic" {
					kind = "1004"
				}
			}
			item.ContentType = kind
			item.Position = index + 1
			item.SearchScore = firstNonEmpty(asString(row["card_tips"]), asString(row["rec_text"]))
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, item)
		if len(out) >= limit {
			break
		}
	}
	return out
}
