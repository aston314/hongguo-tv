package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// Public batch-detail response captured on 2026-11-16. Preserve both numeric
// and string IDs and the absent album_info; no account or signed URLs remain.
func cloudCreatorMetadataFixture(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("testdata/cloud-metadata-creator-album.json")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCreatorAlbumFlatMetadataCard(t *testing.T) {
	for _, wrapped := range []bool{false, true} {
		var payload map[string]any
		decoder := json.NewDecoder(strings.NewReader(cloudCreatorMetadataFixture(t)))
		decoder.UseNumber()
		if err := decoder.Decode(&payload); err != nil {
			t.Fatal(err)
		}
		data, _ := asMap(payload["data"])
		row, _ := asMap(data[fixtureAlbumID])
		video, _ := asMap(row["video_data"])
		value := any(video)
		if wrapped {
			value = row
		}
		card, ok := normalizeDrama(value)
		if !ok || card.SeriesID != fixtureAlbumID || card.Title != "《反相之地》续集" || card.ContentType != "1003" || card.MetadataPending {
			t.Fatalf("valid flat album rejected: wrapped=%t card=%+v", wrapped, card)
		}
		if card.EpisodeCount != 0 || card.Vid != "" || len(card.VidList) != 0 || len(card.Episodes) != 0 {
			t.Fatal("batch metadata must not invent an album directory")
		}
	}
}

func TestCreatorAlbumFlatMetadataRejectsInvalidIdentityAndNestedData(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"missing_id", func(v map[string]any) { delete(v, "series_id"); delete(v, "series_id_str") }},
		{"zero_id", func(v map[string]any) { v["series_id"], v["series_id_str"] = "0", "0" }},
		{"conflicting_ids", func(v map[string]any) { v["series_id"] = "7699818221737610266" }},
		{"malformed_album", func(v map[string]any) { v["album_info"] = []any{} }},
		{"null_album", func(v map[string]any) { v["album_info"] = nil }},
		{"empty_album", func(v map[string]any) { v["album_info"] = map[string]any{} }},
		{"wrong_album", func(v map[string]any) { v["album_info"] = map[string]any{"album_id_str": "7699818221737610266"} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			video := map[string]any{"content_type": "1003", "series_id": fixtureAlbumID, "series_id_str": fixtureAlbumID, "series_title": "合集"}
			test.mutate(video)
			if _, ok := normalizeDrama(video); ok {
				t.Fatal("invalid album accepted")
			}
		})
	}
}

func TestCreatorAlbumFlatMetadataRetainsCardFieldsWithoutUsingPreview(t *testing.T) {
	for _, ids := range []map[string]any{
		{"series_id": json.Number(fixtureAlbumID)},
		{"series_id_str": fixtureAlbumID},
	} {
		card := map[string]any{
			"content_type": "1003", "series_title": "合集资料", "series_cover": "https://example.com/album.jpg",
			"series_intro": "合集简介", "episode_cnt": json.Number("15"), "series_status": "1",
			"category_schema": `[{"name":"悬疑"}]`, "vid": "7699812380099742744",
			"vid_list": []any{"7699812380099742744"}, "video_list": []any{map[string]any{"vid": "7699812380099742744"}},
		}
		for key, value := range ids {
			card[key] = value
		}
		drama, ok := normalizeDrama(card)
		if !ok || drama.SeriesID != fixtureAlbumID || drama.Cover != "https://example.com/album.jpg" || drama.Intro != "合集简介" || drama.EpisodeCount != 15 || drama.SeriesStatus != "1" || len(drama.Tags) != 1 || drama.Tags[0] != "悬疑" {
			t.Fatalf("flat card fields lost: %+v", drama)
		}
		if drama.Vid != "" || len(drama.VidList) != 0 || len(drama.Episodes) != 0 {
			t.Fatal("flat card preview became a playback directory")
		}
	}
}

func TestCloudMetadataCreatorAlbumRealResponse(t *testing.T) {
	payload := cloudCreatorMetadataFixture(t)
	for _, ids := range [][]string{{fixtureSeries, fixtureAlbumID}, {fixtureAlbumID, fixtureSeries}} {
		c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) { ioJSON(w, payload) })
		cards, err := c.libraryMetadata(context.Background(), ids)
		close()
		if err != nil || len(cards) != 2 || cards[fixtureAlbumID].Title != "《反相之地》续集" || cards[fixtureAlbumID].ContentType != "1003" || cards[fixtureSeries].EpisodeCount != 209 {
			t.Fatalf("mixed metadata lost valid album: cards=%+v err=%v", cards, err)
		}
	}
}

func TestCloudCreatorAlbumSyncPreservesMembershipProgressAndDetailRoute(t *testing.T) {
	payload := cloudCreatorMetadataFixture(t)
	albumDetail := creatorAlbumFixture(t)
	for _, test := range []struct {
		name              string
		history, favorite bool
	}{{"favorite", false, true}, {"history", true, false}, {"both", true, true}} {
		t.Run(test.name, func(t *testing.T) {
			progressReads, uploads, albumRequests := 0, 0, 0
			m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/reading/bookapi/read_history/list/v":
					rows := []any{map[string]any{"book_id_str": fixtureSeries, "vid_index": 1, "read_timestamp_ms": 1700000000000}}
					if test.history {
						rows = append(rows, map[string]any{"book_id_str": fixtureAlbumID, "vid": "7699812380099742744", "vid_index": 1, "current_play_position": 5000, "read_timestamp_ms": 1700000000000})
					}
					writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"data_list": rows, "has_more": false}})
				case "/reading/bookapi/bookshelf/video/list/v":
					rows := []any{map[string]any{"series_id": fixtureSeries, "collect_time": 1700000000}}
					if test.favorite {
						rows = append(rows, map[string]any{"series_id": fixtureAlbumID, "collect_time": 1700000000})
					}
					writeJSON(w, 200, map[string]any{"code": 0, "data": map[string]any{"video_shelf_info": rows}})
				case "/novel/player/multi_video_detail/preload/v1":
					ioJSON(w, payload)
				case "/reading/bookapi/read_progress/get/v":
					progressReads++
					ioJSON(w, fmt.Sprintf(`{"code":0,"video_data":[{"series_id":%q,"episode_count":15}]}`, fixtureAlbumID))
				case "/reading/bookapi/read_history/update/v", "/reading/bookapi/read_progress/upload/v", "/reading/bookapi/bookshelf/video/update/v":
					uploads++
					ioJSON(w, `{"code":0}`)
				case "/novel/player/album_detail/v1/":
					albumRequests++
					writeJSON(w, 200, albumDetail)
				default:
					t.Errorf("unexpected sync endpoint: %s", r.URL.Path)
				}
			})
			m.synchronize(context.Background())
			entries := map[string]LibraryEntry{}
			for _, entry := range m.librarySnapshot().Entries {
				entries[entry.Drama.SeriesID] = entry
			}
			album := entries[fixtureAlbumID]
			status := m.status().Sync
			if len(entries) != 2 || status.Error != "" || status.LastSync == 0 || progressReads != 1 || albumRequests != 0 {
				t.Fatalf("mixed sync incomplete: entries=%d status=%+v progress=%d album_requests=%d", len(entries), status, progressReads, albumRequests)
			}
			if album.Drama.SeriesID != fixtureAlbumID || album.Drama.Title != "《反相之地》续集" || album.Drama.ContentType != "1003" || album.Drama.MetadataPending || album.Drama.EpisodeCount != 15 {
				t.Fatalf("album not correctly restored: %+v", album)
			}
			if (album.LastPlayedAt > 0) != test.history || (album.FavoriteAt > 0) != test.favorite || entries[fixtureSeries].LastPlayedAt == 0 || entries[fixtureSeries].FavoriteAt == 0 {
				t.Fatal("history or favorite membership changed")
			}
			owner, yes := m.status().Profile.UID, true
			if _, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "progress", Drama: album.Drama, Episode: 1, VideoID: "7699812380099742744", Position: 12, Duration: 361}); err != nil {
				t.Fatal(err)
			}
			if _, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "favorite", Drama: album.Drama, Value: &yes}); err != nil {
				t.Fatal(err)
			}
			m.synchronize(context.Background())
			if uploads != 3 || m.status().Sync.Pending != 0 || m.status().Sync.Error != "" {
				t.Fatal("album prevented progress or favorite upload")
			}
			for _, entry := range m.librarySnapshot().Entries {
				if entry.Drama.SeriesID == fixtureAlbumID && (entry.Position != 12 || entry.VideoID != "7699812380099742744" || entry.FavoriteAt == 0 || entry.Drama.ContentType != "1003") {
					t.Fatal("cloud replay overwrote newer album progress")
				}
			}
			s := &server{accounts: m}
			w := httptest.NewRecorder()
			s.seriesDetail(w, httptest.NewRequest("GET", "/api/v1/series/detail?series_id="+album.Drama.SeriesID+"&content_type="+album.Drama.ContentType, nil))
			var response struct {
				Data SeriesDetailResult `json:"data"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || albumRequests != 1 || len(response.Data.Episodes) != 15 || response.Data.ContentType != "1003" {
				t.Fatal("synced album no longer resolves its complete playback directory")
			}
		})
	}
}
