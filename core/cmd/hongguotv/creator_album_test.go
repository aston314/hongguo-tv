package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
)

func creatorAlbumFixture(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile("testdata/creator-album.json")
	if err != nil {
		t.Fatal(err)
	}
	var p map[string]any
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.UseNumber()
	if err = d.Decode(&p); err != nil {
		t.Fatal(err)
	}
	return p
}

const fixtureAlbumID = "7699818221737610265"

func TestCreatorAlbumCardAndCompleteDirectory(t *testing.T) {
	p := creatorAlbumFixture(t)
	data, _ := asMap(p["data"])
	a, _ := asMap(data["album_data"])
	// Search contains only a preview of the first upload, never the directory.
	search := map[string]any{}
	for k, v := range a {
		search[k] = v
	}
	search["video_detail_list"] = a["video_detail_list"].([]any)[:1]
	card, ok := normalizeDrama(map[string]any{"content_type": json.Number("1003"), "series_id": fixtureAlbumID, "album_info": search})
	if !ok || card.SeriesID != fixtureAlbumID || card.EpisodeCount != 15 || card.Title != "《反相之地》续集" || card.ContentType != "1003" || card.Vid != "" || len(card.VidList) != 0 {
		t.Fatalf("bad card: %+v", card)
	}
	detail, err := parseCreatorAlbum(p, fixtureAlbumID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Episodes) != 15 || detail.AccessibleEpisodeCnt != 15 || detail.Vid != "7699812380099742744" || detail.VidList[14] != "7704677415305350168" || detail.ContentType != "1003" {
		t.Fatalf("bad directory: %+v", detail)
	}
	for i, e := range detail.Episodes {
		if e.Index != i+1 || e.VideoID != detail.VidList[i] || e.Locked || e.Title == "" {
			t.Fatalf("bad episode %+v", e)
		}
	}
	// Repeated titles from the author are distinct uploads, not duplicates.
	if detail.Episodes[9].Title != detail.Episodes[12].Title || detail.Episodes[9].VideoID == detail.Episodes[12].VideoID {
		t.Fatal("fixture no longer covers repeated titles")
	}
	cleaned := cleanLibraryDrama(detail.Drama)
	if cleaned.SeriesID != fixtureAlbumID || cleaned.ContentType != "1003" || cleaned.Vid != "" || cleaned.VidList != nil {
		t.Fatalf("lost resume identity: %+v", cleaned)
	}
}
func TestCreatorAlbumRejectsIncompleteOrWrongDirectory(t *testing.T) {
	for _, kind := range []string{"id", "empty", "partial", "duplicate", "bad-id", "wrong-type", "has-more", "business"} {
		t.Run(kind, func(t *testing.T) {
			p := creatorAlbumFixture(t)
			d, _ := asMap(p["data"])
			a, _ := asMap(d["album_data"])
			rows := a["video_detail_list"].([]any)
			switch kind {
			case "id":
				a["album_id_str"] = "999"
			case "empty":
				a["video_detail_list"] = []any{}
			case "partial":
				a["video_detail_list"] = rows[:1]
			case "duplicate":
				rows[1] = rows[0]
			case "bad-id":
				r, _ := asMap(rows[1])
				r["series_id_str"] = "not-an-id"
			case "wrong-type":
				r, _ := asMap(rows[1])
				r["content_type"] = "1004"
			case "has-more":
				d["has_more"] = true
			case "business":
				p["code"] = "101001"
			}
			if _, err := parseCreatorAlbum(p, fixtureAlbumID); err == nil {
				t.Fatal("accepted invalid directory")
			}
		})
	}
	if _, ok := normalizeDrama(map[string]any{"series_id": "999", "content_type": "1003", "album_info": map[string]any{"album_id_str": fixtureAlbumID}}); ok {
		t.Fatal("accepted mismatched card")
	}
}
func TestCreatorAlbumDetailRouteAndAccountBoundary(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "anonymous", true: "account-changed"}[changed], func(t *testing.T) {
			p := creatorAlbumFixture(t)
			calls := 0
			var m *accountManager
			m = fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/service/2/device_register/" {
					ioJSON(w, `{"device_id_str":"7391234567890123456","install_id_str":"7391234567890123457"}`)
					return
				}
				calls++
				if r.Method != "POST" || r.URL.Path != "/novel/player/album_detail/v1/" || r.Header.Get("X-Gorgon") == "" {
					t.Error("wrong signed album request")
				}
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				want := map[string]any{"album_id": fixtureAlbumID, "series_ids": []any{}, "need_video_detail_info": true, "biz_param": map[string]any{"video_platform": float64(3)}}
				if !reflect.DeepEqual(body, want) {
					t.Errorf("wrong body: %v", body)
				}
				if changed {
					m.mu.Lock()
					m.generation++
					m.mu.Unlock()
				}
				json.NewEncoder(w).Encode(p)
			})
			s := &server{accounts: m}
			w := httptest.NewRecorder()
			s.seriesDetail(w, httptest.NewRequest("GET", "/api/v1/series/detail?series_id="+fixtureAlbumID+"&content_type=1003", nil))
			if calls != 1 {
				t.Fatal("unexpected album calls", calls)
			}
			if changed {
				if w.Code != 409 {
					t.Fatalf("stale data exposed: %d", w.Code)
				}
				return
			}
			if w.Code != 200 {
				t.Fatalf("detail failed %d %s", w.Code, w.Body)
			}
			var response struct {
				Data SeriesDetailResult `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if len(response.Data.Episodes) != 15 {
				t.Fatalf("incomplete route: %+v", response)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := m.CreatorAlbumDetail(ctx, fixtureAlbumID); err == nil {
				t.Fatal("ignored cancellation")
			}
		})
	}
}
