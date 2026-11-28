package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type SeriesSeason struct {
	Drama
	Label    string `json:"label,omitempty"`
	Subtitle string `json:"subtitle,omitempty"`
	Playable bool   `json:"playable"`
}

type SeriesSeasonsResult struct {
	Items  []SeriesSeason `json:"items"`
	Source string         `json:"source,omitempty"`
}

func seriesSeasonsQuery(id string) url.Values {
	return url.Values{"scene": {"10"}, "from": {"single_col_same_ip_series"}, "offset": {"0"}, "limit": {"0"}, "total_chapter_num": {"0"}, "current_chapter_num": {"0"}, "post_id": {"0"}, "is_horizontal_screen": {"false"}, "bookstore_tab": {"0"}, "bookstore_tab_type": {"0"}, "book_id": {id}, "filter_ids": {id}}
}

var officialSeasonLabel = regexp.MustCompile(`^第([1-9][0-9]*)季$`)

// v1.1.6 uses this plan scene for the complete same-IP selector, including
// subscribe_item entries. A trailer VID must never make those entries playable.
func parseSeriesSeasons(p map[string]any) (SeriesSeasonsResult, error) {
	out := SeriesSeasonsResult{Items: []SeriesSeason{}}
	if asString(p["code"]) != "0" {
		return out, errors.New("官方系列剧未确认请求成功")
	}
	blocks, ok := p["data"].([]any)
	if !ok {
		return out, errors.New("官方系列剧响应缺少列表")
	}
	seen := map[string]bool{}
	for _, value := range blocks {
		block, ok := asMap(value)
		if !ok {
			return out, errors.New("官方系列剧区块无效")
		}
		if block["video_data"] == nil {
			continue
		}
		rows, ok := block["video_data"].([]any)
		if !ok {
			return out, errors.New("官方系列剧条目无效")
		}
		for _, value := range rows {
			x, ok := asMap(value)
			if !ok {
				return out, errors.New("官方系列剧数据无效")
			}
			d, ok := normalizeDrama(x)
			if !ok || !validID(d.SeriesID) || d.SeriesID == "0" || strings.TrimSpace(asString(x["title"])) == "" || seen[d.SeriesID] {
				continue
			}
			seen[d.SeriesID] = true
			item := SeriesSeason{Drama: d}
			for _, label := range categoryTags(x["secondary_info_list"]) {
				if strings.HasPrefix(label, "第") && strings.HasSuffix(label, "季") {
					item.Label = label
					if match := officialSeasonLabel.FindStringSubmatch(label); match != nil {
						item.SeasonIndex, _ = strconv.Atoi(match[1])
					}
					break
				}
			}
			if item.Label == "" && item.SeasonIndex > 0 {
				item.Label = "第" + strconv.Itoa(item.SeasonIndex) + "季"
			}
			subscribe, subscribable := asMap(x["subscribe_item"])
			item.Upcoming = subscribable || !validID(d.Vid) || d.Vid == "0" || d.EpisodeCount <= 0
			item.Playable = !item.Upcoming && !asBool(x["disable_play"])
			if item.Upcoming {
				item.Vid = ""
				if subscribable {
					// subscribe_item.item_id indicates that reservation is open, but
					// the reservation endpoint takes the season's series_id.
					reservationItemID := asString(subscribe["item_id"])
					if validID(reservationItemID) && reservationItemID != "0" && validID(d.SeriesID) && d.SeriesID != "0" {
						item.ReservationID = d.SeriesID
					}
					item.Reserved = asBool(subscribe["is_subscribed"])
				}
			}
			texts := categoryTags(x["sub_title_list"])
			if !item.Upcoming && len(texts) > 1 {
				texts = texts[:1]
			}
			item.Subtitle = strings.Join(texts, " · ")
			item.MultiSeason = true
			out.Items = append(out.Items, item)
		}
	}
	return out, nil
}

func (c *passportClient) SeriesSeasons(ctx context.Context, id string) (SeriesSeasonsResult, error) {
	if !validID(id) || id == "0" {
		return SeriesSeasonsResult{}, errors.New("series_id 无效")
	}
	p, err := c.cloudJSON(ctx, "/reading/bookapi/plan/v", http.MethodGet, seriesSeasonsQuery(id), nil)
	if err == nil {
		var result SeriesSeasonsResult
		result, err = parseSeriesSeasons(p)
		if err == nil && len(result.Items) > 0 {
			return result, nil
		}
	}
	if ctx.Err() != nil {
		return SeriesSeasonsResult{}, ctx.Err()
	}
	return c.relatedSeasons(ctx, id)
}

func (s *server) seriesSeasons(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "method not allowed")
		return
	}
	id := r.URL.Query().Get("series_id")
	if !validID(id) || id == "0" {
		writeError(w, 400, "series_id 无效")
		return
	}
	c, generation, err := s.accounts.listClient(false)
	if err != nil {
		writeError(w, 401, err.Error())
		return
	}
	out, err := c.SeriesSeasons(r.Context(), id)
	if !s.accounts.sameGeneration(generation) {
		writeError(w, 409, errAccountChanged.Error())
		return
	}
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "data": out})
}
