package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

var errCloudMetadataIdentity = errors.New("云端详情身份不一致")

type cloudMutation struct {
	Sequence uint64       `json:"sequence"`
	Kind     string       `json:"kind"`
	SeriesID string       `json:"series_id"`
	Value    bool         `json:"value,omitempty"`
	Entry    LibraryEntry `json:"entry"`
}
type cloudLibraryState struct {
	Sequence     uint64           `json:"sequence"`
	Pending      []cloudMutation  `json:"pending,omitempty"`
	Hidden       map[string]int64 `json:"hidden,omitempty"`
	LastSync     int64            `json:"last_sync,omitempty"`
	GuestHistory map[string]int64 `json:"guest_history,omitempty"`
}
type syncStatus struct {
	State    string `json:"state"`
	Pending  int    `json:"pending"`
	LastSync int64  `json:"last_sync,omitempty"`
	Error    string `json:"error,omitempty"`
}

func recordCloudChange(data *LibraryData, c LibraryChange, before LibraryData) error {
	if data.Cloud == nil {
		data.Cloud = &cloudLibraryState{}
	}
	cloud := data.Cloud
	if cloud.Hidden == nil {
		cloud.Hidden = map[string]int64{}
	}
	kind := c.Action
	id := c.Drama.SeriesID
	if kind == "like" {
		delete(cloud.Hidden, "likes:"+id)
		return nil // Confirmed synchronous write, never enqueue legacy likes.
	}
	if c.Action == "clear" || c.Action == "remove" {
		for _, e := range before.Entries {
			if c.Action == "clear" || e.Drama.SeriesID == c.SeriesID {
				cloud.Hidden[c.Kind+":"+e.Drama.SeriesID] = time.Now().UnixMilli()
			}
		}
		trimCloudHidden(cloud)
		if c.Action == "clear" || c.Kind != "favorites" {
			return nil
		}
		kind = "favorite"
		id = c.SeriesID
	}
	if kind != "progress" && kind != "favorite" {
		return nil
	}
	var entry LibraryEntry
	for _, e := range data.Entries {
		if e.Drama.SeriesID == id {
			entry = e
			break
		}
	}
	if entry.Drama.SeriesID == "" {
		for _, e := range before.Entries {
			if e.Drama.SeriesID == id {
				entry = e
				break
			}
		}
	}
	value := kind == "favorite" && c.Action != "remove" && c.Value != nil && *c.Value
	if kind == "progress" {
		delete(cloud.Hidden, "history:"+id)
	} else if c.Action != "remove" {
		delete(cloud.Hidden, "favorites:"+id)
	}
	cloud.Sequence++
	op := cloudMutation{Sequence: cloud.Sequence, Kind: kind, SeriesID: id, Value: value, Entry: entry}
	for i, p := range cloud.Pending {
		if p.Kind == kind && p.SeriesID == id {
			cloud.Pending[i] = op
			return nil
		}
	}
	if len(cloud.Pending) >= 2000 {
		return errors.New("待同步记录过多，请先恢复网络并同步")
	}
	cloud.Pending = append(cloud.Pending, op)
	return nil
}

// Bound local-only exclusions, including records removed over many sessions.
func trimCloudHidden(cloud *cloudLibraryState) {
	for len(cloud.Hidden) > 2000 {
		var oldest string
		var stamp int64
		for key, value := range cloud.Hidden {
			if oldest == "" || value < stamp {
				oldest, stamp = key, value
			}
		}
		delete(cloud.Hidden, oldest)
	}
}
func storeCloudLastSync(s *libraryStore) int64 {
	d := s.snapshot()
	if d.Cloud != nil {
		return d.Cloud.LastSync
	}
	return 0
}
func (m *accountManager) syncStatusLocked() syncStatus {
	s := syncStatus{State: "idle", LastSync: m.lastSync, Error: m.syncError}
	d := m.store.snapshot()
	if d.Cloud != nil {
		s.Pending = len(d.Cloud.Pending)
	}
	if m.syncing {
		s.State = "syncing"
	} else if m.syncError != "" {
		s.State = "error"
	} else if s.Pending > 0 {
		s.State = "pending"
	}
	return s
}

func (m *accountManager) run(ctx context.Context) {
	ticker := time.NewTicker(90 * time.Second)
	defer ticker.Stop()
	if m.status().LoggedIn {
		m.signalSync()
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-m.wake:
		}
		// Coalesce playback saves without delaying the TV UI.
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		m.synchronize(ctx)
	}
}
func (m *accountManager) synchronize(parent context.Context) {
	m.mu.Lock()
	if m.disk.Profile == nil || m.syncing {
		m.mu.Unlock()
		return
	}
	g, store, uid := m.generation, m.store, m.disk.Profile.UID
	likeRevision := m.likeRevision
	client := m.newClient(m.disk.Session)
	client.uid = uid
	m.syncing = true
	ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
	m.cancelSync = cancel
	m.mu.Unlock()
	defer cancel()
	// Pull first: stale offline progress must not overwrite another device's
	// newer watch position. Merge reconciles only matching progress mutations.
	var err error
	if !validID(uid) || uid == "0" || store.snapshot().OwnerID != uid {
		err = errors.New("账号记录身份不匹配，请重新登录")
	} else if !hasAccountCredentials(client.session) {
		err = errors.New("账号会话凭证缺失，请重新登录")
	}
	var remote []LibraryEntry
	if err == nil {
		remote, err = client.pullLibrary(ctx, uid, store.snapshot(), m.details)
	}
	if err == nil {
		m.mu.Lock()
		if g != m.generation || m.store != store {
			m.mu.Unlock()
			return
		}
		err = store.mergeCloud(remote, 0)
		m.mu.Unlock()
	}
	if err == nil {
		err = m.flushCloud(ctx, g, store, client)
	}
	if err == nil {
		likes, likesErr := client.pullLikes(ctx)
		m.mu.Lock()
		if g != m.generation || m.store != store {
			m.mu.Unlock()
			return
		}
		if likesErr == nil && likeRevision == m.likeRevision {
			likesErr = store.mergeLikes(likes)
		}
		m.mu.Unlock()
		if likesErr != nil {
			err = errors.New("云端点赞读取失败：" + likesErr.Error())
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if g != m.generation || m.disk.Profile == nil {
		return
	}
	m.syncing = false
	m.cancelSync = nil
	if err == nil {
		disk := m.disk
		disk.Session = client.session
		err = m.saveDisk(disk)
		if err == nil {
			m.disk = disk
			err = store.markCloudSynced(time.Now().UnixMilli())
			if err == nil {
				m.lastSync = storeCloudLastSync(store)
			}
		}
	}
	if err != nil {
		m.syncError = err.Error()
	} else {
		m.syncError = ""
	}
}

func (s *libraryStore) markCloudSynced(stamp int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := cloneLibrary(s.data)
	if d.Cloud == nil {
		d.Cloud = &cloudLibraryState{}
	}
	d.Cloud.LastSync = stamp
	return s.persistLocked(d)
}
func (m *accountManager) flushCloud(ctx context.Context, g uint64, store *libraryStore, c *passportClient) error {
	for i := 0; i < 2000; i++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		m.mu.Lock()
		if g != m.generation || m.store != store {
			m.mu.Unlock()
			return context.Canceled
		}
		data := store.snapshot()
		m.mu.Unlock()
		if data.Cloud == nil || len(data.Cloud.Pending) == 0 {
			return nil
		}
		op := data.Cloud.Pending[0]
		if err := c.uploadMutation(ctx, op); err != nil {
			return err
		}
		m.mu.Lock()
		if g != m.generation || m.store != store {
			m.mu.Unlock()
			return context.Canceled
		}
		err := store.ackCloud(op.Sequence)
		m.mu.Unlock()
		if err != nil {
			return err
		}
	}
	return errors.New("待同步记录较多，将在下一轮继续")
}
func (s *libraryStore) ackCloud(seq uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := cloneLibrary(s.data)
	if data.Cloud == nil {
		return nil
	}
	kept := data.Cloud.Pending[:0]
	for _, p := range data.Cloud.Pending {
		if p.Sequence != seq {
			kept = append(kept, p)
		}
	}
	data.Cloud.Pending = kept
	return s.persistLocked(data)
}

func (c *passportClient) uploadMutation(ctx context.Context, p cloudMutation) error {
	if !validID(p.SeriesID) {
		return errors.New("云同步记录身份无效")
	}
	e := p.Entry
	if p.Kind == "favorite" {
		op := 0
		if !p.Value {
			op = 1
		}
		_, err := c.cloudJSON(ctx, "/reading/bookapi/bookshelf/video/update/v", http.MethodPost, nil, map[string]any{"is_cancelled": false, "shark_extra": map[string]any{"enter_from": "0", "previous_page": "0", "page_list": "0", "is_active_behavior": "1", "inactive_type": "0"}, "update_bookshelf_video_list": []any{map[string]any{"book_id": p.SeriesID, "book_type": 2, "modify_time": time.Now().UnixMilli(), "video_shelf_operate_type": op}}})
		return err
	}
	if p.Kind != "progress" || e.Episode < 1 || !validID(e.VideoID) {
		return errors.New("云端播放进度无效")
	}
	stamp := e.LastPlayedAt
	multi := 0
	if e.Drama.MultiSeason {
		multi = 1
	}
	row := map[string]any{"book_id": cloudNumericID(p.SeriesID), "book_type": 2, "vid": cloudNumericID(e.VideoID), "vid_index": e.Episode, "chapter_index": 0, "current_play_position": cloudMillis(e.Position), "player_accumulate_total_time": cloudMillis(e.Position), "read_timestamp_ms": stamp, "update_timestamp_ms": stamp, "is_delete": false, "is_interactive_game": false, "is_listen_mode": false, "is_multi_season": multi, "season_index": e.Drama.SeasonIndex, "duration": cloudMillis(e.Duration), "episode_cnt": e.Drama.EpisodeCount, "digged_count": 0, "user_digg": false, "origin_novel_book_id": 0, "recent_reads": 0, "retain_video_play_time": 0, "series_play_cnt": 0, "tone_id": 0, "use_soft_delete": false, "meet_guide_comment_tag": false, "user_playlet_comment_flag": false}
	if _, err := c.cloudJSON(ctx, "/reading/bookapi/read_history/update/v", http.MethodPost, nil, map[string]any{"update_datas": []any{row}}); err != nil {
		return errors.New("云端观看历史上报失败：" + err.Error())
	}
	progress := map[string]any{"book_id": p.SeriesID, "book_type": 2, "item_id": e.VideoID, "vid_index": e.Episode, "current_play_time": cloudMillis(e.Position), "player_cumulative_total_duration": cloudMillis(e.Position), "read_timestamp_ms": stamp, "progress_type": 0, "channel_id": 0, "cur_channel_id": 0, "check_timestamp": false, "is_listen_mode": false, "is_local_book": false, "listen_and_read": false, "page_index": 0, "page_progress_rate": 0, "paragraph_offset": 0, "tone_id": 0}
	_, err := c.cloudJSON(ctx, "/reading/bookapi/read_progress/upload/v", http.MethodPost, nil, map[string]any{"books": []any{progress}})
	if err != nil {
		return errors.New("云端观看进度上报失败：" + err.Error())
	}
	return err
}

func (c *passportClient) pullLibrary(ctx context.Context, uid string, local LibraryData, _ *hongguoClient) ([]LibraryEntry, error) {
	entries := map[string]LibraryEntry{}
	for _, e := range local.Entries {
		entries[e.Drama.SeriesID] = e
	}
	remote := map[string]LibraryEntry{}
	offset := 0
	seenPages := map[[32]byte]bool{}
	for page := 0; page < 200; page++ {
		// The official client requests limit=0; this API returns batches of up
		// to 500 regardless of smaller limits. Real accounts can exceed 5 pages.
		q := url.Values{"limit": {"0"}, "offset": {strconv.Itoa(offset)}, "book_type": {"2"}, "full_field": {"false"}, "query_soft_deleted": {"false"}, "last_min_read_timestamp_ms": {"0"}, "is_first_load": {strconv.FormatBool(offset == 0)}}
		p, err := c.cloudJSON(ctx, "/reading/bookapi/read_history/list/v", http.MethodGet, q, nil)
		if err != nil {
			return nil, err
		}
		d := passportData(p)
		rows, ok := d["data_list"].([]any)
		if !ok {
			return nil, errors.New("云端历史响应缺少列表")
		}
		if len(rows) > 0 {
			encoded, _ := json.Marshal(rows)
			fingerprint := sha256.Sum256(encoded)
			if seenPages[fingerprint] {
				return nil, errors.New("云端历史返回重复分页，请重试")
			}
			seenPages[fingerprint] = true
		}
		for _, value := range rows {
			r, ok := asMap(value)
			if !ok {
				return nil, errors.New("云端历史条目无效")
			}
			id := asString(r["book_id_str"])
			if !validID(id) {
				return nil, errors.New("云端历史条目身份无效")
			}
			if asBool(r["is_delete"]) {
				continue
			}
			e := LibraryEntry{Drama: Drama{SeriesID: id, Title: asString(r["book_name"]), Cover: asString(r["thumb_url"]), EpisodeCount: asInt(r["episode_cnt"]), SeasonIndex: asInt(r["season_index"]), MultiSeason: asBool(r["is_multi_season"])}, VideoID: asString(r["vid"]), Episode: asInt(r["vid_index"]), Position: accountSeconds(r["current_play_position"]) / 1000, Duration: accountSeconds(r["duration"]) / 1000, LastPlayedAt: accountEpoch(r["read_timestamp_ms"])}
			if e.Episode < 1 || e.Episode > 10000 || e.Position < 0 || e.Position > 86400 || e.LastPlayedAt <= 0 {
				continue
			}
			if old, ok := entries[id]; ok {
				seasonIndex, multiSeason := e.Drama.SeasonIndex, e.Drama.MultiSeason
				if e.Drama.Title == "" {
					e.Drama = old.Drama
				}
				if seasonIndex > 0 {
					e.Drama.SeasonIndex = seasonIndex
				} else if e.Drama.SeasonIndex <= 0 {
					e.Drama.SeasonIndex = old.Drama.SeasonIndex
				}
				e.Drama.MultiSeason = multiSeason || old.Drama.MultiSeason
				if e.Duration == 0 && old.Episode == e.Episode {
					e.Duration = old.Duration
				}
			}
			if old, ok := remote[id]; !ok || e.LastPlayedAt > old.LastPlayedAt {
				remote[id] = e
			}
		}
		if !asBool(d["has_more"]) {
			break
		}
		next := asInt(d["next_offset"])
		if len(rows) == 0 || page == 199 {
			return nil, errors.New("云端历史分页未完整读取")
		}
		if next <= offset {
			next = offset + 500 // Same fallback stride as the official History client.
		}
		offset = next
	}
	p, err := c.cloudJSON(ctx, "/reading/bookapi/bookshelf/video/list/v", http.MethodGet, urlValues("target_user_id", uid), nil)
	if err != nil {
		return nil, err
	}
	rows, ok := passportData(p)["video_shelf_info"].([]any)
	if !ok {
		return nil, errors.New("云端收藏响应缺少列表")
	}
	missing := []string{}
	for i, value := range rows {
		r, ok := asMap(value)
		if !ok {
			return nil, errors.New("云端收藏条目无效")
		}
		id := asString(r["series_id"])
		if !validID(id) {
			return nil, errors.New("云端收藏条目身份无效")
		}
		e := remote[id]
		if e.Drama.SeriesID == "" {
			e = entries[id]
		} else if e.Drama.Title == "" && entries[id].Drama.Title != "" {
			e.Drama = entries[id].Drama
		}
		if e.Drama.SeriesID == "" || e.Drama.Title == "" || e.Drama.MetadataPending {
			e.Drama.SeriesID = id
			missing = append(missing, id)
		}
		e.FavoriteAt = accountEpoch(r["collect_time"])
		if e.FavoriteAt > 0 && e.FavoriteAt < 100000000000 {
			e.FavoriteAt *= 1000
		}
		if e.FavoriteAt <= 0 {
			e.FavoriteAt = time.Now().UnixMilli() - int64(i)
		}
		remote[id] = e
	}
	missingIDs := map[string]bool{}
	for _, id := range missing {
		missingIDs[id] = true
	}
	for id, e := range remote {
		if e.Drama.Title == "" && !missingIDs[id] {
			missing = append(missing, id)
		}
	}
	// Card metadata is separate from the authoritative membership snapshot.
	// Read the same signed batch API as Mac, rather than scraping hundreds of
	// webpages. An omitted (unavailable) item keeps its favorite and can retry.
	for start := 0; start < len(missing); start += 20 {
		batch := missing[start:min(start+20, len(missing))]
		cards, err := c.libraryMetadata(ctx, batch)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			// Membership has already been read completely. A down/unavailable
			// metadata endpoint must not block progress reconciliation/upload.
			// Keep existing card data or a placeholder and retry on later sync.
			cards = nil
		}
		for _, id := range batch {
			e := remote[id]
			if card, ok := cards[id]; ok {
				e.Drama = cleanLibraryDrama(card)
			} else {
				e.Drama.MetadataPending = true
				if e.Drama.Title == "" {
					e.Drama.Title = "剧集信息暂未加载"
				}
			}
			remote[id] = e
		}
	}
	ids := []any{}
	for id := range remote {
		ids = append(ids, cloudNumericID(id))
	}
	sort.Slice(ids, func(i, j int) bool { return asString(ids[i]) < asString(ids[j]) })
	for start := 0; start < len(ids); start += 200 {
		batch := ids[start:min(start+200, len(ids))]
		p, err = c.cloudJSON(ctx, "/reading/bookapi/read_progress/get/v", http.MethodPost, nil, map[string]any{"book_ids": map[string]any{"2": batch}})
		if err != nil {
			return nil, errors.New("云端观看进度读取失败：" + err.Error())
		}
		list, ok := p["video_data"].([]any)
		if !ok {
			list, ok = passportData(p)["video_data"].([]any)
		}
		if !ok {
			return nil, errors.New("云端进度响应缺少列表")
		}
		for _, value := range list {
			r, ok := asMap(value)
			if !ok {
				continue
			}
			id := asString(r["series_id"])
			e, exists := remote[id]
			if !exists {
				continue
			}
			count := asInt(r["episode_count"])
			if count > e.Drama.EpisodeCount {
				e.Drama.EpisodeCount = count
			}
			index := asInt(r["vid_index"])
			watchTime := accountEpoch(r["last_watch_time"])
			if watchTime > 0 && watchTime < 100000000000 {
				watchTime *= 1000
			}
			if index > 0 && index <= 10000 && (e.Episode == 0 || watchTime > e.LastPlayedAt) {
				if e.Episode != index {
					e.VideoID, e.Position, e.Duration, e.Completed = "", 0, 0, false
				}
				e.Episode = index
				if watchTime > e.LastPlayedAt {
					e.LastPlayedAt = watchTime
				}
			}
			remote[id] = e
		}
	}
	out := make([]LibraryEntry, 0, len(remote))
	for _, e := range remote {
		if e.Drama.Title != "" {
			out = append(out, e)
		}
	}
	return out, nil
}

func (c *passportClient) libraryMetadata(ctx context.Context, ids []string) (map[string]Drama, error) {
	for _, id := range ids {
		if !validID(id) || id == "0" {
			return nil, errors.New("云端详情项目身份无效")
		}
	}
	p, err := c.cloudJSON(ctx, "/novel/player/multi_video_detail/preload/v1", http.MethodPost, nil, map[string]any{
		"dr_scene": "preload", "series_id": strings.Join(ids, ","),
		"biz_param": map[string]any{"detail_page_version": 0, "disable_digg_stat": false, "disable_video_relate_book": false, "need_all_video_definition": false, "need_mp4_align": false, "source": 7, "use_os_player": false, "use_server_dns": false},
	})
	if err != nil {
		return nil, err
	}
	d, ok := asMap(p["data"])
	if !ok {
		return nil, errors.New("云端详情响应缺少数据")
	}
	out := map[string]Drama{}
	for _, id := range ids {
		x, ok := asMap(d[id])
		if !ok {
			continue
		}
		v, ok := asMap(x["video_data"])
		if !ok || len(v) == 0 {
			continue
		}
		card, ok := normalizeDrama(v)
		if !ok || card.SeriesID != id {
			// Reject only this card. The history/favorites lists already own
			// membership; missing or wrong-series metadata must not poison
			// another card or stop synchronization of the remaining records.
			continue
		}
		if asString(v["series_title"]) == "" {
			continue
		}
		out[id] = card
	}
	return out, nil
}

func (s *libraryStore) mergeCloud(remote []LibraryEntry, stamp int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := cloneLibrary(s.data)
	if d.Cloud == nil {
		d.Cloud = &cloudLibraryState{}
	}
	byID := map[string]LibraryEntry{}
	for _, r := range remote {
		byID[r.Drama.SeriesID] = r
	}
	kept := d.Cloud.Pending[:0]
	for _, p := range d.Cloud.Pending {
		r := byID[p.SeriesID]
		if p.Kind == "progress" && r.LastPlayedAt > p.Entry.LastPlayedAt && d.Cloud.Hidden["history:"+p.SeriesID] == 0 {
			continue
		}
		kept = append(kept, p)
	}
	d.Cloud.Pending = kept
	pending := map[string]bool{}
	for _, p := range d.Cloud.Pending {
		pending[p.Kind+":"+p.SeriesID] = true
	}
	seen := map[string]bool{}
	indices := map[string]int{}
	for i, e := range d.Entries {
		indices[e.Drama.SeriesID] = i
	}
	for _, r := range remote {
		id := r.Drama.SeriesID
		seen[id] = true
		i, ok := indices[id]
		if !ok {
			d.Entries = append(d.Entries, LibraryEntry{Drama: cleanLibraryDrama(r.Drama)})
			i = len(d.Entries) - 1
			indices[id] = i
		}
		e := &d.Entries[i]
		if (e.Drama.Title == "" || e.Drama.MetadataPending) && !r.Drama.MetadataPending {
			e.Drama = cleanLibraryDrama(r.Drama)
		}
		if !pending["progress:"+id] && d.Cloud.Hidden["history:"+id] == 0 && r.LastPlayedAt > e.LastPlayedAt {
			fav, like, videos := e.FavoriteAt, e.LikedAt, e.LikedVideos
			*e = r
			e.Drama = cleanLibraryDrama(r.Drama)
			e.FavoriteAt = fav
			e.LikedAt = like
			e.LikedVideos = videos
		}
		if !pending["favorite:"+id] && d.Cloud.Hidden["favorites:"+id] == 0 {
			if r.FavoriteAt > 0 {
				e.FavoriteAt = r.FavoriteAt
			} else if r.FavoriteAt == 0 {
				e.FavoriteAt = 0
			}
		}
	}
	// Only a fully validated cloud snapshot can remove remote favorites. Local
	// history and likes are never erased just because a remote page is empty.
	for i, e := range d.Entries {
		if !seen[e.Drama.SeriesID] && !pending["favorite:"+e.Drama.SeriesID] {
			d.Entries[i].FavoriteAt = 0
		}
	}
	if stamp > 0 {
		d.Cloud.LastSync = stamp
	}
	pruneLibraryEntries(&d)
	return s.persistLocked(d)
}
