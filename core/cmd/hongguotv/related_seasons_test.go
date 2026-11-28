package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func relatedSeasonFixture(rows ...map[string]any) map[string]any {
	items := []any{}
	for _, row := range rows {
		items = append(items, row)
	}
	return map[string]any{"code": 0, "data": []any{map[string]any{"show_type": 547, "cell_name": "相关作品", "video_data": items}}}
}

func relatedSeasonRow(id, title, tag string, season int) map[string]any {
	return map[string]any{"series_id": id, "title": title, "tag_info": map[string]any{"text": tag},
		"season_index": season, "content_type": 1004, "episode_cnt": 20, "vid": id + "1"}
}

func TestRelatedSeasonsRejectsUntrustedTagsConflictsAndMalformedResponses(t *testing.T) {
	sameIP := relatedSeasonRow("2", "另一部第二季", "同IP", 2)
	missing := relatedSeasonRow("3", "另一部第三季", "", 3)
	rows, err := parseRelatedSeasons(relatedSeasonFixture(sameIP, missing), "1")
	if err != nil || len(rows) != 0 {
		t.Fatal("同IP and synthesized labels must not authorize continuation")
	}
	for _, mutation := range []func(map[string]any) map[string]any{
		func(row map[string]any) map[string]any { row["season_index"] = 3; return relatedSeasonFixture(row) },
		func(row map[string]any) map[string]any {
			row["title"] = "公路第三季完结篇"
			return relatedSeasonFixture(row)
		},
		func(row map[string]any) map[string]any { return relatedSeasonFixture(row, row) },
		func(row map[string]any) map[string]any {
			return relatedSeasonFixture(row, relatedSeasonRow("3", "另一个第二季", "第2季", 2))
		},
		func(row map[string]any) map[string]any { return map[string]any{"code": 101116} },
		func(row map[string]any) map[string]any { return map[string]any{"code": 0, "data": map[string]any{}} },
		func(row map[string]any) map[string]any {
			return map[string]any{"code": 0, "data": []any{map[string]any{"show_type": 547}}}
		},
	} {
		if _, err := parseRelatedSeasons(mutation(relatedSeasonRow("2", "公路第二季", "第2季", 2)), "1"); err == nil {
			t.Fatal("conflict or malformed result accepted")
		}
	}
	for title, expected := range map[string]int{"某剧第13季": 13, "某剧第十三季": 13, "某剧第一百零一季": 101, "某剧第三季完結篇": 3, "爱在第三季的我们": 0} {
		if n := relatedTitleSeason(title); n != expected {
			t.Fatal(title, n, expected)
		}
	}
}

func TestRelatedSeasonsFallbackOnlyAfterPrimaryFailureAndConfirmsBothDirections(t *testing.T) {
	for _, outcome := range []string{"playable", "upcoming", "no-back", "wrong-back", "empty", "failure"} {
		t.Run(outcome, func(t *testing.T) {
			requests := []string{}
			c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()
				requests = append(requests, r.URL.Path+"/"+q.Get("book_id"))
				if r.URL.Path == "/reading/bookapi/plan/v" {
					ioJSON(w, `{"code":101116}`)
					return
				}
				if r.URL.Path != "/reading/bookapi/plan/v:version/" || q.Get("from") != "detail_page_more_related" ||
					q.Get("version_code") != "72232" || q.Get("version_name") != "7.2.2.32" || q.Get("limit") != "0" ||
					r.Header.Get("X-Medusa") == "" || r.Header.Get("X-Tt-Token") != "" || r.Header.Get("Cookie") != "" {
					t.Error("wrong isolated related-work request")
				}
				if outcome == "failure" {
					ioJSON(w, `{"code":101116}`)
					return
				}
				if outcome == "empty" {
					ioJSON(w, `{"code":0,"data":[{"show_type":506,"cell_name":"猜你喜欢"}]}`)
					return
				}
				one := relatedSeasonRow("1", "公路求生他", "第1季", 1)
				two := relatedSeasonRow("2", "公路求生他第二季", "第2季", 2)
				three := relatedSeasonRow("3", "公路求生她第三季", "第3季", 3)
				if outcome == "upcoming" {
					three["content_type"], three["episode_cnt"], three["vid"] = 1007, 0, ""
					three["subscribe_item"] = map[string]any{"item_id": "31", "is_subscribed": true}
				}
				var payload map[string]any
				switch q.Get("book_id") {
				case "2":
					payload = relatedSeasonFixture(one, three, relatedSeasonRow("4", "另一部第三季", "同IP", 3))
				case "1":
					if outcome == "no-back" {
						payload = relatedSeasonFixture()
					} else {
						payload = relatedSeasonFixture(two, three)
					}
				case "3":
					if outcome == "wrong-back" {
						two["tag_info"] = map[string]any{"text": "同IP"}
					}
					payload = relatedSeasonFixture(one, two)
				default:
					t.Error("unexpected candidate request")
				}
				json.NewEncoder(w).Encode(payload)
			})
			defer close()
			c.session.Token = "private-token"
			c.session.Cookies["session"] = "private-cookie"
			out, err := c.SeriesSeasons(context.Background(), "2")
			if outcome == "failure" || outcome == "no-back" || outcome == "wrong-back" {
				if err == nil {
					t.Fatal("unconfirmed relation became a catalog", out)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if outcome == "empty" {
				if len(out.Items) != 0 || out.Source != "related-no-seasons" || len(requests) != 2 {
					t.Fatal(out, requests)
				}
				return
			}
			expectedRequests := 4
			if outcome == "upcoming" {
				expectedRequests = 3
			}
			if len(out.Items) != 3 || out.Items[1].SeriesID != "2" || out.Items[2].SeriesID != "3" || len(requests) != expectedRequests {
				t.Fatal(out, requests)
			}
			if outcome == "upcoming" {
				next := out.Items[2]
				if !next.Upcoming || next.Playable || next.Vid != "" || next.ReservationID != "3" || !next.Reserved {
					t.Fatal(next)
				}
			} else if !out.Items[2].Playable {
				t.Fatal("confirmed differently-worded successor is not playable")
			}
			if c.session.Token != "private-token" || c.session.Cookies["session"] != "private-cookie" {
				t.Fatal("public fallback mutated account credentials")
			}
		})
	}
}

func TestRelatedSeasonsCancellationNeverFallsBackToAnotherRequest(t *testing.T) {
	var calls atomic.Int32
	c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		<-r.Context().Done()
	})
	defer close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := c.SeriesSeasons(ctx, "123"); err == nil {
		t.Fatal("canceled primary must not become success")
	}
	if calls.Load() != 1 {
		t.Fatal("canceled request started fallback", calls.Load())
	}
}

func TestRelatedSeasonsPrimarySuccessKeepsExistingSingleRequest(t *testing.T) {
	calls := 0
	c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if strings.Contains(r.URL.Path, ":version") {
			t.Error("normal selector must not use fallback")
		}
		ioJSON(w, `{"code":0,"data":[{"video_data":[{"series_id":"1","title":"一季","vid":"11","episode_cnt":3,"season_index":1}]}]}`)
	})
	defer close()
	out, err := c.SeriesSeasons(context.Background(), "1")
	if err != nil || len(out.Items) != 1 || calls != 1 || out.Source != "" {
		t.Fatal(out, err, calls)
	}
}

func TestRelatedSeasonsRecordedMetadataKeepsAdaptationsSeparate(t *testing.T) {
	raw, err := os.ReadFile("testdata/related-seasons-20261128.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures map[string]map[string]any
	if json.Unmarshal(raw, &fixtures) != nil {
		t.Fatal("invalid sanitized fixture")
	}
	for _, tc := range []struct{ id, next string }{
		{"7691938290202577944", "7700477891418524696"},
		{"7700477891418524696", "7708355462780947518"},
		{"7690163276214176792", "7702763145030290457"},
	} {
		c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(fixtures[r.URL.Query().Get("book_id")])
		})
		out, err := c.relatedSeasons(context.Background(), tc.id)
		close()
		if err != nil {
			t.Fatal(err)
		}
		var own, next *SeriesSeason
		for i := range out.Items {
			if out.Items[i].SeriesID == tc.id {
				own = &out.Items[i]
			}
			if out.Items[i].SeriesID == tc.next {
				next = &out.Items[i]
			}
		}
		if own == nil || next == nil || next.SeasonIndex != own.SeasonIndex+1 || !next.Playable {
			t.Fatal("lost confirmed successor", tc)
		}
	}
	for _, id := range []string{"7710278988953832472", "7693071659686693913"} {
		rows, err := parseRelatedSeasons(fixtures[id], id)
		if err != nil || len(rows) != 0 {
			t.Fatal("同IP or unrelated recommendations became seasons")
		}
	}
}

func TestRelatedSeasonsLiveReadOnly(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_RELATED_SEASONS") != "1" {
		t.Skip("anonymous read-only live probe is opt-in")
	}
	c := newPassportClient(accountSession{DeviceID: miniReelRandomID(), InstallID: miniReelRandomID(), Cookies: map[string]string{}})
	for _, id := range []string{"7693071659686693913", "7700477891418524696", "7710278988953832472"} {
		out, err := c.relatedSeasons(context.Background(), id)
		if err != nil {
			t.Fatalf("related metadata failed for series %s", id)
		}
		t.Logf("series=%s source=%s seasons=%d", id, out.Source, len(out.Items))
		if id == "7700477891418524696" {
			found := false
			for _, row := range out.Items {
				if row.SeriesID == "7708355462780947518" && row.SeasonIndex == 3 && row.Playable {
					found = true
				}
			}
			if !found {
				t.Fatal("live metadata lacks confirmed successor")
			}
		} else if len(out.Items) != 0 {
			t.Fatal("live no-relation control changed")
		}
	}
}
