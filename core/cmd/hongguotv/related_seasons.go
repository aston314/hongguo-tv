package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"time"
)

var relatedSeasonTitleSuffix = regexp.MustCompile(`第([0-9零〇一二两三四五六七八九十百]+)季\s*(?:完结篇|完結篇)?$`)

// Only validate an explicit suffix; an unnumbered title never implies season 1.
func relatedTitleSeason(title string) int {
	match := relatedSeasonTitleSuffix.FindStringSubmatch(title)
	if match == nil {
		return 0
	}
	if n, err := strconv.Atoi(match[1]); err == nil {
		return n
	}
	n, digit := 0, 0
	for _, r := range match[1] {
		switch r {
		case '十', '百':
			unit := 10
			if r == '百' {
				unit = 100
			}
			n += max(digit, 1) * unit
			digit = 0
		default:
			value, ok := map[rune]int{'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}[r]
			if !ok {
				return -1
			}
			digit = value
		}
	}
	return n + digit
}

// Separate from the complete series selector: related works also contain
// different adaptations ("同IP") whose season_index must never authorize autoplay.
func relatedSeasonsQuery(id string) url.Values {
	return url.Values{
		"scene": {"10"}, "from": {"detail_page_more_related"}, "book_id": {id},
		"new_search_middle_page": {"false"}, "bookstore_tab_type": {"0"},
		"query_history_removed": {"false"}, "user_is_login": {"0"}, "bookstore_tab": {"0"},
		"search_middle_page_version": {"0"}, "pad_column_detail": {"0"},
		"hot_word_exchange": {"false"}, "device_level": {"3"}, "limit": {"0"}, "offset": {"0"},
		"is_horizontal_screen": {"false"}, "reader_single_col_from_ip_strategy": {"false"},
		"version_code": {"72232"}, "manifest_version_code": {"72232"},
		"update_version_code": {"72232"}, "pv_player": {"72232"}, "version_name": {"7.2.2.32"},
		"host_abi": {"arm64-v8a"}, "dragon_device_type": {"phone"}, "compliance_status": {"0"},
		"need_personal_recommend": {"1"}, "player_so_load": {"1"}, "is_android_pad_screen": {"0"},
	}
}

func parseRelatedSeasons(p map[string]any, id string) ([]SeriesSeason, error) {
	if asString(p["code"]) != "0" {
		return nil, errors.New("相关作品未确认请求成功")
	}
	blocks, ok := p["data"].([]any)
	if !ok {
		return nil, errors.New("相关作品响应缺少列表")
	}
	items := []SeriesSeason{}
	ids, seasons := map[string]bool{}, map[int]bool{}
	for _, value := range blocks {
		block, ok := asMap(value)
		if !ok {
			return nil, errors.New("相关作品区块无效")
		}
		if asInt(block["show_type"]) != 547 && asString(block["cell_name"]) != "相关作品" {
			continue
		}
		rows, ok := block["video_data"].([]any)
		if !ok {
			return nil, errors.New("相关作品剧集列表无效")
		}
		for _, value := range rows {
			row, ok := asMap(value)
			if !ok {
				return nil, errors.New("相关作品条目无效")
			}
			tag, _ := asMap(row["tag_info"])
			label := asString(tag["text"])
			match := officialSeasonLabel.FindStringSubmatch(label)
			if match == nil {
				continue // Missing, synthesized and 同IP tags are not season evidence.
			}
			season, _ := strconv.Atoi(match[1])
			drama, valid := normalizeDrama(row)
			if !valid || !validID(drama.SeriesID) || drama.SeriesID == "0" ||
				season <= 0 || season > 999 || (asInt(row["content_type"]) != 1004 && asInt(row["content_type"]) != 1007) {
				return nil, errors.New("相关作品季信息无效")
			}
			if drama.SeriesID == id {
				continue
			}
			titleSeason := relatedTitleSeason(drama.Title)
			if drama.SeasonIndex > 0 && drama.SeasonIndex != season || titleSeason != 0 && titleSeason != season || ids[drama.SeriesID] || seasons[season] {
				return nil, errors.New("相关作品季关系存在冲突")
			}
			ids[drama.SeriesID], seasons[season] = true, true
			drama.SeasonIndex, drama.MultiSeason = season, true
			_, subscribed := asMap(row["subscribe_item"])
			drama.Upcoming = asInt(row["content_type"]) == 1007 || subscribed
			item := SeriesSeason{Drama: drama, Label: label}
			item.Playable = !item.Upcoming && !asBool(row["disable_play"]) &&
				item.EpisodeCount > 0 && validID(item.Vid) && item.Vid != "0"
			if item.Upcoming {
				item.Vid = ""
				sub, _ := asMap(row["subscribe_item"])
				if validID(asString(sub["item_id"])) && asString(sub["item_id"]) != "0" {
					item.ReservationID, item.Reserved = item.SeriesID, asBool(sub["is_subscribed"])
				}
			}
			items = append(items, item)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].SeasonIndex < items[j].SeasonIndex })
	return items, nil
}

func (c *passportClient) readRelatedSeasons(ctx context.Context, id string) ([]SeriesSeason, error) {
	hosts := []string{"https://api5-normal-sinfonlinec.fqnovel.com", "https://api5-normal-hl.fqnovel.com", "https://api5-normal-lf.fqnovel.com"}
	// Fixtures and alternate installations must not escape to public upstream.
	if c.base != passportAPI {
		hosts = []string{c.base}
	}
	var failure error
	for _, host := range hosts {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		requestCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		client := *c
		client.base, client.session = host, cloneAccountSession(c.session)
		client.signatureVersion = "7.2.2.32"
		// Do not forward a logged-in account to another host for public metadata.
		client.session.Token, client.session.Cookies = "", map[string]string{}
		p, err := client.cloudJSON(requestCtx, "/reading/bookapi/plan/v:version/", http.MethodGet, relatedSeasonsQuery(id), nil)
		cancel()
		if err == nil {
			var rows []SeriesSeason
			rows, err = parseRelatedSeasons(p, id)
			if err == nil {
				return rows, nil
			}
		}
		failure = err
	}
	return nil, failure
}

func (c *passportClient) relatedSeasons(ctx context.Context, id string) (SeriesSeasonsResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	rows, err := c.readRelatedSeasons(ctx, id)
	if err != nil {
		return SeriesSeasonsResult{}, err
	}
	if len(rows) == 0 {
		return SeriesSeasonsResult{Items: []SeriesSeason{}, Source: "related-no-seasons"}, nil
	}
	// The requested series is omitted from this scene. Recover its number from
	// an explicitly tagged sibling, never from an absent title suffix/default 1.
	back, err := c.readRelatedSeasons(ctx, rows[0].SeriesID)
	if err != nil {
		return SeriesSeasonsResult{}, err
	}
	var current *SeriesSeason
	for i := range back {
		if back[i].SeriesID == id {
			item := back[i]
			current = &item
		}
	}
	if current == nil {
		return SeriesSeasonsResult{}, errors.New("相关作品未双向确认当前季")
	}
	for _, row := range rows {
		if row.SeasonIndex == current.SeasonIndex {
			return SeriesSeasonsResult{}, errors.New("相关作品季关系存在冲突")
		}
		if row.SeasonIndex != current.SeasonIndex+1 || row.SeriesID == rows[0].SeriesID || !row.Playable {
			continue
		}
		reciprocal, err := c.readRelatedSeasons(ctx, row.SeriesID)
		if err != nil {
			return SeriesSeasonsResult{}, err
		}
		confirmed := false
		for _, other := range reciprocal {
			if other.SeriesID == id && other.SeasonIndex == current.SeasonIndex {
				confirmed = true
			}
		}
		if !confirmed {
			return SeriesSeasonsResult{}, errors.New("相关作品未双向确认下一季")
		}
	}
	rows = append(rows, *current)
	sort.Slice(rows, func(i, j int) bool { return rows[i].SeasonIndex < rows[j].SeasonIndex })
	return SeriesSeasonsResult{Items: rows, Source: "related-seasons"}, nil
}
