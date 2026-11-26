package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const directoryFixtureID = "9000000000000000001"

func directoryFixture(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile("testdata/series-directory.json")
	if err != nil {
		t.Fatal(err)
	}
	var p map[string]any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := d.Decode(&p); err != nil {
		t.Fatal(err)
	}
	return p
}

func directoryVideo(p map[string]any) map[string]any {
	return p["data"].(map[string]any)[directoryFixtureID].(map[string]any)["video_data"].(map[string]any)
}

func TestAppSeriesDirectoryValidatesWholeOrderedIdentity(t *testing.T) {
	p := directoryFixture(t)
	d, err := parseAppSeriesDirectory(p, directoryFixtureID)
	if err != nil || len(d.Episodes) != 5 || d.VidList[3] != "9000000000000000014" || d.Vid != "9000000000000000011" || d.Tags[0] != "悬疑" {
		t.Fatalf("full exact directory: %+v err=%v", d, err)
	}
	if !d.Episodes[4].Locked || d.Episodes[4].LockedInferred || d.Episodes[3].Locked {
		t.Fatal("explicit disabled episode was lost or inferred")
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any, map[string]any)
	}{
		{"business", func(p, v map[string]any) { p["code"] = json.Number("403") }},
		{"wrong-series", func(p, v map[string]any) { v["series_id_str"] = "9000000000000000002" }},
		{"conflicting-series", func(p, v map[string]any) { v["series_id"] = json.Number("9000000000000000002") }},
		{"preview", func(p, v map[string]any) { v["video_list"] = v["video_list"].([]any)[:3] }},
		{"missing-count", func(p, v map[string]any) { delete(v, "episode_cnt") }},
		{"inferred-count", func(p, v map[string]any) {
			delete(v, "episode_cnt")
			v["vid_list"] = []any{"11", "12", "13", "14", "15"}
		}},
		{"more", func(p, v map[string]any) { v["has_more"] = true }},
		{"more-envelope", func(p, v map[string]any) {
			p["data"].(map[string]any)[directoryFixtureID].(map[string]any)["has_more"] = true
		}},
		{"album", func(p, v map[string]any) { v["content_type"] = "1003" }},
		{"duplicate", func(p, v map[string]any) {
			r := v["video_list"].([]any)
			r[3].(map[string]any)["vid"] = r[0].(map[string]any)["vid"]
		}},
		{"opaque", func(p, v map[string]any) { v["video_list"].([]any)[3].(map[string]any)["vid"] = "v1_preview" }},
		{"zero", func(p, v map[string]any) { v["video_list"].([]any)[3].(map[string]any)["vid"] = json.Number("0") }},
		{"wrong-index", func(p, v map[string]any) { v["video_list"].([]any)[3].(map[string]any)["vid_index"] = json.Number("5") }},
		{"missing-index", func(p, v map[string]any) { delete(v["video_list"].([]any)[3].(map[string]any), "vid_index") }},
		{"foreign-row", func(p, v map[string]any) {
			v["video_list"].([]any)[3].(map[string]any)["series_id"] = json.Number("9000000000000000002")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := directoryFixture(t)
			tc.change(p, directoryVideo(p))
			out, err := parseAppSeriesDirectory(p, directoryFixtureID)
			if err == nil || len(out.VidList) > 0 {
				t.Fatal("accepted corrupt directory")
			}
		})
	}
}

func TestSeriesDirectoryPreservesNotYetReleasedDetails(t *testing.T) {
	p := directoryFixture(t)
	v := directoryVideo(p)
	v["episode_cnt"], v["video_list"] = json.Number("0"), []any{}
	d, err := parseAppSeriesDirectory(p, directoryFixtureID)
	if err != nil || len(d.Episodes) != 0 || d.Vid != "" || d.Title == "" {
		t.Fatalf("empty upcoming App detail rejected: %v", err)
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/detail" {
			t.Error("upcoming web detail made an unnecessary directory request")
			w.WriteHeader(500)
			return
		}
		io.WriteString(w, strings.Replace(directoryWebPage(nil), `"episode_cnt":5`, `"episode_cnt":0`, 1))
	}))
	defer s.Close()
	c := newHongguoClient()
	c.webBase, c.apiBase, c.httpClient = s.URL, s.URL, s.Client()
	d, err = c.SeriesDetail(context.Background(), directoryFixtureID)
	if err != nil || d.EpisodeCount != 0 || len(d.Episodes) != 0 || d.Title != "网页片名" {
		t.Fatalf("empty upcoming web detail rejected: %v", err)
	}
}

func TestSeriesDirectoryRejectsWrongWebsiteIdentity(t *testing.T) {
	var reads atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		io.WriteString(w, strings.ReplaceAll(directoryWebPage(nil), directoryFixtureID, "9000000000000000002"))
	}))
	defer s.Close()
	c := newHongguoClient()
	c.webBase, c.apiBase, c.httpClient = s.URL, s.URL, s.Client()
	_, err := c.SeriesDetail(context.Background(), directoryFixtureID)
	if !errors.Is(err, errSeriesDetailIdentity) || reads.Load() != 1 {
		t.Fatal("wrong detail identity was mixed with an App directory")
	}
}

func directoryWebPage(vids []string) string {
	b, _ := json.Marshal(map[string]any{"loaderData": map[string]any{"detail_page": map[string]any{
		"seriesDetail": map[string]any{"series_id": directoryFixtureID, "series_name": "网页片名", "series_intro": "网页简介", "score": "9.1", "episode_cnt": 5, "accessible_episode_cnt": 3, "vid_list": vids,
			"celebrities": []any{map[string]any{"celebrity_id": "7377326001203713305", "nickname": "演员"}}},
		"related_list": []any{map[string]any{"series_id": "9000000000000000020", "series_title": "相关推荐", "episode_cnt": 9}},
		"reviews":      []any{map[string]any{"review_id": "r1", "user_name": "观众", "content": "剧评"}},
	}}})
	return "<script>window._ROUTER_DATA=" + string(b) + ";</script>"
}

func TestSeriesDirectoryRepairsPreviewAndPreservesMetadata(t *testing.T) {
	for _, mode := range []string{"opaque-preview", "numeric-preview", "complete", "web-down", "app-down"} {
		t.Run(mode, func(t *testing.T) {
			var reads atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/detail" {
					if mode == "web-down" {
						w.WriteHeader(503)
						return
					}
					vids := []string{"v1_first", "v1_second", "v1_third"}
					if mode == "numeric-preview" {
						vids = []string{"9000000000000000011", "9000000000000000012", "9000000000000000013"}
					}
					if mode == "complete" {
						vids = []string{"9000000000000000011", "9000000000000000012", "9000000000000000013", "9000000000000000014", "9000000000000000015"}
					}
					io.WriteString(w, directoryWebPage(vids))
					return
				}
				if r.URL.Path != "/novel/player/multi_video_detail/preload/v1" {
					t.Errorf("unexpected path %s", r.URL.Path)
					w.WriteHeader(404)
					return
				}
				reads.Add(1)
				var body map[string]any
				if r.Method != "POST" || json.NewDecoder(r.Body).Decode(&body) != nil || body["series_id"] != directoryFixtureID || body["dr_scene"] != "preload" || r.Header.Get("X-Gorgon") == "" || r.Header.Get("X-Medusa") == "" || r.Header.Get("Cookie") != "" {
					t.Error("invalid signed anonymous directory request")
				}
				if mode == "app-down" {
					io.WriteString(w, `{"code":0,"data":{}}`)
					return
				}
				b, _ := json.Marshal(directoryFixture(t))
				w.Write(b)
			}))
			defer s.Close()
			c := newHongguoClient()
			c.webBase = s.URL
			c.apiBase = s.URL
			c.httpClient = s.Client()
			d, err := c.SeriesDetail(context.Background(), directoryFixtureID)
			if mode == "app-down" {
				if err == nil || len(d.Episodes) > 0 {
					t.Fatal("returned preview as a usable directory")
				}
				return
			}
			if err != nil || len(d.Episodes) != 5 || d.VidList[3] != "9000000000000000014" {
				t.Fatalf("directory=%+v err=%v", d, err)
			}
			if mode == "complete" {
				if reads.Load() != 0 {
					t.Fatal("healthy website made an extra request")
				}
			} else if reads.Load() != 1 {
				t.Fatal("directory fallback did not run once")
			}
			if mode != "web-down" && (d.Title != "网页片名" || d.Intro != "网页简介" || d.Score != "9.1" || len(d.Actors) != 1 || len(d.Related) != 1 || len(d.Reviews) != 1) {
				t.Fatal("metadata regressed")
			}
			if mode == "web-down" && d.Title != "完整目录样例" {
				t.Fatal("App metadata unavailable after website failure")
			}
		})
	}
}

func TestSeriesDirectoryCancellationStopsFallback(t *testing.T) {
	for _, phase := range []string{"web", "app"} {
		t.Run(phase, func(t *testing.T) {
			started := make(chan struct{})
			release := make(chan struct{})
			var reads atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/detail" && phase == "app" {
					io.WriteString(w, directoryWebPage([]string{"v1_preview"}))
					return
				}
				if strings.Contains(r.URL.Path, "preload") {
					reads.Add(1)
				}
				io.Copy(io.Discard, r.Body)
				close(started)
				select {
				case <-r.Context().Done():
				case <-release:
				}
			}))
			defer s.Close()
			defer close(release)
			c := newHongguoClient()
			c.webBase = s.URL
			c.apiBase = s.URL
			c.httpClient = s.Client()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := c.SeriesDetail(ctx, directoryFixtureID); done <- err }()
			<-started
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("wrong cancellation %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("cancel did not stop directory request")
			}
			if phase == "web" && reads.Load() != 0 {
				t.Fatal("cancel started App fallback")
			}
		})
	}
}
