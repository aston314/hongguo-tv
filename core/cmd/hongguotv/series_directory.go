package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

var errSeriesDetailIdentity = errors.New("详情返回的剧集与请求不一致")

// A website preview is metadata, not a complete playback directory. In
// particular, v1_ opaque web IDs must never enter the numeric App resolver.
func completeSeriesDirectory(d Drama) bool {
	if d.EpisodeCount < 0 || d.EpisodeCount > 10000 || len(d.VidList) != d.EpisodeCount {
		return false
	}
	seen := make(map[string]bool, len(d.VidList))
	for _, id := range d.VidList {
		if !validID(id) || id == "0" || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func (c *hongguoClient) SeriesDetail(ctx context.Context, seriesID string) (SeriesDetailResult, error) {
	if !validID(seriesID) || seriesID == "0" {
		return SeriesDetailResult{}, errors.New("series_id 无效")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	webCtx, stop := context.WithTimeout(ctx, 6*time.Second)
	web, webErr := c.webSeriesDetail(webCtx, seriesID)
	stop()
	if ctx.Err() != nil {
		return SeriesDetailResult{}, ctx.Err()
	}
	if errors.Is(webErr, errSeriesDetailIdentity) {
		return SeriesDetailResult{}, webErr
	}
	if webErr == nil && completeSeriesDirectory(web.Drama) {
		return web, nil
	}
	// Public metadata uses an independent anonymous identity. Do not borrow
	// account cookies or consume an identity belonging to playback resolution.
	client := newPassportClient(accountSession{DeviceID: miniReelRandomID(), InstallID: miniReelRandomID(), Cookies: map[string]string{}})
	client.base = c.apiBase
	client.http.Transport = c.httpClient.Transport
	payload, err := client.cloudJSON(ctx, "/novel/player/multi_video_detail/preload/v1", http.MethodPost, nil, map[string]any{
		"dr_scene": "preload", "series_id": seriesID,
		"biz_param": map[string]any{"detail_page_version": 0, "disable_digg_stat": false, "disable_video_relate_book": false, "need_all_video_definition": false, "need_mp4_align": false, "source": 7, "use_os_player": false, "use_server_dns": false},
	})
	if err != nil {
		return SeriesDetailResult{}, err
	}
	app, err := parseAppSeriesDirectory(payload, seriesID)
	if err != nil {
		return SeriesDetailResult{}, err
	}
	if webErr == nil {
		// Preserve the website's score, actors and social sections. Only the
		// independently validated App directory owns episode IDs and order.
		web.Vid, web.VidList, web.Episodes = app.Vid, app.VidList, app.Episodes
		web.EpisodeCount, web.AccessibleEpisodeCnt = app.EpisodeCount, app.AccessibleEpisodeCnt
		if len(web.Actors) == 0 {
			web.Actors = app.Actors
		}
		if len(web.Tags) == 0 {
			web.Tags = app.Tags
		}
		if web.ContentType == "" {
			web.ContentType = app.ContentType
		}
		if web.VideoCategoryType == "" {
			web.VideoCategoryType = app.VideoCategoryType
		}
		return web, nil
	}
	return app, nil
}

func parseAppSeriesDirectory(payload map[string]any, seriesID string) (SeriesDetailResult, error) {
	invalid := func() (SeriesDetailResult, error) {
		return SeriesDetailResult{}, errors.New("分集目录不完整或身份不一致，请重试")
	}
	if asString(payload["code"]) != "0" {
		return invalid()
	}
	data, _ := asMap(payload["data"])
	entry, _ := asMap(data[seriesID])
	video, _ := asMap(entry["video_data"])
	drama, ok := normalizeDrama(video)
	if !ok || drama.SeriesID != seriesID || drama.ContentType == creatorAlbumContentType {
		return invalid()
	}
	for _, key := range []string{"series_id", "series_id_str"} {
		if id := asString(video[key]); id != "" && id != seriesID {
			return invalid()
		}
	}
	rows, ok := video["video_list"].([]any)
	count, countErr := strconv.Atoi(asString(video["episode_cnt"]))
	if !ok || countErr != nil || count < 0 || count > 10000 || count != len(rows) || asBool(entry["has_more"]) || asBool(video["has_more"]) {
		return invalid()
	}
	drama.EpisodeCount = count
	drama.VidList, drama.Episodes = make([]string, 0, count), make([]Episode, 0, count)
	for i, raw := range rows {
		row, _ := asMap(raw)
		id := asString(row["vid"])
		if !validID(id) || id == "0" || asString(row["vid_index"]) != strconv.Itoa(i+1) {
			return invalid()
		}
		for _, key := range []string{"series_id", "series_id_str"} {
			if reported := asString(row[key]); reported != "" && reported != seriesID {
				return invalid()
			}
		}
		drama.VidList = append(drama.VidList, id)
		drama.Episodes = append(drama.Episodes, Episode{Index: i + 1, VideoID: id, Title: fmt.Sprintf("第%d集", i+1), Locked: asBool(row["disable_play"])})
	}
	if !completeSeriesDirectory(drama) {
		return invalid()
	}
	drama.Vid = ""
	if len(drama.VidList) > 0 {
		drama.Vid = drama.VidList[0]
	}
	drama.AccessibleEpisodeCnt = len(rows)
	return SeriesDetailResult{Drama: drama, Actors: normalizeSeriesActors(video)}, nil
}
