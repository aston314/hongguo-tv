package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
)

const creatorAlbumContentType = "1003"

// A creator album is a catalogue identity (1003), not a playback identity.
// Its ordered uploads use their series_id as video_id with content_type=1001.
// Keep the album ID in library records and resolve the full directory before
// starting playback; search's album_info contains only the first upload.
func normalizeCreatorAlbum(album, card map[string]any) (Drama, bool) {
	id := firstNonEmpty(album["album_id_str"], album["album_id"])
	cardID := firstNonEmpty(card["series_id_str"], card["series_id"])
	if !validID(id) || cardID != "" && cardID != id {
		return Drama{}, false
	}
	drama := Drama{
		SeriesID: id, ContentType: creatorAlbumContentType,
		Title:        firstNonEmpty(album["title"], card["series_title"], card["title"], "未命名合集"),
		Cover:        firstNonEmpty(album["cover"], card["series_cover"], card["cover"]),
		Intro:        firstNonEmpty(album["intro"], card["series_intro"]),
		EpisodeCount: asInt(album["episode_cnt"]), Tags: dramaTags(album),
		SeriesStatus: asString(album["series_status"]),
	}
	drama.CoverFallback = browserCoverFallback(drama.Cover)
	return drama, true
}

func parseCreatorAlbum(payload map[string]any, albumID string) (SeriesDetailResult, error) {
	if asString(payload["code"]) != "0" {
		return SeriesDetailResult{}, errors.New("云端未确认合集请求成功")
	}
	data, _ := asMap(payload["data"])
	album, _ := asMap(data["album_data"])
	drama, ok := normalizeCreatorAlbum(album, nil)
	if !ok || drama.SeriesID != albumID {
		return SeriesDetailResult{}, errors.New("合集详情与请求不一致")
	}
	rows, _ := album["video_detail_list"].([]any)
	// This endpoint returns the complete ordered directory without a cursor.
	// Reject an incomplete response rather than silently renumbering episodes.
	if len(rows) == 0 || len(rows) > 2000 || asBool(data["has_more"]) || asBool(album["has_more"]) ||
		drama.EpisodeCount > 0 && drama.EpisodeCount != len(rows) {
		return SeriesDetailResult{}, errors.New("合集目录不完整，请重试")
	}
	seen := make(map[string]bool, len(rows))
	for i, value := range rows {
		row, _ := asMap(value)
		id := firstNonEmpty(row["series_id_str"], row["series_id"])
		if !validID(id) || seen[id] || asString(row["content_type"]) != "1001" {
			return SeriesDetailResult{}, errors.New("合集视频数据无效，请重试")
		}
		seen[id] = true
		drama.VidList = append(drama.VidList, id)
		drama.Episodes = append(drama.Episodes, Episode{Index: i + 1, VideoID: id,
			Title: firstNonEmpty(row["series_title"], fmt.Sprintf("第%d集", i+1))})
	}
	drama.EpisodeCount = len(rows)
	drama.AccessibleEpisodeCnt = len(rows)
	drama.Vid = drama.VidList[0]
	return SeriesDetailResult{Drama: drama}, nil
}

func (m *accountManager) CreatorAlbumDetail(ctx context.Context, albumID string) (SeriesDetailResult, error) {
	if !validID(albumID) {
		return SeriesDetailResult{}, errors.New("series_id 无效")
	}
	c, generation, err := m.searchClient(ctx)
	if err != nil {
		return SeriesDetailResult{}, err
	}
	payload, err := c.cloudJSON(ctx, "/novel/player/album_detail/v1/", http.MethodPost, nil, map[string]any{
		"album_id": albumID, "series_ids": []int64{}, "need_video_detail_info": true,
		"biz_param": map[string]any{"video_platform": 3},
	})
	if !m.sameGeneration(generation) {
		return SeriesDetailResult{}, errAccountChanged
	}
	if err != nil {
		return SeriesDetailResult{}, err
	}
	return parseCreatorAlbum(payload, albumID)
}
