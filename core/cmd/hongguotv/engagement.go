package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Likes/comments belong to an exact episode; followed_cnt belongs to the series.
// Pointers preserve the difference between a real zero and missing statistics.
type Engagement struct {
	SeriesID     string              `json:"series_id"`
	VideoID      string              `json:"vid"`
	Likes        *int64              `json:"likes"`
	Favorites    *int64              `json:"favorites"`
	Comments     *int64              `json:"comments"`
	EpisodeCover string              `json:"episode_cover,omitempty"`
	Metadata     *EngagementMetadata `json:"metadata,omitempty"`
	RankBadge    string              `json:"rank_badge,omitempty"`
}

// Reuse classification already present in the episode's existing preload read.
// No extra request or playback dependency is introduced for watch statistics.
type EngagementMetadata struct {
	ContentType       string   `json:"content_type,omitempty"`
	VideoCategoryType string   `json:"video_category_type,omitempty"`
	Tags              []string `json:"tags,omitempty"`
}

func episodeCoverURL(value any) string {
	raw := strings.TrimSpace(asString(value))
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return ""
	}
	return raw
}

func engagementCount(value any) *int64 {
	var text string
	switch n := value.(type) {
	case json.Number:
		text = n.String()
	case string:
		text = n
	case int:
		text = strconv.Itoa(n)
	case int64:
		text = strconv.FormatInt(n, 10)
	case float64:
		text = strconv.FormatFloat(n, 'f', -1, 64)
	default:
		return nil
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil || n < 0 || n > 9007199254740991 {
		return nil
	}
	return &n
}

func engagementFromVideo(series, vid string, video map[string]any) (Engagement, error) {
	out := Engagement{SeriesID: series, VideoID: vid}
	identity := firstNonEmpty(asString(video["series_id_str"]), asString(video["series_id"]))
	if identity != series {
		return out, errors.New("短剧统计身份不一致")
	}
	out.Favorites = engagementCount(video["followed_cnt"])
	out.RankBadge = rankBadge(video)
	metadata := &EngagementMetadata{ContentType: asString(video["content_type"]), VideoCategoryType: asString(video["video_category_type"]), Tags: dramaTags(video)}
	if metadata.ContentType != "" || metadata.VideoCategoryType != "" || len(metadata.Tags) > 0 {
		out.Metadata = metadata
	}
	rows, _ := video["video_list"].([]any)
	for _, raw := range rows {
		row, _ := asMap(raw)
		if asString(row["vid"]) != vid {
			continue
		}
		if id := asString(row["series_id"]); id != "" && id != series {
			return out, errors.New("集统计身份不一致")
		}
		out.Likes = engagementCount(row["digged_count"])
		out.Comments = engagementCount(row["comment_count"])
		out.EpisodeCover = episodeCoverURL(row["episode_cover"])
		return out, nil
	}
	return out, errors.New("当前集不在短剧统计列表中")
}

func (c *passportClient) Engagement(ctx context.Context, series, vid string) (Engagement, error) {
	if !validID(series) || !validID(vid) || series == "0" || vid == "0" {
		return Engagement{}, errors.New("短剧或视频 ID 无效")
	}
	p, err := c.cloudJSON(ctx, "/novel/player/multi_video_detail/preload/v1", http.MethodPost, nil, map[string]any{
		"dr_scene": "preload", "series_id": series,
		"biz_param": map[string]any{"detail_page_version": 0, "disable_digg_stat": false, "disable_video_relate_book": false, "need_all_video_definition": false, "need_mp4_align": false, "source": 7, "use_os_player": false, "use_server_dns": false},
	})
	if err != nil {
		return Engagement{}, err
	}
	data, _ := asMap(p["data"])
	row, _ := asMap(data[series])
	video, _ := asMap(row["video_data"])
	out, err := engagementFromVideo(series, vid, video)
	if err != nil {
		return out, err
	}
	if out.Comments == nil {
		// Some episode rows omit comment_count. Use the existing current-VID
		// discussion protocol rather than reusing the first episode's count.
		discussion, e := c.Discussion(ctx, url.Values{"series_id": {series}, "vid": {vid}}, false)
		if e == nil {
			n := int64(discussion.Total)
			if n >= 0 {
				out.Comments = &n
			}
		}
	}
	return out, nil
}

func (s *server) engagement(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "method not allowed")
		return
	}
	series, vid := r.URL.Query().Get("series_id"), r.URL.Query().Get("vid")
	if !validID(series) || !validID(vid) || series == "0" || vid == "0" {
		writeError(w, 400, "短剧或视频 ID 无效")
		return
	}
	client, g, err := s.accounts.listClient(false)
	if err != nil {
		writeError(w, 401, err.Error())
		return
	}
	result, err := client.Engagement(r.Context(), series, vid)
	if !s.accounts.sameGeneration(g) {
		writeError(w, 409, errAccountChanged.Error())
		return
	}
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "data": result})
}
