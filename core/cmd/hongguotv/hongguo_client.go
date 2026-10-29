package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHongguoAPI = "https://api5-normal-sinfonlineb.fqnovel.com"
	defaultHongguoWeb = "https://hongguoduanju.com"
	defaultHongguoUA  = "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)"
)

// Drama is the stable TV-facing model shared by category cards and details.
// The IDs remain strings because Hongguo uses 19-digit identifiers and a
// JavaScript number would round them.
type Drama struct {
	SeriesID             string    `json:"series_id"`
	Title                string    `json:"title"`
	Cover                string    `json:"cover"`
	CoverFallback        string    `json:"cover_fallback,omitempty"`
	Intro                string    `json:"intro"`
	Score                string    `json:"score,omitempty"`
	PlayCount            int64     `json:"play_count,omitempty"`
	EpisodeCount         int       `json:"episode_count,omitempty"`
	AccessibleEpisodeCnt int       `json:"accessible_episode_cnt,omitempty"`
	Vid                  string    `json:"vid,omitempty"`
	VidList              []string  `json:"vid_list,omitempty"`
	Tags                 []string  `json:"tags,omitempty"`
	Rank                 int       `json:"rank,omitempty"`
	Heat                 string    `json:"heat,omitempty"`
	FavoriteText         string    `json:"favorite_text,omitempty"`
	LikeText             string    `json:"like_text,omitempty"`
	StatusTags           []string  `json:"status_tags,omitempty"`
	Episodes             []Episode `json:"episodes,omitempty"`
	SeasonIndex          int       `json:"season_index,omitempty"`
	MultiSeason          bool      `json:"is_multi_season,omitempty"`
	ReservationID        string    `json:"reservation_id,omitempty"`
	Upcoming             bool      `json:"upcoming,omitempty"`
	Reserved             bool      `json:"reserved,omitempty"`
	PublishTime          int64     `json:"publish_time,omitempty"`
	PublishText          string    `json:"publish_text,omitempty"`
	ActorID              string    `json:"actor_id,omitempty"`
	MetadataPending      bool      `json:"metadata_pending,omitempty"`
	ContentType          string    `json:"content_type,omitempty"`
	VideoCategoryType    string    `json:"video_category_type,omitempty"`
	FollowingUpdate      bool      `json:"following_update,omitempty"`
	Followed             bool      `json:"followed,omitempty"`
	FollowCount          int64     `json:"follow_count,omitempty"`
	ShowUpdateFrequency  string    `json:"show_update_frequency,omitempty"`
	FollowUpdateTime     int64     `json:"follow_update_time,omitempty"`
	LatestWatchedEpisode int       `json:"latest_watched_episode,omitempty"`
	HasWatchedLatest     bool      `json:"has_watched_latest_episode,omitempty"`
	SeriesStatus         string    `json:"series_status,omitempty"`
}

type Episode struct {
	Index          int    `json:"index"`
	VideoID        string `json:"video_id"`
	Title          string `json:"title,omitempty"`
	Locked         bool   `json:"locked"`
	LockedInferred bool   `json:"locked_inferred,omitempty"`
}

type CategoryRequest struct {
	Path      string
	Offset    int
	SessionID string
	Shown     []string
	Filters   map[string]string
	Selectors bool
}

type CategoryFilterOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type CategoryFilterRow struct {
	Type    string                 `json:"type"`
	Label   string                 `json:"label"`
	Options []CategoryFilterOption `json:"options"`
}

type CategoryResult struct {
	Items      []Drama             `json:"items"`
	HasMore    bool                `json:"has_more"`
	NextOffset int                 `json:"next_offset"`
	SessionID  string              `json:"session_id,omitempty"`
	Filters    []CategoryFilterRow `json:"filters,omitempty"`
}

type SeriesDetailResult struct {
	Drama
	Reviews []SeriesReview `json:"reviews,omitempty"`
	Related []Drama        `json:"related,omitempty"`
	Actors  []SeriesActor  `json:"actors,omitempty"`
}

type SeriesActor struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar,omitempty"`
}

type SeriesReview struct {
	ID         string `json:"id,omitempty"`
	UserName   string `json:"user_name,omitempty"`
	Avatar     string `json:"avatar,omitempty"`
	Content    string `json:"content,omitempty"`
	Rating     int    `json:"rating,omitempty"`
	DiggCount  int64  `json:"digg_count,omitempty"`
	ReplyCount int64  `json:"reply_count,omitempty"`
	CreateTime int64  `json:"create_time,omitempty"`
}

type SearchResult struct {
	Items []Drama `json:"items"`
}

type SearchSuggestion struct {
	Kind    string `json:"kind"`
	Key     string `json:"key"`
	Name    string `json:"name"`
	ActorID string `json:"actor_id,omitempty"`
	Meta    string `json:"meta,omitempty"`
	Drama   *Drama `json:"drama,omitempty"`
}

type SearchSuggestionsResult struct {
	Items []SearchSuggestion `json:"items"`
}

// ActorWorksResult is returned by the public actor search page. Actor IDs are
// kept as strings because Hongguo uses 19-digit identifiers.
type ActorWorksResult struct {
	Actor ActorSummary `json:"actor"`
	Items []Drama      `json:"items"`
}

type ActorSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Avatar      string `json:"avatar,omitempty"`
	Description string `json:"description,omitempty"`
}

type RankRequest struct {
	Path string
}

type PlayInfo struct {
	Path          string   `json:"path"`
	Quality       string   `json:"quality,omitempty"`
	Qualities     []string `json:"qualities,omitempty"`
	VideoWidth    int      `json:"video_width,omitempty"`
	VideoHeight   int      `json:"video_height,omitempty"`
	Vid           string   `json:"vid"`
	Mode          string   `json:"mode,omitempty"`
	RangeFallback string   `json:"range_fallback,omitempty"`
}

type hongguoClient struct {
	httpClient       *http.Client
	apiBase          string
	webBase          string
	userAgent        string
	internalPlayback func(context.Context, string, string, string, bool) (PlayInfo, error)
}

func newHongguoClient() *hongguoClient {
	apiBase := strings.TrimRight(envOr("HONGGUO_API_BASE", defaultHongguoAPI), "/")
	webBase := strings.TrimRight(envOr("HONGGUO_WEB_BASE", defaultHongguoWeb), "/")
	return &hongguoClient{
		httpClient:       &http.Client{Timeout: 80 * time.Second},
		apiBase:          apiBase,
		webBase:          webBase,
		userAgent:        envOr("HONGGUO_USER_AGENT", defaultHongguoUA),
		internalPlayback: embeddedMiniReelPlayInfo,
	}
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func (c *hongguoClient) appQuery() string {
	values := url.Values{
		"app_name":              {"novelread"},
		"os_version":            {"16"},
		"ac":                    {"wifi"},
		"version_code":          {"73532"},
		"update_version_code":   {"73532"},
		"manifest_version_code": {"73532"},
		"aid":                   {"8662"},
		"os_api":                {"36"},
		"resolution":            {"1280*2772"},
		"ssmix":                 {"a"},
		"language":              {"zh"},
		"device_brand":          {"Redmi"},
		"device_type":           {"25053RT47C"},
		"dpi":                   {"520"},
		"version_name":          {"7.3.5.32"},
		"device_platform":       {"android"},
		"channel":               {"update_64"},
		"os":                    {"android"},
	}
	return values.Encode()
}

type categorySpec struct {
	scene string
	genre string
}

func categorySpecFor(path string) categorySpec {
	switch path {
	case "/category/comic-drama":
		return categorySpec{scene: "comic_series", genre: "comic_series"}
	case "/category/ai-drama":
		return categorySpec{scene: "ai_series", genre: "ai_series"}
	case "/category/comic":
		return categorySpec{scene: "comic", genre: "comic"}
	default:
		// This is also the feed used by the Mac client's default short-drama
		// shelf and by the web hot-drama route.
		return categorySpec{scene: "default", genre: "short_play"}
	}
}

func categorySortFor(path string) string {
	if strings.HasPrefix(path, "/new/") {
		return "online_time"
	}
	return "hot_score"
}

func normalizeRankPath(path string) string {
	switch path {
	case "/rank/hot-drama", "/rank/hot-real-drama", "/rank/hot-comic-drama", "/rank/hot-ai-drama":
		return path
	default:
		return "/rank/hot-drama"
	}
}

func (c *hongguoClient) Category(ctx context.Context, request CategoryRequest) (CategoryResult, error) {
	spec := categorySpecFor(request.Path)
	selection, err := categorySelection(request)
	if err != nil {
		return CategoryResult{}, err
	}
	// The app returns selector_rows with default, not only_content or all.
	reqType := "only_content"
	if request.Selectors {
		reqType = "default"
	}
	shown := strings.Join(request.Shown, ",")
	body := map[string]any{
		"filter_ids":          shown,
		"req_scene":           spec.scene,
		"offset":              maxInt(request.Offset, 0),
		"need_selector_panel": request.Selectors,
		"limit":               15,
		"select_items":        selection,
		"session_id":          request.SessionID,
		"req_type":            reqType,
		"client_req_type":     3,
	}
	payload, err := c.postSignedJSON(ctx, "/reading/distribution/category/landpage/v/", body)
	if err != nil {
		return CategoryResult{}, err
	}
	data, ok := asMap(payload["data"])
	if !ok {
		return CategoryResult{}, errors.New("分类响应缺少 data")
	}
	rows, _ := data["video_data"].([]any)
	result := CategoryResult{
		HasMore:    asBool(data["has_more"]),
		NextOffset: asInt(data["next_offset"]),
		SessionID:  asString(data["session_id"]),
		Items:      make([]Drama, 0, len(rows)),
	}
	if request.Selectors {
		result.Filters = normalizeCategoryFilters(data["selector_rows"])
	}
	for _, row := range rows {
		if drama, ok := normalizeDrama(row); ok {
			result.Items = append(result.Items, drama)
		}
	}
	if result.NextOffset == 0 && result.HasMore {
		result.NextOffset = maxInt(request.Offset, 0) + len(result.Items)
	}
	return result, nil
}

// Category is an anonymous app endpoint, but it still requires the same
// Passport envelope as the account APIs. Some edge nodes return HTTP 200 with
// an empty body when a device identity is rejected, so rotate the one-shot
// identity and retry only that transient response.
func (c *hongguoClient) postSignedJSON(ctx context.Context, path string, body any) (map[string]any, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		client := newPassportClient(accountSession{
			DeviceID:  miniReelRandomID(),
			InstallID: miniReelRandomID(),
			Cookies:   map[string]string{},
		})
		client.http = c.httpClient
		client.base = c.apiBase
		payload, requestErr := client.cloudJSONBody(ctx, path, http.MethodPost, nil, raw, "application/json; charset=utf-8", nil)
		if requestErr == nil {
			return payload, nil
		}
		if !errors.Is(requestErr, errPassportEmptyResponse) || attempt == 2 {
			return nil, requestErr
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return nil, errPassportEmptyResponse
}

var categoryFilterNames = map[string]string{
	"genre": "体裁", "category_dim_theme": "主题", "category_dim_role": "设定",
	"category_dim_epoch": "背景", "sort": "推荐", "gender": "受众",
	"online_time": "时间", "creation_status": "状态",
}

var categoryTagID = regexp.MustCompile(`^cate_[0-9]{1,8}$`)

func validCategoryFilter(kind, value string) bool {
	if _, ok := categoryFilterNames[kind]; !ok {
		return false
	}
	if value == "" { // An explicit empty selection means 全部, including genre.
		return true
	}
	switch kind {
	case "genre":
		return value == "short_play" || value == "comic_series" || value == "ai_series"
	case "category_dim_theme", "category_dim_role", "category_dim_epoch":
		return categoryTagID.MatchString(value)
	case "sort":
		return value == "hot_score" || value == "online_time" || value == "hot_collect"
	case "gender":
		return value == "0" || value == "1"
	case "online_time":
		return value == "days_7" || value == "days_14" || value == "days_30" || value == "days_90"
	case "creation_status":
		return value == "creation_status_0" || value == "creation_status_1"
	}
	return false
}

func categorySelection(request CategoryRequest) (map[string][]string, error) {
	selection := map[string][]string{}
	for kind := range categoryFilterNames {
		selection[kind] = []string{}
	}
	selection["genre"] = []string{categorySpecFor(request.Path).genre}
	selection["sort"] = []string{categorySortFor(request.Path)}
	for kind, value := range request.Filters {
		if !validCategoryFilter(kind, value) {
			return nil, fmt.Errorf("分类筛选参数无效: %s", kind)
		}
		selection[kind] = []string{}
		if value != "" {
			selection[kind] = []string{value}
		}
	}
	return selection, nil
}

func normalizeCategoryFilters(raw any) []CategoryFilterRow {
	rows, _ := raw.([]any)
	result := make([]CategoryFilterRow, 0, len(rows)+1)
	statusIndex := -1
	for _, value := range rows {
		row, ok := asMap(value)
		kind := asString(row["type"])
		label, supported := categoryFilterNames[kind]
		if !ok || !supported {
			continue
		}
		filter := CategoryFilterRow{Type: kind, Label: label, Options: []CategoryFilterOption{}}
		items, _ := row["items"].([]any)
		seen := map[string]bool{}
		for _, item := range items {
			option, _ := asMap(item)
			id, name := asString(option["selector_item_id"]), asString(option["show_name"])
			if id == "" || name == "" || seen[id] || !validCategoryFilter(kind, id) {
				continue
			}
			seen[id] = true
			filter.Options = append(filter.Options, CategoryFilterOption{ID: id, Label: name})
		}
		if len(filter.Options) > 0 {
			if kind == "creation_status" {
				statusIndex = len(result)
			}
			result = append(result, filter)
		}
	}
	// Some category scenes omit the status selector entirely, and some return
	// only one of the two values. The Mac client always exposes the same
	// three-way choice (全部 / 已完结 / 连载中), so keep that contract stable
	// instead of making the TV UI depend on a scene-specific response shape.
	status := CategoryFilterRow{
		Type:  "creation_status",
		Label: "状态",
		Options: []CategoryFilterOption{
			{ID: "creation_status_0", Label: "已完结"},
			{ID: "creation_status_1", Label: "连载中"},
		},
	}
	if statusIndex < 0 {
		// Keep the same rhythm as the Mac filter panel: status sits before
		// the optional "时间" row when that row is present.
		statusIndex = len(result)
		for index, row := range result {
			if row.Type == "online_time" {
				statusIndex = index
				break
			}
		}
		result = append(result, CategoryFilterRow{})
		copy(result[statusIndex+1:], result[statusIndex:])
		result[statusIndex] = status
	} else {
		result[statusIndex] = status
	}
	return result
}

func (c *hongguoClient) Rank(ctx context.Context, request RankRequest) (CategoryResult, error) {
	path := normalizeRankPath(request.Path)
	body, err := c.getBytesWithUA(ctx, c.webBase+path, "text/html", "Googlebot")
	if err != nil {
		return CategoryResult{}, err
	}
	router, err := extractRouterData(body)
	if err != nil {
		return CategoryResult{}, err
	}
	content, ok := findObjectByKey(router, "content")
	if !ok {
		return CategoryResult{Items: []Drama{}}, nil
	}
	rows, _ := content["rankList"].([]any)
	result := CategoryResult{Items: make([]Drama, 0, len(rows))}
	if pagination, ok := asMap(content["pagination"]); ok {
		page := asInt(pagination["pageNum"])
		totalPages := asInt(pagination["totalPages"])
		result.HasMore = page > 0 && totalPages > page
		result.NextOffset = page + 1
	}
	seen := make(map[string]bool)
	for _, row := range rows {
		drama, valid := normalizeDrama(row)
		if !valid || drama.SeriesID == "" || seen[drama.SeriesID] {
			continue
		}
		seen[drama.SeriesID] = true
		result.Items = append(result.Items, drama)
	}
	return result, nil
}

func (c *hongguoClient) SeriesDetail(ctx context.Context, seriesID string) (SeriesDetailResult, error) {
	if !validID(seriesID) {
		return SeriesDetailResult{}, errors.New("series_id 无效")
	}
	body, err := c.getBytes(ctx, c.webBase+"/detail?series_id="+url.QueryEscape(seriesID), "text/html")
	if err != nil {
		return SeriesDetailResult{}, err
	}
	router, err := extractRouterData(body)
	if err != nil {
		return SeriesDetailResult{}, err
	}
	detailMap, ok := findObjectByKey(router, "seriesDetail")
	if !ok {
		return SeriesDetailResult{}, errors.New("详情响应缺少 seriesDetail")
	}
	drama, ok := normalizeDrama(detailMap)
	if !ok || drama.SeriesID == "" {
		return SeriesDetailResult{}, errors.New("详情响应缺少剧集信息")
	}
	if drama.SeriesID != seriesID {
		return SeriesDetailResult{}, errors.New("详情返回的剧集与请求不一致")
	}
	if drama.EpisodeCount == 0 {
		drama.EpisodeCount = len(drama.VidList)
	}
	if drama.AccessibleEpisodeCnt <= 0 || drama.AccessibleEpisodeCnt > len(drama.VidList) {
		drama.AccessibleEpisodeCnt = len(drama.VidList)
	}
	drama.Episodes = make([]Episode, 0, len(drama.VidList))
	for index, vid := range drama.VidList {
		drama.Episodes = append(drama.Episodes, Episode{
			Index: index + 1, VideoID: vid,
			Title:  fmt.Sprintf("第%d集", index+1),
			Locked: index >= drama.AccessibleEpisodeCnt, LockedInferred: index >= drama.AccessibleEpisodeCnt,
		})
	}
	detailPage, ok := findObjectByKey(router, "detail_page")
	if !ok {
		detailPage, _ = asMap(router)
	}
	related := normalizeRelatedDramas(detailPage, seriesID)
	if len(related) == 0 {
		related = normalizeRelatedDramas(extractDeferredRecommendations(body), seriesID)
	}
	actors := normalizeSeriesActors(detailMap)
	if len(actors) == 0 {
		actors = normalizeSeriesActors(detailPage)
	}
	return SeriesDetailResult{Drama: drama, Reviews: normalizeSeriesReviews(detailPage), Related: related, Actors: actors}, nil
}

func normalizeSeriesActors(value map[string]any) []SeriesActor {
	if value == nil {
		return nil
	}
	var raw []any
	for _, key := range []string{"celebrities", "celebrity_list", "actors", "actor_list"} {
		if items, ok := value[key].([]any); ok {
			raw = items
			break
		}
	}
	seen := make(map[string]bool)
	actors := make([]SeriesActor, 0, len(raw))
	for _, item := range raw {
		person, ok := asMap(item)
		if !ok {
			continue
		}
		if nested, ok := asMap(person["user_info"]); ok {
			person = nested
			if base, ok := asMap(person["base_info"]); ok {
				person = base
			}
		}
		id := firstNonEmpty(asString(person["celebrity_id"]), asString(person["actor_id"]), asString(person["actor_id_str"]), asString(person["person_id"]))
		name := firstNonEmpty(asString(person["nickname"]), asString(person["user_name"]), asString(person["celebrity_name"]), asString(person["actor_name"]), asString(person["name"]))
		if name == "" {
			continue
		}
		key := id
		if key == "" {
			key = name
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		actors = append(actors, SeriesActor{
			ID:     id,
			Name:   name,
			Avatar: firstNonEmpty(asString(person["user_avatar"]), asString(person["avatar"]), asString(person["avatar_url"]), asString(person["cover_url"])),
		})
	}
	return actors
}

func extractDeferredRecommendations(body []byte) map[string]any {
	const marker = "<script"
	for offset := 0; offset < len(body); {
		start := bytes.Index(body[offset:], []byte(marker))
		if start < 0 {
			break
		}
		start += offset
		end := scriptTagEnd(body, start)
		if end < 0 {
			break
		}
		token, err := xml.NewDecoder(bytes.NewReader(body[start : end+1])).Token()
		if err != nil {
			offset = end + 1
			continue
		}
		element, ok := token.(xml.StartElement)
		if !ok {
			offset = end + 1
			continue
		}
		script := map[string]string{}
		for _, attr := range element.Attr {
			script[attr.Name.Local] = attr.Value
		}
		offset = end + 1
		if script["data-fn-name"] != "mergeLoaderData" || script["data-fn-args"] == "" {
			continue
		}
		var args []any
		if json.Unmarshal([]byte(script["data-fn-args"]), &args) != nil || len(args) < 2 || args[0] != "detail_page" {
			continue
		}
		entries, _ := args[1].([]any)
		for _, raw := range entries {
			entry, _ := asMap(raw)
			if asString(entry["key"]) != "recommendations" || asString(entry["routerDataFnName"]) != "p" {
				continue
			}
			fnArgs, _ := entry["routerDataFnArgs"].([]any)
			if len(fnArgs) == 0 {
				continue
			}
			encoded, _ := fnArgs[0].(string)
			var result map[string]any
			if json.Unmarshal([]byte(encoded), &result) == nil {
				return result
			}
		}
	}
	return nil
}

func scriptTagEnd(data []byte, start int) int {
	var quote byte
	for i := start; i < len(data); i++ {
		if quote != 0 {
			if data[i] == quote {
				quote = 0
			}
			continue
		}
		if data[i] == '\'' || data[i] == '"' {
			quote = data[i]
		} else if data[i] == '>' {
			return i
		}
	}
	return -1
}

func normalizeSeriesReviews(router map[string]any) []SeriesReview {
	rows, ok := findArrayByKey(router, "reviews")
	if !ok {
		rows, ok = findArrayByKey(router, "review_list")
	}
	if !ok {
		return []SeriesReview{}
	}
	out := make([]SeriesReview, 0, len(rows))
	for _, raw := range rows {
		m, ok := asMap(raw)
		if !ok {
			continue
		}
		if nested, exists := m["review"]; exists {
			if nestedMap, nestedOK := asMap(nested); nestedOK {
				m = nestedMap
			}
		}
		content := firstNonEmpty(asString(m["content"]), asString(m["text"]))
		if content == "" {
			if common, ok := asMap(m["common"]); ok {
				if c, ok := asMap(common["content"]); ok {
					content = asString(c["text"])
				}
			}
		}
		if content == "" {
			continue
		}
		out = append(out, SeriesReview{
			ID:         firstNonEmpty(asString(m["review_id"]), asString(m["comment_id"]), asString(m["id"])),
			UserName:   firstNonEmpty(asString(m["user_name"]), asString(m["username"]), asString(m["name"])),
			Avatar:     firstNonEmpty(asString(m["avatar"]), asString(m["user_avatar"])),
			Content:    content,
			Rating:     asInt(m["rating"]),
			DiggCount:  firstPositive64(asInt64(m["digg_count"]), asInt64(m["like_count"])),
			ReplyCount: asInt64(m["reply_count"]),
			CreateTime: firstPositive64(asInt64(m["create_time"]), asInt64(m["create_timestamp"])),
		})
	}
	return out
}

func normalizeRelatedDramas(router map[string]any, currentID string) []Drama {
	keys := []string{"related_list", "videoList", "related", "detail_page_more_related", "related_video", "rawRelatedVideo"}
	rows := make([]any, 0)
	for _, key := range keys {
		if found, ok := findArrayByKey(router, key); ok {
			rows = append(rows, found...)
		}
	}
	out := make([]Drama, 0, len(rows))
	seen := map[string]bool{}
	for _, raw := range rows {
		if nested, ok := asMap(raw); ok {
			if value, exists := nested["model"]; exists {
				if model, modelOK := asMap(value); modelOK {
					raw = model
				}
			}
		}
		d, ok := normalizeDrama(raw)
		if !ok || d.SeriesID == currentID || seen[d.SeriesID] {
			continue
		}
		seen[d.SeriesID] = true
		out = append(out, d)
	}
	return out
}

func (c *hongguoClient) Search(ctx context.Context, query string) (SearchResult, error) {
	page, err := c.SearchPage(ctx, query, 1)
	return SearchResult{Items: page.Items}, err
}

func (c *hongguoClient) SearchSuggestions(ctx context.Context, query string) (SearchSuggestionsResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return SearchSuggestionsResult{Items: []SearchSuggestion{}}, nil
	}
	if len([]rune(query)) > 100 {
		return SearchSuggestionsResult{}, errors.New("搜索关键词过长")
	}
	params := url.Values{"app_id": {"8662"}, "query": {query}, "count": {"10"}}
	body, err := c.getBytes(ctx, c.webBase+"/incent_resource/suggestion?"+params.Encode(), "application/json")
	if err != nil {
		return SearchSuggestionsResult{}, err
	}
	var payload struct {
		Suggestions []map[string]any `json:"suggest_list"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return SearchSuggestionsResult{}, fmt.Errorf("解析搜索建议失败: %w", err)
	}
	result := SearchSuggestionsResult{Items: make([]SearchSuggestion, 0, len(payload.Suggestions))}
	for _, row := range payload.Suggestions {
		name := firstNonEmpty(row["name"])
		if name == "" {
			words := asStringSlice(row["display_words"])
			if len(words) > 0 {
				name = words[0]
			}
		}
		if name == "" {
			continue
		}
		kind := asString(row["word_type"])
		if kind == "" {
			kind = "common_query"
		}
		suggestion := SearchSuggestion{Kind: kind, Key: asString(row["keyword"]), Name: name}
		if kind == "short_play_actor" {
			suggestion.ActorID = suggestion.Key
		}
		if videoData, ok := asMap(row["video_data"]); ok && len(videoData) > 0 {
			if drama, valid := normalizeDrama(videoData); valid {
				if drama.Title == "未命名短剧" {
					drama.Title = name
				}
				suggestion.Drama = &drama
				suggestion.Meta = suggestionMeta(videoData)
			}
		}
		result.Items = append(result.Items, suggestion)
	}
	return result, nil
}

func suggestionMeta(videoData map[string]any) string {
	parts := make([]string, 0, 2)
	if categories, ok := videoData["category_list"].([]any); ok {
		for _, category := range categories {
			if object, ok := asMap(category); ok {
				if name := asString(object["name"]); name != "" {
					parts = append(parts, name)
				}
			}
			if len(parts) >= 3 {
				break
			}
		}
	}
	if hot, ok := asMap(videoData["hot_score_data"]); ok {
		if text := asString(hot["text"]); text != "" {
			parts = append(parts, text)
		}
	}
	if count := asInt(videoData["episode_cnt"]); count > 0 {
		parts = append(parts, fmt.Sprintf("全%d集", count))
	}
	return strings.Join(parts, " · ")
}

// ActorWorks uses the public character page used by the web client. The page
// carries actor metadata in userInfo and the real works in videoList.
func (c *hongguoClient) ActorWorks(ctx context.Context, actorID string) (ActorWorksResult, error) {
	actorID = strings.TrimSpace(actorID)
	if !validID(actorID) || actorID == "0" {
		return ActorWorksResult{}, errors.New("actor_id 无效")
	}
	body, err := c.getBytes(ctx, c.webBase+"/character/"+url.PathEscape(actorID), "text/html")
	if err != nil {
		return ActorWorksResult{}, err
	}
	router, err := extractRouterData(body)
	if err != nil {
		return ActorWorksResult{}, err
	}
	routerObject, ok := asMap(router)
	if !ok {
		return ActorWorksResult{}, errors.New("演员作品响应根数据无效")
	}
	loaderData, ok := asMap(routerObject["loaderData"])
	if !ok {
		return ActorWorksResult{}, errors.New("演员作品响应缺少 loaderData")
	}
	page, ok := asMap(loaderData["character_(id)/page"])
	if !ok {
		return ActorWorksResult{}, errors.New("演员作品响应缺少详情页面数据")
	}
	result := ActorWorksResult{Actor: ActorSummary{ID: actorID}, Items: []Drama{}}
	user, userOK := asMap(page["userInfo"])
	if !userOK {
		return ActorWorksResult{}, errors.New("演员作品响应缺少 userInfo")
	}
	id := firstNonEmpty(asString(user["actor_id"]), asString(user["actor_id_str"]), asString(user["person_id"]))
	if id != actorID {
		return ActorWorksResult{}, errors.New("演员作品响应与请求不一致")
	}
	result.Actor.Name = firstNonEmpty(asString(user["user_name"]), asString(user["name"]), "未知演员")
	result.Actor.Avatar = firstNonEmpty(asString(user["user_avatar"]), asString(user["avatar"]))
	result.Actor.Description = firstNonEmpty(asString(user["description"]), asString(user["intro"]))
	works, _ := page["videoList"].([]any)
	seen := map[string]bool{}
	for _, work := range works {
		drama, valid := normalizeDrama(work)
		if !valid || !validID(drama.SeriesID) || drama.SeriesID == "0" || seen[drama.SeriesID] {
			continue
		}
		seen[drama.SeriesID] = true
		result.Items = append(result.Items, drama)
	}
	return result, nil
}

func (c *hongguoClient) PlayInfo(ctx context.Context, seriesID, vid string) (PlayInfo, error) {
	return c.PlayInfoQuality(ctx, seriesID, vid, "", true)
}

func (c *hongguoClient) PlayInfoQuality(ctx context.Context, seriesID, vid, quality string, fallback bool) (PlayInfo, error) {
	return c.PlayInfoQualityMode(ctx, seriesID, vid, quality, fallback, "default")
}

func (c *hongguoClient) PlayInfoQualityMode(ctx context.Context, seriesID, vid, quality string, fallback bool, codecMode string) (PlayInfo, error) {
	if !validID(seriesID) || !validID(vid) {
		return PlayInfo{}, errors.New("播放参数无效")
	}
	if c.internalPlayback == nil {
		return PlayInfo{}, errors.New("内置播放服务未初始化")
	}
	codecMode, err := normalizeMiniReelCodecMode(codecMode)
	if err != nil {
		return PlayInfo{}, err
	}
	if codecMode == "default" {
		result, err := c.internalPlayback(ctx, seriesID, vid, quality, fallback)
		if err != nil {
			return PlayInfo{}, fmt.Errorf("内置播放解析失败: %w", err)
		}
		if result.Path == "" {
			return PlayInfo{}, errors.New("内置播放服务没有返回地址")
		}
		if result.Vid == "" {
			result.Vid = vid
		}
		return result, nil
	}
	value, err := resolveMiniReelMediaQualityMode(ctx, seriesID, vid, quality, fallback, codecMode)
	if err != nil {
		return PlayInfo{}, fmt.Errorf("内置播放解析失败: %w", err)
	}
	result := PlayInfo{
		Path: asString(value["path"]), Quality: asString(value["quality"]), Qualities: value["qualities"].([]string),
		VideoWidth: miniReelIntFromAny(value["video_width"]), VideoHeight: miniReelIntFromAny(value["video_height"]),
		Vid: firstNonEmpty(value["vid"], vid), Mode: asString(value["mode"]),
	}
	if result.Path == "" {
		return PlayInfo{}, errors.New("内置播放服务没有返回地址")
	}
	if result.Vid == "" {
		result.Vid = vid
	}
	return result, nil
}

func (c *hongguoClient) PlayInfoRangeQuality(ctx context.Context, seriesID, vid, quality string, fallback, allowStandardFallback bool) (PlayInfo, error) {
	return c.PlayInfoRangeQualityMode(ctx, seriesID, vid, quality, fallback, allowStandardFallback, "default")
}

func (c *hongguoClient) PlayInfoRangeQualityMode(ctx context.Context, seriesID, vid, quality string, fallback, allowStandardFallback bool, codecMode string) (PlayInfo, error) {
	if !validID(seriesID) || !validID(vid) {
		return PlayInfo{}, errors.New("播放参数无效")
	}
	value, err := resolveMiniReelMediaRangeQualityMode(ctx, seriesID, vid, quality, fallback, allowStandardFallback, codecMode)
	if err != nil {
		return PlayInfo{}, fmt.Errorf("按需读取播放准备失败: %w", err)
	}
	return PlayInfo{
		Path:          asString(value["path"]),
		Quality:       asString(value["quality"]),
		Qualities:     value["qualities"].([]string),
		VideoWidth:    miniReelIntFromAny(value["video_width"]),
		VideoHeight:   miniReelIntFromAny(value["video_height"]),
		Vid:           firstNonEmpty(value["vid"], vid),
		Mode:          asString(value["mode"]),
		RangeFallback: asString(value["range_fallback"]),
	}, nil
}

func embeddedMiniReelPlayInfo(ctx context.Context, seriesID, vid, quality string, fallback bool) (PlayInfo, error) {
	value, err := resolveMiniReelMediaQuality(ctx, seriesID, vid, quality, fallback)
	if err != nil {
		return PlayInfo{}, err
	}
	return PlayInfo{
		Path:        asString(value["path"]),
		Quality:     asString(value["quality"]),
		Qualities:   value["qualities"].([]string),
		VideoWidth:  miniReelIntFromAny(value["video_width"]),
		VideoHeight: miniReelIntFromAny(value["video_height"]),
		Vid:         firstNonEmpty(value["vid"], vid),
		Mode:        asString(value["mode"]),
	}, nil
}

func (c *hongguoClient) postJSON(ctx context.Context, endpoint string, body any) (map[string]any, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", c.userAgent)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	return c.doJSON(request)
}

func (c *hongguoClient) doJSON(request *http.Request) (map[string]any, error) {
	body, err := c.readResponse(request, "application/json")
	if err != nil {
		return nil, err
	}
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("解析 JSON 失败: %w", err)
	}
	if code := asInt(value["code"]); code != 0 {
		return nil, fmt.Errorf("红果接口返回错误 code=%d message=%s", code, asString(value["message"]))
	}
	return value, nil
}

func (c *hongguoClient) getBytes(ctx context.Context, endpoint, accept string) ([]byte, error) {
	return c.getBytesWithUA(ctx, endpoint, accept, "Mozilla/5.0 (Android TV; HongguoTV)")
}

func (c *hongguoClient) getBytesWithUA(ctx context.Context, endpoint, accept, userAgent string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Accept", accept)
	return c.readResponse(request, accept)
}

func (c *hongguoClient) readResponse(request *http.Request, accept string) ([]byte, error) {
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("上游 HTTP %d", response.StatusCode)
	}
	if contentType := response.Header.Get("Content-Type"); accept == "application/json" && contentType != "" && !strings.Contains(contentType, "json") {
		// Some local playback bridges omit Content-Type; only reject an obvious
		// HTML response here so a valid JSON body is still accepted.
		if strings.Contains(contentType, "html") {
			return nil, errors.New("播放服务返回了 HTML")
		}
	}
	limited := io.LimitReader(response.Body, 12<<20)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return nil, errors.New("上游响应为空")
	}
	return body, nil
}

func extractRouterData(html []byte) (any, error) {
	marker := []byte("_ROUTER_DATA")
	position := bytes.Index(html, marker)
	if position < 0 {
		return nil, errors.New("页面缺少 _ROUTER_DATA")
	}
	start := position + len(marker)
	for start < len(html) && (html[start] == ' ' || html[start] == '\t' || html[start] == '\r' || html[start] == '\n' || html[start] == '=') {
		start++
	}
	for start < len(html) && html[start] != '{' && html[start] != '[' {
		start++
	}
	if start >= len(html) {
		return nil, errors.New("_ROUTER_DATA JSON 起点无效")
	}
	end, err := balancedJSONEnd(html, start)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(html[start:end]))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("解析 _ROUTER_DATA 失败: %w", err)
	}
	return value, nil
}

func balancedJSONEnd(data []byte, start int) (int, error) {
	depth := 0
	inString := false
	escaped := false
	for index := start; index < len(data); index++ {
		char := data[index]
		if inString {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '{', '[':
			depth++
		case '}', ']':
			depth--
			if depth == 0 {
				return index + 1, nil
			}
		}
	}
	return 0, errors.New("_ROUTER_DATA JSON 未闭合")
}

func findObjectByKey(value any, key string) (map[string]any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		if candidate, ok := typed[key].(map[string]any); ok {
			return candidate, true
		}
		for _, nested := range typed {
			if found, ok := findObjectByKey(nested, key); ok {
				return found, true
			}
		}
	case []any:
		for _, nested := range typed {
			if found, ok := findObjectByKey(nested, key); ok {
				return found, true
			}
		}
	}
	return nil, false
}

func findArrayByKey(value any, key string) ([]any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		if candidate, ok := typed[key].([]any); ok {
			return candidate, true
		}
		for _, nested := range typed {
			if found, ok := findArrayByKey(nested, key); ok {
				return found, true
			}
		}
	case []any:
		for _, nested := range typed {
			if found, ok := findArrayByKey(nested, key); ok {
				return found, true
			}
		}
	}
	return nil, false
}

func normalizeDrama(value any) (Drama, bool) {
	object, ok := asMap(value)
	if !ok {
		return Drama{}, false
	}
	if nested, exists := object["video_data"]; exists {
		if nestedObject, nestedOK := asMap(nested); nestedOK {
			object = nestedObject
		}
	}
	id := firstNonEmpty(asString(object["series_id_str"]), asString(object["series_id"]), asString(object["seriesId"]), asString(object["book_id"]), asString(object["id"]))
	title := firstNonEmpty(asString(object["series_title"]), asString(object["series_name"]), asString(object["title"]), "未命名短剧")
	if id == "" {
		return Drama{}, false
	}
	// Detail pages keep series_status inside series_episode_info, while list
	// and search responses commonly put it on the video object. Normalize both
	// shapes so the TV UI can distinguish an ongoing series from a completed
	// one before offering the follow action.
	episodeInfo, _ := asMap(object["series_episode_info"])
	seriesStatus := firstNonEmpty(object["series_status"], object["status"])
	if seriesStatus == "" && episodeInfo != nil {
		seriesStatus = firstNonEmpty(episodeInfo["series_status"], episodeInfo["status"])
	}
	drama := Drama{
		SeriesID:             id,
		Title:                title,
		Cover:                firstNonEmpty(asString(object["series_cover"]), asString(object["cover"]), asString(object["cover_url"])),
		Intro:                firstNonEmpty(asString(object["series_intro"]), asString(object["video_desc"]), asString(object["description"])),
		Score:                firstNonEmpty(asString(object["score"]), asString(object["rating"]), asString(object["scoreText"])),
		PlayCount:            asInt64(object["play_cnt"]),
		EpisodeCount:         firstPositive(asInt(object["episode_cnt"]), asInt(object["episode_total_cnt"])),
		AccessibleEpisodeCnt: firstPositive(asInt(object["accessible_episode_cnt"]), 0),
		Vid:                  firstNonEmpty(asString(object["vid"]), asString(object["video_id"])),
		Tags:                 asStringSlice(object["tags"]),
		VidList:              asStringSlice(object["vid_list"]),
		Rank:                 asInt(object["rank"]),
		Heat:                 asString(object["heatText"]),
		FavoriteText:         asString(object["favoriteText"]),
		LikeText:             asString(object["likeText"]),
		StatusTags:           asStringSlice(object["statusTags"]),
		SeasonIndex:          asInt(object["season_index"]),
		MultiSeason:          asBool(object["is_multi_season"]),
		ContentType:          firstNonEmpty(asString(object["content_type"]), asString(object["contentType"])),
		VideoCategoryType:    firstNonEmpty(asString(object["video_category_type"]), asString(object["videoCategoryType"])),
		FollowingUpdate:      asBool(object["followingUpdate"]) || asBool(object["following_update"]),
		Followed:             asBool(object["followed"]) || asBool(object["is_subscribed"]) || asBool(object["has_subscribed"]),
		FollowCount:          firstPositive64(asInt64(object["followCount"]), asInt64(object["follow_count"])),
		ShowUpdateFrequency:  firstNonEmpty(asString(object["show_update_frequency"]), asString(object["showUpdateFrequency"])),
		FollowUpdateTime:     firstPositive64(asInt64(object["follow_update_time_stamp"]), asInt64(object["follow_update_time"])),
		LatestWatchedEpisode: firstPositive(asInt(object["latest_watched_index"]), asInt(object["latest_watched_vid_index"])),
		HasWatchedLatest:     asBool(object["has_watched_latest_episode"]),
		SeriesStatus:         seriesStatus,
	}
	if drama.VidList == nil {
		drama.VidList = asStringSlice(object["episodeVids"])
	}
	if drama.Vid == "" && len(drama.VidList) > 0 {
		drama.Vid = drama.VidList[0]
	}
	if drama.EpisodeCount == 0 {
		drama.EpisodeCount = len(drama.VidList)
	}
	if drama.Score != "" {
		drama.Score = strings.TrimSpace(strings.TrimPrefix(drama.Score, "评分"))
	}
	drama.CoverFallback = browserCoverFallback(drama.Cover)
	if drama.EpisodeCount == 0 {
		if episodeInfo != nil {
			drama.EpisodeCount = firstPositive(asInt(episodeInfo["episode_cnt"]), asInt(episodeInfo["episode_total_cnt"]))
		}
	}
	return drama, true
}

// The app category API serves signed HEIC covers, which Android WebView and
// Chromium cannot display. The same novel-pic object is available as JPEG on
// the website's image CDN. Keep the signed original and expose this verified
// alternative only for HEIC objects; ordinary images retain their URL.
func browserCoverFallback(cover string) string {
	u, err := url.Parse(cover)
	if err != nil || !strings.HasSuffix(strings.ToLower(u.Path), ".heic") {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if !strings.HasSuffix(host, ".fqnovelpic.com") && !strings.HasSuffix(host, ".byteimg.com") {
		return ""
	}
	if !strings.HasPrefix(u.Path, "/novel-pic/") || !strings.Contains(u.Path, "~") {
		return ""
	}
	return "https://p3-novel.byteimg.com" + strings.SplitN(u.Path, "~", 2)[0] + "~tplv-shrink:640:0.image"
}

func asMap(value any) (map[string]any, bool) {
	result, ok := value.(map[string]any)
	return result, ok
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatInt(int64(typed), 10)
	case int:
		return strconv.Itoa(typed)
	default:
		return ""
	}
}

func asInt(value any) int {
	valueString := asString(value)
	result, _ := strconv.Atoi(valueString)
	return result
}

func asInt64(value any) int64 {
	valueString := asString(value)
	result, _ := strconv.ParseInt(valueString, 10, 64)
	return result
}

func asBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return typed == "true" || typed == "1"
	case json.Number:
		return typed.String() == "1"
	default:
		return false
	}
}

func asStringSlice(value any) []string {
	array, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(array))
	for _, entry := range array {
		if object, ok := asMap(entry); ok {
			entry = firstNonEmpty(object["name"], object["title"], object["content"])
		}
		if text := asString(entry); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func firstNonEmpty(values ...any) string {
	for _, value := range values {
		if text := asString(value); text != "" {
			return text
		}
	}
	return ""
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func firstPositive64(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

var seriesIDPattern = regexp.MustCompile(`^[0-9]{1,32}$`)

func validID(value string) bool {
	return seriesIDPattern.MatchString(value)
}
