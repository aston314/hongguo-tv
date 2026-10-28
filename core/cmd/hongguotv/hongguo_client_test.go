package main

import (
	"context"
	"encoding/json"
	stdhtml "html"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCategoryNormalizesMacCompatiblePayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reading/distribution/category/landpage/v/" {
			t.Fatalf("unexpected category path: %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["req_scene"] != "default" || body["req_type"] != "only_content" {
			t.Fatalf("unexpected category body: %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"has_more":true,"next_offset":15,"session_id":"s1","video_data":[{"series_id":"7687919221593885758","title":"测试短剧","cover":"https://cover","video_desc":"简介","episode_cnt":77,"accessible_episode_cnt":3,"vid":"7687921187195735102","score":"8.3","play_cnt":51152079,"tags":["爱情"]}]}}`))
	}))
	defer server.Close()

	client := newHongguoClient()
	client.apiBase = server.URL
	client.httpClient.Timeout = 2 * time.Second
	result, err := client.Category(context.Background(), CategoryRequest{Path: "/rank/hot-drama"})
	if err != nil {
		t.Fatalf("Category failed: %v", err)
	}
	if len(result.Items) != 1 || result.Items[0].SeriesID != "7687919221593885758" {
		t.Fatalf("unexpected category result: %#v", result)
	}
	if result.Items[0].EpisodeCount != 77 || result.Items[0].AccessibleEpisodeCnt != 3 {
		t.Fatalf("episode metadata was lost: %#v", result.Items[0])
	}
}

func TestCategoryFiltersSelectorsAndPagination(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		selected, _ := asMap(body["select_items"])
		if len(asStringSlice(selected["genre"])) != 0 || strings.Join(asStringSlice(selected["category_dim_theme"]), ",") != "cate_165" || strings.Join(asStringSlice(selected["gender"]), ",") != "0" {
			t.Errorf("explicit all / theme / female selection was lost: %#v", selected)
		}
		if asInt(body["offset"]) != 15 || body["session_id"] != "session-1" || body["filter_ids"] != "7690163276214176792,7546488656639314968" {
			t.Errorf("pagination context was lost: %#v", body)
		}
		if body["req_type"] != "default" || !asBool(body["need_selector_panel"]) {
			t.Errorf("selector panel request needs default: %#v", body)
		}
		_, _ = w.Write([]byte(`{"code":0,"data":{"has_more":true,"next_offset":30,"session_id":"session-2","video_data":[],"selector_rows":[{"type":"category_dim_theme","row_name":"全部主题","items":[{"selector_item_id":"cate_165","show_name":"悬疑"},{"selector_item_id":"cate_165","show_name":"重复"},{"selector_item_id":"not-a-tag","show_name":"坏值"}]},{"type":"creation_status","items":[{"selector_item_id":"creation_status_0","show_name":"已完结"}]},{"type":"unknown","items":[{"selector_item_id":"fake","show_name":"未知"}]}]}}`))
	}))
	defer upstream.Close()
	client := newHongguoClient()
	client.apiBase = upstream.URL
	result, err := client.Category(context.Background(), CategoryRequest{
		Path: "/category/real-drama", Offset: 15, SessionID: "session-1",
		Shown: []string{"7690163276214176792", "7546488656639314968"}, Selectors: true,
		Filters: map[string]string{"genre": "", "category_dim_theme": "cate_165", "gender": "0"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.NextOffset != 30 || !result.HasMore || result.SessionID != "session-2" {
		t.Fatalf("incorrect cursor: %#v", result)
	}
	if len(result.Filters) != 2 || result.Filters[0].Label != "主题" || len(result.Filters[0].Options) != 1 || result.Filters[1].Type != "creation_status" || len(result.Filters[1].Options) != 2 {
		t.Fatalf("incorrect selector normalization: %#v", result.Filters)
	}
}

func TestCategoryUsesPassportSignature(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Medusa") == "" || r.Header.Get("X-Gorgon") == "" || r.Header.Get("X-Khronos") == "" {
			t.Fatalf("category request was not signed: headers=%v", r.Header)
		}
		if r.URL.Query().Get("device_id") == "" || r.URL.Query().Get("iid") == "" {
			t.Fatalf("category request is missing one-shot device identity: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"has_more":false,"video_data":[]}}`))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.apiBase = server.URL
	client.httpClient.Timeout = 2 * time.Second
	if _, err := client.Category(context.Background(), CategoryRequest{Path: "/category/real-drama"}); err != nil {
		t.Fatalf("signed category request failed: %v", err)
	}
}

func TestCategoryRetriesEmptySignedResponseWithFreshIdentity(t *testing.T) {
	attempts := 0
	identities := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		identities[r.URL.Query().Get("device_id")] = true
		if attempts < 3 {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"has_more":false,"video_data":[]}}`))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.apiBase = server.URL
	client.httpClient.Timeout = 2 * time.Second
	if _, err := client.Category(context.Background(), CategoryRequest{Path: "/category/real-drama"}); err != nil {
		t.Fatalf("empty response retry failed: %v", err)
	}
	if attempts != 3 || len(identities) != 3 {
		t.Fatalf("attempts=%d unique identities=%d, want three of each", attempts, len(identities))
	}
}

func TestCategoryAlwaysExposesMacStatusFilter(t *testing.T) {
	filters := normalizeCategoryFilters(nil)
	if len(filters) != 1 || filters[0].Type != "creation_status" || filters[0].Label != "状态" {
		t.Fatalf("missing status filter: %#v", filters)
	}
	if len(filters[0].Options) != 2 || filters[0].Options[0] != (CategoryFilterOption{ID: "creation_status_0", Label: "已完结"}) || filters[0].Options[1] != (CategoryFilterOption{ID: "creation_status_1", Label: "连载中"}) {
		t.Fatalf("unexpected status options: %#v", filters[0].Options)
	}

	filters = normalizeCategoryFilters([]any{map[string]any{
		"type":  "creation_status",
		"items": []any{map[string]any{"selector_item_id": "creation_status_0", "show_name": "已完结"}},
	}})
	if len(filters) != 1 || len(filters[0].Options) != 2 || filters[0].Options[1].ID != "creation_status_1" {
		t.Fatalf("partial upstream status options were not completed: %#v", filters)
	}
}

func TestCategoryStatusSelectionUsesMacFilterIDs(t *testing.T) {
	var selected []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode category body: %v", err)
		}
		items, _ := asMap(body["select_items"])
		selected = asStringSlice(items["creation_status"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"video_data":[],"has_more":false}}`))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.apiBase = server.URL

	cases := []struct {
		name     string
		value    string
		expected []string
	}{
		{name: "all", value: "", expected: []string{}},
		{name: "ended", value: "creation_status_0", expected: []string{"creation_status_0"}},
		{name: "ongoing", value: "creation_status_1", expected: []string{"creation_status_1"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := client.Category(context.Background(), CategoryRequest{Path: "/category/real-drama", Filters: map[string]string{"creation_status": test.value}}); err != nil {
				t.Fatal(err)
			}
			if strings.Join(selected, ",") != strings.Join(test.expected, ",") {
				t.Fatalf("creation_status selection = %#v, want %#v", selected, test.expected)
			}
		})
	}
}

func TestInvalidCategoryFilterDoesNotReachUpstream(t *testing.T) {
	for _, filters := range []map[string]string{
		{"gender": "2"}, {"sort": "fake"}, {"category_dim_theme": "cate_165,cate_36"},
		{"online_time": "days_1"}, {"creation_status": "fake"}, {"unknown": "x"},
	} {
		if _, err := categorySelection(CategoryRequest{Filters: filters}); err == nil {
			t.Errorf("accepted invalid filters: %#v", filters)
		}
	}
	s := &server{hongguo: newHongguoClient()}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/category?gender=bad", nil)
	response := httptest.NewRecorder()
	s.category(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid filter status = %d", response.Code)
	}
}

func TestSeriesDetailCreatesLockedEpisodes(t *testing.T) {
	html := `<!doctype html><script>window._ROUTER_DATA = {"loaderData":{"detail_page":{"seriesDetail":{"series_id":"1234567890123456789","series_name":"分季测试","series_cover":"https://cover","series_intro":"简介","episode_cnt":5,"accessible_episode_cnt":3,"series_episode_info":{"series_status":0},"vid_list":["11","22","33","44","55"],"tags":["爱情"]}}}};</script>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/detail") {
			t.Fatalf("unexpected detail path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(html))
	}))
	defer server.Close()

	client := newHongguoClient()
	client.webBase = server.URL
	client.httpClient.Timeout = 2 * time.Second
	result, err := client.SeriesDetail(context.Background(), "1234567890123456789")
	if err != nil {
		t.Fatalf("SeriesDetail failed: %v", err)
	}
	if len(result.Episodes) != 5 || !result.Episodes[3].Locked || !result.Episodes[3].LockedInferred || result.Episodes[2].Locked || result.Episodes[2].LockedInferred || result.SeriesStatus != "0" {
		t.Fatalf("locked episode state was wrong: %#v", result.Episodes)
	}
}

func TestSeriesDetailParsesActorsFromDetailData(t *testing.T) {
	html := `<!doctype html><script>window._ROUTER_DATA = {"loaderData":{"detail_page":{"seriesDetail":{"series_id":"1234567890123456789","series_name":"演员测试","episode_cnt":1,"vid_list":["9988776655443322110"],"celebrities":[{"celebrity_id":"7377326001203713305","nickname":"测试演员","avatar":"https://avatar"},{"celebrity_id":"7377326001203713305","nickname":"重复演员"},{"nickname":"无编号演员"}]}}}};</script>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(html))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.webBase = server.URL
	client.httpClient.Timeout = 2 * time.Second
	result, err := client.SeriesDetail(context.Background(), "1234567890123456789")
	if err != nil {
		t.Fatalf("SeriesDetail failed: %v", err)
	}
	if len(result.Actors) != 2 || result.Actors[0].ID != "7377326001203713305" || result.Actors[0].Name != "测试演员" || result.Actors[0].Avatar != "https://avatar" || result.Actors[1].Name != "无编号演员" {
		t.Fatalf("unexpected actors: %#v", result.Actors)
	}
}

func TestActorWorksParsesNestedVideoList(t *testing.T) {
	html := `<!doctype html><script>window._ROUTER_DATA = {"loaderData":{"character_layout":{"videoList":[]},"character_(id)/page":{"userInfo":{"actor_id":"7377326001203713305","user_name":"测试演员","user_avatar":"https://avatar","description":"演员简介"},"videoList":[{"series_id":"1234567890123456789","series_title":"第一部","series_cover":"https://cover-1","series_intro":"简介1","episode_cnt":12,"vid_list":["1111111111111111111"]},{"series_id":"2234567890123456789","series_title":"第二部","series_cover":"https://cover-2","series_intro":"简介2","episode_cnt":8,"vid_list":["2222222222222222222"]}]}}};</script>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/character/7377326001203713305" {
			t.Fatalf("unexpected actor path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(html))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.webBase = server.URL
	result, err := client.ActorWorks(context.Background(), "7377326001203713305")
	if err != nil {
		t.Fatalf("ActorWorks failed: %v", err)
	}
	if result.Actor.ID != "7377326001203713305" || result.Actor.Name != "测试演员" || len(result.Items) != 2 {
		t.Fatalf("unexpected actor result: %#v", result)
	}
	if result.Items[0].SeriesID != "1234567890123456789" || result.Items[0].Title != "第一部" || result.Items[1].VidList[0] != "2222222222222222222" {
		t.Fatalf("nested works were not normalized: %#v", result.Items)
	}
}

func TestActorWorksRejectsMismatchedActor(t *testing.T) {
	html := `<!doctype html><script>window._ROUTER_DATA = {"loaderData":{"character_(id)/page":{"userInfo":{"actor_id":"9999999999999999999"},"videoList":[]}}};</script>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(html)) }))
	defer server.Close()
	client := newHongguoClient()
	client.webBase = server.URL
	if _, err := client.ActorWorks(context.Background(), "7377326001203713305"); err == nil || !strings.Contains(err.Error(), "不一致") {
		t.Fatalf("mismatched actor should fail, got %v", err)
	}
}

func TestNormalizeDramaReadsTopLevelAndNestedSeriesStatus(t *testing.T) {
	ongoing, ok := normalizeDrama(map[string]any{
		"series_id": "1234567890123456789", "series_title": "连载剧", "series_status": json.Number("0"),
	})
	if !ok || ongoing.SeriesStatus != "0" {
		t.Fatalf("top-level series status was lost: %#v", ongoing)
	}
	ended, ok := normalizeDrama(map[string]any{
		"series_id": "2234567890123456789", "series_title": "完结剧",
		"series_episode_info": map[string]any{"series_status": json.Number("1")},
	})
	if !ok || ended.SeriesStatus != "1" {
		t.Fatalf("nested series status was lost: %#v", ended)
	}
}

func TestSeriesDetailParsesReviewsAndRelated(t *testing.T) {
	html := `<!doctype html><script>window._ROUTER_DATA = {"loaderData":{"detail_page":{"seriesDetail":{"series_id":"1234567890123456789","series_name":"社交测试","episode_cnt":1,"vid_list":["9988776655443322110"]},"seriesSocialInfo":{"reviews":[{"review_id":"r1","user_name":"观众","content":"很好看","rating":9,"digg_count":3}]},"related":[],"related_list":[{"series_id":"2234567890123456789","series_name":"相关推荐剧","series_cover":"https://related-cover","episode_cnt":4}]}}};</script>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(html))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.webBase = server.URL
	client.httpClient.Timeout = 2 * time.Second
	result, err := client.SeriesDetail(context.Background(), "1234567890123456789")
	if err != nil || len(result.Reviews) != 1 || result.Reviews[0].Content != "很好看" || len(result.Related) != 1 || result.Related[0].SeriesID != "2234567890123456789" {
		t.Fatalf("unexpected social detail: %#v err=%v", result, err)
	}
}

func TestSeriesDetailParsesDeferredRecommendations(t *testing.T) {
	recommendations, err := json.Marshal(map[string]any{"videoList": []any{map[string]any{
		"series_id": "2234567890123456789", "series_name": "延迟相关推荐", "series_cover": "https://cover", "episode_cnt": 12,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	fnArgs, err := json.Marshal([]any{"detail_page", []any{map[string]any{
		"key": "recommendations", "routerDataFnName": "p", "routerDataFnArgs": []string{string(recommendations)},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	page := `<!doctype html><script>_ROUTER_DATA={"loaderData":{"detail_page":{"seriesDetail":{"series_id":"1234567890123456789","series_name":"社交测试","episode_cnt":1,"vid_list":["9988776655443322110"]},"seriesSocialInfo":{"reviews":[]},"recommendations":{}}}};</script><script data-fn-name="mergeLoaderData" data-fn-args="` + stdhtml.EscapeString(string(fnArgs)) + `"></script>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(page))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.webBase = server.URL
	result, err := client.SeriesDetail(context.Background(), "1234567890123456789")
	if err != nil || len(result.Related) != 1 || result.Related[0].SeriesID != "2234567890123456789" || result.Related[0].Title != "延迟相关推荐" {
		t.Fatalf("deferred recommendations were not normalized: %#v err=%v", result.Related, err)
	}
}

func TestNewDramaRequestsOnlineTimeSort(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode category body: %v", err)
		}
		selectItems, _ := asMap(body["select_items"])
		if sort := asStringSlice(selectItems["sort"]); len(sort) != 1 || sort[0] != "online_time" {
			t.Errorf("new drama was not sorted by online time: %#v", selectItems)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"video_data":[],"has_more":false}}`))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.apiBase = server.URL
	if _, err := client.Category(context.Background(), CategoryRequest{Path: "/new/recommend"}); err != nil {
		t.Fatalf("new drama category failed: %v", err)
	}
}

func TestSearchNormalizesSearchList(t *testing.T) {
	body := `{"pageNum":1,"totalPages":1,"hasMore":false,"searchList":[{"name":"测试一","keyword":"1234567890123456789","video_data":{"series_id":"1234567890123456789","series_title":"测试一","series_cover":"https://cover/1","episode_cnt":12}},{"name":"测试二","keyword":"2234567890123456789","video_data":{"series_id":"2234567890123456789","series_title":"测试二","series_cover":"https://cover/2","episode_cnt":8}}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/search/result" || r.URL.Query().Get("query") != "测试" {
			t.Fatalf("unexpected search path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()

	client := newHongguoClient()
	client.webBase = server.URL
	client.httpClient.Timeout = 2 * time.Second
	result, err := client.Search(context.Background(), "测试")
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(result.Items) != 2 || result.Items[0].SeriesID != "1234567890123456789" || result.Items[1].EpisodeCount != 8 {
		t.Fatalf("unexpected search result: %#v", result.Items)
	}
}

func TestSearchSuggestionsNormalizesDramaActorAndKeyword(t *testing.T) {
	body := `{"suggest_list":[` +
		`{"word_type":"short_play_name","keyword":"1234567890123456789","name":"剧名建议","video_data":{"series_id":"1234567890123456789","series_title":"剧名建议","series_cover":"https://cover","episode_cnt":42,"category_list":[{"name":"剧情"}],"hot_score_data":{"text":"123万热度"}}},` +
		`{"word_type":"short_play_name","keyword":"1234567890123456790","name":"极品四公子第五季","video_data":{"series_id":"1234567890123456790","episode_cnt":42}},` +
		`{"word_type":"short_play_actor","keyword":"9876543210987654321","name":"演员建议","video_data":{}},` +
		`{"word_type":"common_query","keyword":"hot-key","display_words":["热门词"]}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/incent_resource/suggestion" || r.URL.Query().Get("app_id") != "8662" || r.URL.Query().Get("count") != "10" || r.URL.Query().Get("query") != "测试" {
			t.Fatalf("unexpected suggestion request: %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	client := newHongguoClient()
	client.webBase = server.URL
	result, err := client.SearchSuggestions(context.Background(), " 测试 ")
	if err != nil {
		t.Fatalf("SearchSuggestions failed: %v", err)
	}
	if len(result.Items) != 4 {
		t.Fatalf("unexpected suggestions: %#v", result.Items)
	}
	if result.Items[0].Drama == nil || result.Items[0].Drama.SeriesID != "1234567890123456789" || !strings.Contains(result.Items[0].Meta, "全42集") {
		t.Fatalf("drama suggestion was not normalized: %#v", result.Items[0])
	}
	if result.Items[2].ActorID != "9876543210987654321" || result.Items[2].Kind != "short_play_actor" {
		t.Fatalf("actor ID was not kept as a string: %#v", result.Items[2])
	}
	if result.Items[1].Drama == nil || result.Items[1].Drama.Title != "极品四公子第五季" {
		t.Fatalf("drama title did not fall back to suggestion name: %#v", result.Items[1])
	}
	if result.Items[3].Name != "热门词" || result.Items[3].Kind != "common_query" {
		t.Fatalf("display_words fallback was not normalized: %#v", result.Items[3])
	}
}

func TestRankNormalizesCrawlerPayload(t *testing.T) {
	html := `<!doctype html><script>_ROUTER_DATA = {"loaderData":{"rank_hot-drama/page":{"content":{"isSuccess":true,"rankList":[{"seriesId":"1234567890123456789","title":"榜单短剧","cover":"https://cover","rank":1,"heatText":"995万热度","scoreText":"评分9.3","description":"简介","tags":["玄幻"],"episodeVids":["9988776655443322110"]}],"pagination":{"pageNum":1,"totalPages":2}}}}};</script>`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rank/hot-drama" || r.Header.Get("User-Agent") != "Googlebot" {
			t.Fatalf("unexpected rank request: %s ua=%s", r.URL.Path, r.Header.Get("User-Agent"))
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(html))
	}))
	defer server.Close()

	client := newHongguoClient()
	client.webBase = server.URL
	client.httpClient.Timeout = 2 * time.Second
	result, err := client.Rank(context.Background(), RankRequest{Path: "/rank/hot-drama"})
	if err != nil {
		t.Fatalf("Rank failed: %v", err)
	}
	if len(result.Items) != 1 || result.Items[0].Rank != 1 || result.Items[0].Score != "9.3" || result.Items[0].Vid != "9988776655443322110" || !result.HasMore {
		t.Fatalf("unexpected rank result: %#v", result)
	}
}

func TestCoverFallbackPreservesSignedOriginal(t *testing.T) {
	original := "https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-superreso:400:0.heic?x-signature=secret"
	drama, ok := normalizeDrama(map[string]any{"series_id": "123", "cover": original})
	if !ok || drama.Cover != original || drama.CoverFallback != "https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image" {
		t.Fatalf("unexpected HEIC cover: %#v", drama)
	}
	for _, ordinary := range []string{"https://p3-reading-sign.fqnovelpic.com/novel-pic/a.jpg?x-signature=keep", "https://example.com/a~b.heic"} {
		if browserCoverFallback(ordinary) != "" {
			t.Fatalf("unexpected fallback for %s", ordinary)
		}
	}
}

func TestPlayInfoUsesEmbeddedPlaybackOnly(t *testing.T) {
	client := newHongguoClient()
	client.internalPlayback = func(_ context.Context, seriesID, vid, quality string, fallback bool) (PlayInfo, error) {
		if seriesID != "123" || vid != "456" {
			t.Fatalf("unexpected embedded playback arguments: %s/%s", seriesID, vid)
		}
		return PlayInfo{Path: "/minireel-proxy/media/token.mp4", Quality: "720P"}, nil
	}
	result, err := client.PlayInfo(context.Background(), "123", "456")
	if err != nil {
		t.Fatalf("PlayInfo failed: %v", err)
	}
	if result.Path != "/minireel-proxy/media/token.mp4" || result.Quality != "720P" || result.Vid != "456" {
		t.Fatalf("unexpected playback result: %#v", result)
	}
}
