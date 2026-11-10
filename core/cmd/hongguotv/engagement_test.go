package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEngagementSelectsExactEpisodeAndDistinguishesMissingFromZero(t *testing.T) {
	video := map[string]any{"series_id_str": fixtureSeries, "followed_cnt": json.Number("388000"), "digg_cnt": 999999,
		"content_type": json.Number("1004"), "video_category_type": "ai_video", "category_schema": `[{"name":"爱情"},{"name":"都市爱情"}]`, "video_list": []any{
			map[string]any{"vid": "11111", "digged_count": 13000, "comment_count": 529},
			map[string]any{"vid": fixtureVideo, "digged_count": 0, "episode_cover": "https://p3-novel.example/episode-2.jpg"},
		}}
	out, err := engagementFromVideo(fixtureSeries, fixtureVideo, video)
	if err != nil || out.Likes == nil || *out.Likes != 0 || out.Comments != nil || *out.Favorites != 388000 || out.EpisodeCover != "https://p3-novel.example/episode-2.jpg" {
		t.Fatalf("wrong episode or missing count: %+v %v", out, err)
	}
	if out.Metadata == nil || out.Metadata.ContentType != "1004" || out.Metadata.VideoCategoryType != "ai_video" || len(out.Metadata.Tags) != 2 || out.Metadata.Tags[0] != "爱情" {
		t.Fatalf("existing preload classification lost: %+v", out.Metadata)
	}
	if _, err = engagementFromVideo(fixtureSeries, "99999", video); err == nil {
		t.Fatal("missing video accepted")
	}
	if _, err = engagementFromVideo("99999", fixtureVideo, video); err == nil {
		t.Fatal("wrong series accepted")
	}
	for _, bad := range []any{nil, -1, "1.3万", "NaN", 2.5, json.Number("9007199254740992")} {
		if engagementCount(bad) != nil {
			t.Fatalf("invalid count accepted: %v", bad)
		}
	}
}

func TestEpisodeCoverRequiresHTTPSURL(t *testing.T) {
	for _, value := range []any{"http://images.example/cover.jpg", "javascript:alert(1)", "//images.example/cover.jpg", nil} {
		if got := episodeCoverURL(value); got != "" {
			t.Fatalf("unsafe cover URL accepted: %v => %q", value, got)
		}
	}
	if got := episodeCoverURL("  https://images.example/cover.jpg  "); got != "https://images.example/cover.jpg" {
		t.Fatalf("valid cover URL rejected: %q", got)
	}
}

func TestEngagementReadProtocolAndMissingCommentFallback(t *testing.T) {
	calls := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		switch r.URL.Path {
		case "/novel/player/multi_video_detail/preload/v1":
			if r.Method != http.MethodPost {
				t.Error("wrong preload method")
			}
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			biz, _ := asMap(body["biz_param"])
			if body["series_id"] != fixtureSeries || asBool(biz["disable_digg_stat"]) {
				t.Error("statistics request mismatch")
			}
			ioJSON(w, `{"code":0,"data":{"`+fixtureSeries+`":{"video_data":{"series_id_str":"`+fixtureSeries+`","followed_cnt":388000,"video_list":[{"vid":"`+fixtureVideo+`","digged_count":13000}]}}}}`)
		case "/novel/commentapi/comment/list/" + fixtureVideo + "/v1/":
			if r.URL.Query().Get("book_id") != fixtureSeries {
				t.Error("wrong comment series")
			}
			ioJSON(w, `{"code":0,"data":{"common_list_info":{"total":529},"data_list":[]}}`)
		default:
			t.Error("unexpected request")
			http.Error(w, "bad path", 404)
		}
	}))
	defer upstream.Close()
	c := newPassportClient(accountSession{Cookies: map[string]string{}})
	c.base = upstream.URL
	c.http = upstream.Client()
	result, err := c.Engagement(context.Background(), fixtureSeries, fixtureVideo)
	if err != nil || result.Likes == nil || *result.Likes != 13000 || result.Favorites == nil || *result.Favorites != 388000 || result.Comments == nil || *result.Comments != 529 {
		t.Fatalf("bad stats: %+v %v", result, err)
	}
	if len(calls) != 2 {
		t.Fatalf("wrong requests: %v", calls)
	}
}
