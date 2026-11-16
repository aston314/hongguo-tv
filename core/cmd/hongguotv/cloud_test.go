package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCloudHistoryPreservesOfficialAndSavedSeasonNumbers(t *testing.T) {
	for _, fixture := range []struct {
		serverSeason int
		title        string
		savedSeason  int
	}{
		{0, "基础剧名", 13},
		{13, "基础剧名", 0},
		{13, "", 2},
		{0, "", 13},
	} {
		c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/reading/bookapi/read_history/list/v":
				ioJSON(w, fmt.Sprintf(`{"code":0,"data":{"data_list":[{"book_id_str":"7690163276214176792","book_name":%q,"vid_index":1,"read_timestamp_ms":1700000000000,"season_index":%d,"is_multi_season":%t}],"has_more":false}}`, fixture.title, fixture.serverSeason, fixture.serverSeason > 0))
			case "/reading/bookapi/bookshelf/video/list/v":
				ioJSON(w, `{"code":0,"data":{"video_shelf_info":[]}}`)
			case "/reading/bookapi/read_progress/get/v":
				ioJSON(w, `{"code":0,"video_data":[]}`)
			default:
				t.Error("unexpected route")
			}
		})
		local := LibraryData{}
		if fixture.savedSeason > 0 {
			local.Entries = []LibraryEntry{{Drama: Drama{SeriesID: fixtureSeries, Title: "基础剧名", SeasonIndex: fixture.savedSeason, MultiSeason: true}}}
		}
		rows, e := c.pullLibrary(context.Background(), "123456789", local, nil)
		close()
		if e != nil || len(rows) != 1 || rows[0].Drama.SeasonIndex != 13 || !rows[0].Drama.MultiSeason {
			t.Fatal("history sync lost confirmed season", e)
		}
	}
}

func TestCloudHistoryBeyondFivePagesAndOfficialCursorFallback(t *testing.T) {
	for _, missingCursor := range []bool{false, true} {
		t.Run(fmt.Sprint(missingCursor), func(t *testing.T) {
			pages := 0
			c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/reading/bookapi/read_history/list/v":
					if r.URL.Query().Get("limit") != "0" || r.URL.Query().Get("offset") != fmt.Sprint(pages*500) {
						t.Error("wrong official history cursor")
					}
					next := (pages + 1) * 500
					if missingCursor {
						next = 0
					}
					pages++
					ioJSON(w, fmt.Sprintf(`{"code":0,"data":{"data_list":[{"book_id_str":"76901632762141767%d","book_name":"分页剧","vid_index":1,"read_timestamp_ms":1700000000000}],"has_more":%t,"next_offset":%d}}`, 90+pages, pages < 6, next))
				case "/reading/bookapi/bookshelf/video/list/v":
					ioJSON(w, `{"code":0,"data":{"video_shelf_info":[]}}`)
				case "/reading/bookapi/read_progress/get/v":
					ioJSON(w, `{"code":0,"video_data":[]}`)
				default:
					t.Error("unexpected cloud route")
				}
			})
			defer close()
			rows, err := c.pullLibrary(context.Background(), "123456789", LibraryData{}, nil)
			if err != nil || pages != 6 || len(rows) != 6 {
				t.Fatalf("incomplete history: pages=%d count=%d err=%v", pages, len(rows), err)
			}
		})
	}
}

func TestCloudIncompleteHistoryNeverReturnsPartialSnapshot(t *testing.T) {
	for _, repeated := range []bool{false, true} {
		calls := 0
		c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/reading/bookapi/read_history/list/v" {
				t.Error("partial history must not continue syncing")
			}
			calls++
			if !repeated {
				ioJSON(w, `{"code":0,"data":{"data_list":[],"has_more":true}}`)
				return
			}
			ioJSON(w, `{"code":0,"data":{"data_list":[{"book_id_str":"7690163276214176792","vid_index":1,"read_timestamp_ms":1700000000000}],"has_more":true}}`)
		})
		rows, err := c.pullLibrary(context.Background(), "123456789", LibraryData{}, nil)
		close()
		if err == nil || rows != nil || calls > 2 {
			t.Fatal("incomplete page acknowledged or retried indefinitely")
		}
	}
}

func TestCloudBatchMetadataAndUnavailableFavorite(t *testing.T) {
	const other = "7690163276214176794"
	c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/reading/bookapi/read_history/list/v":
			ioJSON(w, `{"code":0,"data":{"data_list":[],"has_more":false}}`)
		case "/reading/bookapi/bookshelf/video/list/v":
			ioJSON(w, `{"code":0,"data":{"video_shelf_info":[{"series_id":"7690163276214176792","collect_time":1700000000},{"series_id":"7690163276214176794","collect_time":1699999900}]}}`)
		case "/novel/player/multi_video_detail/preload/v1":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			biz, _ := asMap(body["biz_param"])
			if r.Method != "POST" || body["dr_scene"] != "preload" || body["series_id"] != fixtureSeries+","+other || biz["source"] != float64(7) || biz["detail_page_version"] != float64(0) {
				t.Error("wrong batch metadata protocol")
			}
			ioJSON(w, `{"code":0,"data":{"7690163276214176792":{"video_data":{"series_id_str":"7690163276214176792","series_title":"批量收藏","episode_cnt":80,"series_cover":"https://example.com/poster.jpg"}}}}`)
		case "/reading/bookapi/read_progress/get/v":
			ioJSON(w, `{"code":0,"video_data":[]}`)
		default:
			t.Error("unexpected cloud request")
		}
	})
	defer close()
	rows, err := c.pullLibrary(context.Background(), "123456789", LibraryData{}, nil)
	if err != nil || len(rows) != 2 {
		t.Fatalf("lost favorite when metadata omitted: count=%d %v", len(rows), err)
	}
	byID := map[string]LibraryEntry{}
	for _, r := range rows {
		byID[r.Drama.SeriesID] = r
	}
	if byID[fixtureSeries].Drama.Title != "批量收藏" || byID[fixtureSeries].FavoriteAt != 1700000000000 || !byID[other].Drama.MetadataPending || byID[other].FavoriteAt <= 0 {
		t.Fatal("metadata/timestamp lost")
	}
	s, _ := newLibraryStore(t.TempDir())
	if err := s.mergeCloud(rows, 0); err != nil {
		t.Fatal(err)
	}
	if len(s.snapshot().Entries) != 2 || s.snapshot().Entries[0].FavoriteAt <= 0 {
		t.Fatal("zero sync stamp erased cloud favorite")
	}
	row := byID[other]
	row.Drama = Drama{SeriesID: other, Title: "重试已加载"}
	if err := s.mergeCloud([]LibraryEntry{byID[fixtureSeries], row}, 0); err != nil {
		t.Fatal(err)
	}
	for _, e := range s.snapshot().Entries {
		if e.Drama.SeriesID == other && (e.Drama.MetadataPending || e.Drama.Title != "重试已加载") {
			t.Fatal("metadata retry not merged")
		}
	}
}

func TestCloudUnavailableMetadataDoesNotBlockMembershipOrUpload(t *testing.T) {
	const unavailable = "7690163276214176794"
	var uploads atomic.Int32
	m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/reading/bookapi/read_history/list/v":
			ioJSON(w, `{"code":0,"data":{"data_list":[{"book_id_str":"7690163276214176792","book_name":"已有历史","vid_index":1,"read_timestamp_ms":1700000000000}],"has_more":false}}`)
		case "/reading/bookapi/bookshelf/video/list/v":
			ioJSON(w, `{"code":0,"data":{"video_shelf_info":[{"series_id":"7690163276214176794","collect_time":1700000000}]}}`)
		case "/novel/player/multi_video_detail/preload/v1":
			ioJSON(w, `{"code":101000}`)
		case "/reading/bookapi/read_progress/get/v":
			ioJSON(w, `{"code":0,"video_data":[]}`)
		case "/reading/bookapi/read_history/update/v", "/reading/bookapi/read_progress/upload/v":
			uploads.Add(1)
			ioJSON(w, `{"code":0}`)
		default:
			t.Error("unexpected cloud route")
		}
	})
	m.synchronize(context.Background())
	var history LibraryEntry
	found := false
	for _, e := range m.librarySnapshot().Entries {
		if e.Drama.SeriesID == unavailable {
			found = e.FavoriteAt > 0 && e.Drama.MetadataPending && e.Drama.Title != ""
		}
		if e.Drama.SeriesID == fixtureSeries {
			history = e
		}
	}
	if !found || m.status().Sync.Error != "" {
		t.Fatal("missing metadata blocked complete membership sync")
	}
	owner := m.status().Profile.UID
	if _, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "progress", Drama: history.Drama, Episode: 2, VideoID: fixtureVideo, Position: 10, Duration: 90}); err != nil {
		t.Fatal(err)
	}
	m.synchronize(context.Background())
	if uploads.Load() != 2 || m.status().Sync.Pending != 0 || m.status().Sync.Error != "" {
		t.Fatal("metadata failure blocked playback upload")
	}
}

func TestCloudMetadataInvalidItemsDoNotDiscardValidCards(t *testing.T) {
	const invalid = "7690163276214176794"
	for _, bad := range []struct{ name, data string }{
		{"missing_id", `{"series_title":"不可用资料"}`},
		{"zero_id", `{"series_id_str":"0","series_title":"不可用资料"}`},
		{"mismatched_id", `{"series_id":"7690163276214176795","series_title":"错误资料"}`},
		{"missing_title", `{"series_id_str":"7690163276214176794"}`},
		{"empty", `{}`},
		{"malformed", `[]`},
	} {
		t.Run(bad.name, func(t *testing.T) {
			c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
				ioJSON(w, fmt.Sprintf(`{"code":0,"data":{"7690163276214176794":{"video_data":%s},"7690163276214176792":{"video_data":{"series_id_str":"7690163276214176792","series_title":"正常资料"}}}}`, bad.data))
			})
			defer close()
			// A bad first item must neither poison its card nor discard later cards.
			cards, err := c.libraryMetadata(context.Background(), []string{invalid, fixtureSeries})
			if err != nil || len(cards) != 1 || cards[fixtureSeries].Title != "正常资料" {
				t.Fatalf("invalid item blocked valid metadata: cards=%v err=%v", cards, err)
			}
			if _, accepted := cards[invalid]; accepted {
				t.Fatal("invalid metadata accepted")
			}
		})
	}
}

func TestCloudMetadataIdentityFailuresDoNotBlockSync(t *testing.T) {
	const good = "7690163276214176794"
	const unavailable = "7690163276214176795"
	for _, bad := range []struct{ name, data string }{
		{"missing_id", `{"series_title":"异常资料","series_cover":"https://example.com/wrong.jpg"}`},
		{"mismatched_id", `{"series_id_str":"7690163276214176792","series_title":"错误资料","series_cover":"https://example.com/wrong.jpg"}`},
	} {
		for _, saved := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/saved=%t", bad.name, saved), func(t *testing.T) {
				var recovered atomic.Bool
				var uploads atomic.Int32
				m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/reading/bookapi/read_history/list/v":
						ioJSON(w, `{"code":0,"data":{"data_list":[{"book_id_str":"7690163276214176792","book_name":"已有历史","vid_index":1,"read_timestamp_ms":1700000000000}],"has_more":false}}`)
					case "/reading/bookapi/bookshelf/video/list/v":
						ioJSON(w, `{"code":0,"data":{"video_shelf_info":[{"series_id":"7690163276214176795","collect_time":1700000000},{"series_id":"7690163276214176794","collect_time":1700000000}]}}`)
					case "/novel/player/multi_video_detail/preload/v1":
						data := bad.data
						if recovered.Load() {
							data = `{"series_id_str":"7690163276214176795","series_title":"恢复后的资料","series_cover":"https://example.com/recovered.jpg"}`
						}
						ioJSON(w, fmt.Sprintf(`{"code":0,"data":{"7690163276214176795":{"video_data":%s},"7690163276214176794":{"video_data":{"series_id_str":"7690163276214176794","series_title":"正常收藏"}}}}`, data))
					case "/reading/bookapi/read_progress/get/v":
						ioJSON(w, `{"code":0,"video_data":[]}`)
					case "/reading/bookapi/read_history/update/v", "/reading/bookapi/read_progress/upload/v", "/reading/bookapi/bookshelf/video/update/v":
						uploads.Add(1)
						ioJSON(w, `{"code":0}`)
					default:
						t.Error("unexpected cloud route")
					}
				})
				owner, yes := m.status().Profile.UID, true
				if saved {
					drama := Drama{SeriesID: unavailable, Title: "已保存资料", Cover: "https://example.com/saved.jpg", MetadataPending: true}
					if _, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "favorite", Drama: drama, Value: &yes}); err != nil {
						t.Fatal(err)
					}
				}
				m.synchronize(context.Background())
				entries := map[string]LibraryEntry{}
				for _, entry := range m.librarySnapshot().Entries {
					entries[entry.Drama.SeriesID] = entry
				}
				status := m.status().Sync
				if len(entries) != 3 || status.Error != "" || status.LastSync == 0 || status.Pending != 0 {
					t.Fatalf("bad metadata blocked synchronization: entries=%d status=%+v", len(entries), status)
				}
				if entries[fixtureSeries].LastPlayedAt == 0 || entries[good].FavoriteAt == 0 || entries[good].Drama.Title != "正常收藏" || entries[good].Drama.MetadataPending {
					t.Fatal("valid history or favorite was lost")
				}
				card := entries[unavailable]
				if card.FavoriteAt == 0 || !card.Drama.MetadataPending {
					t.Fatal("invalid metadata removed authoritative favorite")
				}
				if saved {
					if card.Drama.Title != "已保存资料" || card.Drama.Cover != "https://example.com/saved.jpg" {
						t.Fatal("invalid metadata replaced saved card")
					}
				} else if card.Drama.Title != "剧集信息暂未加载" || card.Drama.Cover != "" {
					t.Fatal("invalid metadata entered placeholder")
				}
				baseline := uploads.Load()
				if _, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "progress", Drama: entries[fixtureSeries].Drama, Episode: 2, VideoID: fixtureVideo, Position: 10, Duration: 90}); err != nil {
					t.Fatal(err)
				}
				if _, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "favorite", Drama: entries[good].Drama, Value: &yes}); err != nil {
					t.Fatal(err)
				}
				m.synchronize(context.Background())
				if uploads.Load()-baseline != 3 || m.status().Sync.Pending != 0 || m.status().Sync.Error != "" {
					t.Fatal("invalid metadata blocked progress or favorite upload")
				}
				recovered.Store(true)
				m.synchronize(context.Background())
				final := m.librarySnapshot()
				if len(final.Entries) != 3 {
					t.Fatal("metadata recovery lost records")
				}
				for _, entry := range final.Entries {
					if entry.Drama.SeriesID == unavailable && (entry.Drama.MetadataPending || entry.Drama.Title != "恢复后的资料" || entry.Drama.Cover != "https://example.com/recovered.jpg" || entry.FavoriteAt == 0) {
						t.Fatal("later valid metadata did not recover favorite")
					}
					if entry.Drama.SeriesID == fixtureSeries && (entry.Episode != 2 || entry.Position != 10) {
						t.Fatal("older cloud progress replaced local progress")
					}
				}
				if m.status().Sync.Error != "" {
					t.Fatal("metadata recovery failed")
				}
			})
		}
	}
}

const fixtureSeries = "7690163276214176792"
const fixtureVideo = "7690163276214176793"

func loggedFixture(t *testing.T, h http.HandlerFunc) *accountManager {
	t.Helper()
	m := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/reading/ugc/action/mget/v" {
			ioJSON(w, `{"code":0,"data":{"mixed_data_list":null,"has_more":false}}`)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/passport/") || r.URL.Path == "/service/2/device_register/" {
			accountFixtureResponse(w, r.URL.Path, false)
			return
		}
		h(w, r)
	})
	if err := m.sendCode(context.Background(), "13800000000"); err != nil {
		t.Fatal(err)
	}
	if err := m.loginSMS(context.Background(), "13800000000", "123456"); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestCloudPullAndPushWireShapes(t *testing.T) {
	var historyUpdates, progressUpdates, favoriteUpdates atomic.Int32
	m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Tt-Token") == "" {
			t.Error("missing session token")
		}
		switch r.URL.Path {
		case "/reading/bookapi/read_history/list/v":
			if r.URL.Query().Get("book_type") != "2" {
				t.Error("history book type")
			}
			ioJSON(w, `{"code":0,"data":{"data_list":[{"book_id_str":"7690163276214176792","book_name":"云端剧","vid":"7690163276214176793","vid_index":7,"current_play_position":12500,"read_timestamp_ms":1700000000000,"episode_cnt":80}],"has_more":false}}`)
		case "/reading/bookapi/bookshelf/video/list/v":
			ioJSON(w, `{"code":0,"data":{"video_shelf_info":[{"series_id":"7690163276214176792"}]}}`)
		case "/reading/bookapi/read_progress/get/v":
			var body map[string]any
			d := json.NewDecoder(r.Body)
			d.UseNumber()
			_ = d.Decode(&body)
			ids := body["book_ids"].(map[string]any)["2"].([]any)
			if len(ids) != 1 || asString(ids[0]) != fixtureSeries {
				t.Error("numeric ID lost precision")
			}
			ioJSON(w, `{"code":0,"video_data":[{"series_id":"7690163276214176792","vid_index":7,"episode_count":80,"last_watch_time":1700000000}]}`)
		case "/reading/bookapi/read_history/update/v", "/reading/bookapi/read_progress/upload/v", "/reading/bookapi/bookshelf/video/update/v":
			var body map[string]any
			d := json.NewDecoder(r.Body)
			d.UseNumber()
			_ = d.Decode(&body)
			if rows, ok := body["update_datas"].([]any); ok {
				historyUpdates.Add(1)
				row := rows[0].(map[string]any)
				for _, key := range []string{"user_digg", "meet_guide_comment_tag", "user_playlet_comment_flag"} {
					if _, ok := row[key].(bool); !ok {
						t.Errorf("%s must be boolean", key)
					}
				}
				if _, ok := row["is_multi_season"].(json.Number); !ok {
					t.Error("is_multi_season must be integer")
				}
				if asString(row["book_id"]) != fixtureSeries || asString(row["vid"]) != fixtureVideo || asInt(row["vid_index"]) != 8 || asInt(row["current_play_position"]) != 15250 {
					t.Error("history upload ID/index/ms mismatch")
				}
			} else if rows, ok := body["books"].([]any); ok {
				progressUpdates.Add(1)
				row := rows[0].(map[string]any)
				if _, ok := row["check_timestamp"].(bool); !ok {
					t.Error("check_timestamp must be boolean")
				}
				if asString(row["book_id"]) != fixtureSeries || asString(row["item_id"]) != fixtureVideo || asInt(row["current_play_time"]) != 15250 {
					t.Error("progress upload mismatch")
				}
			} else {
				favoriteUpdates.Add(1)
				row := body["update_bookshelf_video_list"].([]any)[0].(map[string]any)
				if asString(row["book_id"]) != fixtureSeries || asInt(row["video_shelf_operate_type"]) != 1 {
					t.Error("favorite cancellation mismatch")
				}
			}
			ioJSON(w, `{"code":0}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	m.synchronize(context.Background())
	d := m.librarySnapshot()
	if len(d.Entries) != 1 || d.Entries[0].Episode != 7 || d.Entries[0].Position != 12.5 || d.Entries[0].FavoriteAt == 0 || m.status().Sync.LastSync == 0 {
		t.Fatalf("pull failed: %+v", d)
	}
	owner := m.status().Profile.UID
	if _, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "progress", Drama: d.Entries[0].Drama, Episode: 8, VideoID: fixtureVideo, Position: 15.25, Duration: 90}); err != nil {
		t.Fatal(err)
	}
	no := false
	if _, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "favorite", Drama: d.Entries[0].Drama, Value: &no}); err != nil {
		t.Fatal(err)
	}
	m.synchronize(context.Background())
	d = m.librarySnapshot()
	if d.Entries[0].Episode != 8 || d.Entries[0].FavoriteAt != 0 || len(d.Cloud.Pending) != 0 {
		t.Fatalf("local upload reverted: %+v", d)
	}
	if historyUpdates.Load() != 1 || progressUpdates.Load() != 1 || favoriteUpdates.Load() != 1 {
		t.Fatal("not all mutations acknowledged")
	}
	reloaded, err := newAccountManager(m.dir, m.guest, nil)
	if err != nil || reloaded.status().Sync.LastSync != m.status().Sync.LastSync {
		t.Fatal("last sync not restored")
	}
}

func TestCloudMalformedSnapshotCannotEraseFavoritesOrAck(t *testing.T) {
	m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "read_history/list") {
			ioJSON(w, `{"code":0,"data":{"data_list":[],"has_more":false}}`)
		} else {
			ioJSON(w, `{"code":0,"data":{}}`)
		}
	})
	owner := m.status().Profile.UID
	yes := true
	_, _ = m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "favorite", Drama: Drama{SeriesID: fixtureSeries, Title: "收藏"}, Value: &yes})
	m.synchronize(context.Background())
	d := m.librarySnapshot()
	if d.Entries[0].FavoriteAt == 0 || len(d.Cloud.Pending) != 1 || m.status().Sync.LastSync != 0 || m.status().Sync.Error == "" {
		t.Fatal("partial snapshot caused false success/data loss")
	}
}

func TestCloudRemoteNewerProgressSupersedesOnlyStaleMutation(t *testing.T) {
	s, _ := newLibraryStore(t.TempDir())
	s.data.OwnerID = "123456789"
	drama := Drama{SeriesID: fixtureSeries, Title: "进度冲突"}
	yes := true
	_, _ = s.apply(LibraryChange{Action: "progress", Drama: drama, Episode: 2, VideoID: fixtureVideo, Position: 30})
	_, _ = s.apply(LibraryChange{Action: "favorite", Drama: drama, Value: &yes})
	stamp := s.snapshot().Entries[0].LastPlayedAt
	if err := s.mergeCloud([]LibraryEntry{{Drama: drama, Episode: 5, Position: 10, LastPlayedAt: stamp + 1000}}, 0); err != nil {
		t.Fatal(err)
	}
	d := s.snapshot()
	if d.Entries[0].Episode != 5 || len(d.Cloud.Pending) != 1 || d.Cloud.Pending[0].Kind != "favorite" || d.Entries[0].FavoriteAt == 0 {
		t.Fatal("conflict reconciliation damaged other changes")
	}
	// A new save created during a pull must survive an older remote snapshot.
	_, _ = s.apply(LibraryChange{Action: "progress", Drama: drama, Episode: 6, VideoID: fixtureVideo, Position: 8})
	if err := s.mergeCloud([]LibraryEntry{{Drama: drama, Episode: 4, LastPlayedAt: stamp - 1}}, 0); err != nil {
		t.Fatal(err)
	}
	if s.snapshot().Entries[0].Episode != 6 || len(s.snapshot().Cloud.Pending) != 2 {
		t.Fatal("older snapshot replaced fresh local save")
	}
}

func TestCloudLogoutDuringPullDoesNotRestoreAccount(t *testing.T) {
	entered := make(chan struct{})
	m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
	})
	done := make(chan struct{})
	go func() { defer close(done); m.synchronize(context.Background()) }()
	<-entered
	if err := m.logout(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("logout did not cancel sync")
	}
	if m.status().LoggedIn || m.librarySnapshot().OwnerID != "" || m.status().Sync.State != "local" {
		t.Fatal("late sync restored account")
	}
}

func TestCloudPersistenceFailureKeepsQueueAndLocalState(t *testing.T) {
	s, _ := newLibraryStore(t.TempDir())
	s.data.OwnerID = "123456789"
	yes := true
	_, _ = s.apply(LibraryChange{Action: "favorite", Drama: Drama{SeriesID: fixtureSeries, Title: "持久化"}, Value: &yes})
	before := s.snapshot()
	blocker := filepath.Join(filepath.Dir(s.path), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	s.path = filepath.Join(blocker, "library.json")
	if err := s.ackCloud(before.Cloud.Pending[0].Sequence); err == nil {
		t.Fatal("ack persistence failure ignored")
	}
	if err := s.markCloudSynced(1); err == nil {
		t.Fatal("sync persistence failure ignored")
	}
	if len(s.snapshot().Cloud.Pending) != 1 || s.snapshot().Cloud.LastSync != 0 {
		t.Fatal("memory published failed write")
	}
}

func TestCloudNestedErrorIsNotAcknowledged(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { ioJSON(w, `{"code":0,"data":{"error_code":401}}`) }))
	defer remote.Close()
	c := newPassportClient(accountSession{DeviceID: "123", InstallID: "456"})
	c.base = remote.URL
	c.http = remote.Client()
	if _, err := c.cloudJSON(context.Background(), "/update", http.MethodPost, nil, map[string]any{}); err == nil {
		t.Fatal("nested failure accepted")
	}
}

func TestAccountRejectsReboundHostname(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "http://rebound.example:8797/api/v1/account/login", nil)
	r.RemoteAddr = "127.0.0.1:4000"
	r.Header.Set("Origin", "http://rebound.example:8797")
	if privateLocalRequest(r) {
		t.Fatal("non-loopback Host accepted")
	}
}

func TestExpiredCloudSessionCannotMergeOrUpload(t *testing.T) {
	for _, payload := range []string{`{"code":401,"data":{}}`, `{"code":0,"data":{"error_code":401}}`, `{"code":0,"data":{}}`} {
		t.Run(payload, func(t *testing.T) {
			var calls atomic.Int32
			m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/reading/bookapi/read_history/list/v" {
					t.Errorf("continued after failed cloud read: %s", r.URL.Path)
				}
				ioJSON(w, payload)
			})
			owner, yes := m.status().Profile.UID, true
			_, err := m.changeLibrary(LibraryChange{OwnerID: &owner, Action: "favorite", Drama: Drama{SeriesID: fixtureSeries, Title: "保留的收藏"}, Value: &yes})
			if err != nil {
				t.Fatal(err)
			}
			m.synchronize(context.Background())
			d := m.librarySnapshot()
			if calls.Load() != 1 || len(d.Entries) != 1 || d.Entries[0].FavoriteAt == 0 || len(d.Cloud.Pending) != 1 || m.status().Sync.LastSync != 0 || m.status().Sync.Error == "" || !m.status().LoggedIn {
				t.Fatal("failed session merged/acknowledged data or undid login")
			}
		})
	}
}

func TestCloudLocalAccountMismatchAndMissingCredentialsStopBeforeNetwork(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("invalid local account made network request") })
		m.mu.Lock()
		if mismatch {
			m.disk.Profile.UID = "987654321"
		} else {
			m.disk.Session.Token = ""
			m.disk.Session.Cookies = map[string]string{}
		}
		m.mu.Unlock()
		m.synchronize(context.Background())
		if m.status().Sync.Error == "" || m.status().Sync.LastSync != 0 {
			t.Fatal("invalid local identity accepted")
		}
	}
}
