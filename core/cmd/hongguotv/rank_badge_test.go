package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRankBadgeRecommendationAndPreload(t *testing.T) {
	tags := []any{map[string]any{"rec_type": 9, "content": "9625万热度"}, map[string]any{"rec_type": json.Number("9"), "content": "男频榜 No.1", "schema": "sslocal://ranking", "rec_icon_url": "https://example.test/icon.png"}}
	detail := map[string]any{"series_id": fixtureSeries, "first_vid": fixtureVideo, "episode_cnt": 80, "tags": []any{"悬疑"}}
	items := feedDramas([]any{map[string]any{"video_data": []any{map[string]any{"video_detail": detail, "rec_tags": tags}}}})
	if len(items) != 1 || items[0].RankBadge != "男频榜 No.1" || strings.Join(items[0].Tags, ",") != "悬疑" || items[0].Vid != fixtureVideo {
		t.Fatalf("rank badge changed genre/playback fields: %+v", items)
	}
	body, _ := json.Marshal(items[0])
	if strings.Contains(string(body), "sslocal") || strings.Contains(string(body), "icon.png") {
		t.Fatal("raw recommendation decoration escaped normalization")
	}
	video := map[string]any{"series_id": fixtureSeries, "rec_tags": tags, "video_list": []any{map[string]any{"vid": fixtureVideo}}}
	stats, err := engagementFromVideo(fixtureSeries, fixtureVideo, video)
	if err != nil || stats.RankBadge != "男频榜 No.1" {
		t.Fatalf("existing preload lost card-player badge: %+v %v", stats, err)
	}
}

func TestRankBadgeRequiresExplicitRank(t *testing.T) {
	for _, tag := range []any{nil, map[string]any{"rec_type": 15, "content": "1009万人在追"}, map[string]any{"rec_type": 53, "content": "爆剧"}, map[string]any{"rec_type": 9, "content": "9625万热度"}, map[string]any{"rec_type": 9, "content": "榜\nNo.1"}, map[string]any{"rec_type": 9, "content": "<榜>"}, map[string]any{"rec_type": 9, "content": strings.Repeat("榜", 81)}} {
		if value := rankBadge(map[string]any{"rec_tags": []any{tag}}); value != "" {
			t.Fatalf("non-rank label accepted: %q", value)
		}
	}
	if value := rankBadge(map[string]any{"rec_tags": []any{map[string]any{"rec_type": "9", "content": " 女频·新剧榜 No.1 "}}}); value != "女频·新剧榜 No.1" {
		t.Fatal(value)
	}
}
