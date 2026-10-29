package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	notificationStateVersion = 1
	notificationItemLimit    = 200
	notificationPageLimit    = 10
)

// NotificationItem is deliberately a small, account-local record. It is not
// a server push message: the client discovers changes during a normal refresh
// and keeps the result so closing the toast does not lose the history.
type NotificationItem struct {
	ID            string             `json:"id"`
	Kind          string             `json:"kind"`
	SeriesID      string             `json:"series_id,omitempty"`
	ReservationID string             `json:"reservation_id,omitempty"`
	Drama         *notificationDrama `json:"drama,omitempty"`
	Title         string             `json:"title"`
	Episode       int                `json:"episode,omitempty"`
	Message       string             `json:"message"`
	CreatedAt     int64              `json:"created_at"`
	Read          bool               `json:"read"`
}

type notificationDrama struct {
	SeriesID      string   `json:"series_id"`
	Title         string   `json:"title"`
	Cover         string   `json:"cover,omitempty"`
	CoverFallback string   `json:"cover_fallback,omitempty"`
	Intro         string   `json:"intro,omitempty"`
	Score         string   `json:"score,omitempty"`
	EpisodeCount  int      `json:"episode_count,omitempty"`
	Tags          []string `json:"tags,omitempty"`
	Heat          string   `json:"heat,omitempty"`
	FavoriteText  string   `json:"favorite_text,omitempty"`
	LikeText      string   `json:"like_text,omitempty"`
	SeasonIndex   int      `json:"season_index,omitempty"`
}

func notificationDramaFrom(item Drama) notificationDrama {
	return notificationDrama{
		SeriesID: item.SeriesID, Title: item.Title, Cover: item.Cover,
		CoverFallback: item.CoverFallback, Intro: item.Intro, Score: item.Score,
		EpisodeCount: item.EpisodeCount, Tags: append([]string(nil), item.Tags...),
		Heat: item.Heat, FavoriteText: item.FavoriteText, LikeText: item.LikeText,
		SeasonIndex: item.SeasonIndex,
	}
}

type notificationFollowSnapshot struct {
	Title            string `json:"title"`
	EpisodeCount     int    `json:"episode_count"`
	FollowUpdateTime int64  `json:"follow_update_time"`
}

type notificationReservationSnapshot struct {
	Title     string `json:"title"`
	SeriesID  string `json:"series_id,omitempty"`
	Upcoming  bool   `json:"upcoming"`
	PublishAt int64  `json:"publish_at,omitempty"`
}

type notificationState struct {
	Version      int                                        `json:"version"`
	Follow       map[string]notificationFollowSnapshot      `json:"follow_snapshots"`
	Reservations map[string]notificationReservationSnapshot `json:"reservation_snapshots"`
	Items        []NotificationItem                         `json:"items"`
	LastCheckAt  int64                                      `json:"last_check_at"`
}

type notificationResponse struct {
	OK          bool               `json:"ok"`
	Items       []NotificationItem `json:"items"`
	UnreadCount int                `json:"unread_count"`
	CheckedAt   int64              `json:"checked_at,omitempty"`
	Stale       bool               `json:"stale,omitempty"`
	Error       string             `json:"error,omitempty"`
}

func emptyNotificationState() notificationState {
	return notificationState{Version: notificationStateVersion, Follow: map[string]notificationFollowSnapshot{}, Reservations: map[string]notificationReservationSnapshot{}, Items: []NotificationItem{}}
}

func normalizeNotificationState(state notificationState) notificationState {
	if state.Version == 0 {
		state.Version = notificationStateVersion
	}
	if state.Follow == nil {
		state.Follow = map[string]notificationFollowSnapshot{}
	}
	if state.Reservations == nil {
		state.Reservations = map[string]notificationReservationSnapshot{}
	}
	if state.Items == nil {
		state.Items = []NotificationItem{}
	}
	if len(state.Items) > notificationItemLimit {
		state.Items = state.Items[len(state.Items)-notificationItemLimit:]
	}
	return state
}

func (m *accountManager) currentAccountUID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.disk.Profile == nil {
		return ""
	}
	return m.disk.Profile.UID
}

func (m *accountManager) notificationPath(uid string) string {
	return filepath.Join(m.dir, "accounts", uid, "notifications.json")
}

func readNotificationState(path string) (notificationState, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyNotificationState(), nil
	}
	if err != nil {
		return notificationState{}, err
	}
	var state notificationState
	if err := json.Unmarshal(b, &state); err != nil {
		return notificationState{}, err
	}
	return normalizeNotificationState(state), nil
}

func notificationSignature(item Drama) string {
	return strconv.Itoa(item.EpisodeCount) + ":" + strconv.FormatInt(item.FollowUpdateTime, 10)
}

func followSnapshotMap(items []Drama) map[string]notificationFollowSnapshot {
	result := map[string]notificationFollowSnapshot{}
	for _, item := range items {
		if !validID(item.SeriesID) || item.SeriesID == "0" {
			continue
		}
		if _, exists := result[item.SeriesID]; exists {
			continue
		}
		result[item.SeriesID] = notificationFollowSnapshot{Title: item.Title, EpisodeCount: item.EpisodeCount, FollowUpdateTime: item.FollowUpdateTime}
	}
	return result
}

func reservationSnapshotMap(items []Drama) map[string]notificationReservationSnapshot {
	result := map[string]notificationReservationSnapshot{}
	for _, item := range items {
		if item.ReservationID == "" || item.ReservationID == "0" {
			continue
		}
		result[item.ReservationID] = notificationReservationSnapshot{Title: item.Title, SeriesID: item.SeriesID, Upcoming: item.Upcoming, PublishAt: item.PublishTime}
	}
	return result
}

func appendNotification(state *notificationState, item NotificationItem) {
	for _, existing := range state.Items {
		if existing.ID == item.ID {
			return
		}
	}
	state.Items = append(state.Items, item)
	if len(state.Items) > notificationItemLimit {
		state.Items = state.Items[len(state.Items)-notificationItemLimit:]
	}
}

func fetchFollowNotifications(ctx context.Context, c *passportClient) ([]Drama, error) {
	var items []Drama
	q := url.Values{}
	seen := map[string]bool{}
	for page := 0; page < notificationPageLimit; page++ {
		result, err := c.FollowUpdates(ctx, q)
		if err != nil {
			return nil, err
		}
		for _, item := range result.Items {
			if !seen[item.SeriesID] {
				seen[item.SeriesID] = true
				items = append(items, item)
			}
		}
		if !result.HasMore || result.NextCursor == "" || result.NextCursor == q.Get("cursor") {
			return items, nil
		}
		q.Set("cursor", result.NextCursor)
	}
	return nil, errors.New("追更列表分页未完成")
}

func fetchReservationNotifications(ctx context.Context, c *passportClient, mode string) ([]Drama, error) {
	var items []Drama
	seen := map[string]bool{}
	offset := 0
	for page := 0; page < notificationPageLimit; page++ {
		q := url.Values{"offset": {strconv.Itoa(offset)}}
		if mode != "" {
			q.Set("mode", mode)
		}
		result, err := c.SubscriptionList(ctx, q, false)
		if err != nil {
			return nil, err
		}
		for _, item := range result.Items {
			if item.ReservationID != "" && !seen[item.ReservationID] {
				seen[item.ReservationID] = true
				items = append(items, item)
			}
		}
		if !result.HasMore || result.NextOffset <= offset {
			return items, nil
		}
		offset = result.NextOffset
	}
	return nil, errors.New("预约列表分页未完成")
}

func (m *accountManager) refreshNotifications(ctx context.Context) (notificationState, []string, error) {
	uid := m.currentAccountUID()
	if uid == "" {
		return notificationState{}, nil, errListLogin
	}
	m.notificationMu.Lock()
	defer m.notificationMu.Unlock()
	c, generation, err := m.listClient(true)
	if err != nil {
		return notificationState{}, nil, err
	}
	path := m.notificationPath(uid)
	state, err := readNotificationState(path)
	if err != nil {
		return notificationState{}, nil, errors.New("更新提醒记录读取失败")
	}
	firstCheck := state.LastCheckAt == 0
	var problems []string

	followItems, followErr := fetchFollowNotifications(ctx, c)
	currentDramas := make(map[string]notificationDrama, len(followItems))
	if followErr == nil {
		current := followSnapshotMap(followItems)
		for _, item := range followItems {
			if validID(item.SeriesID) && item.SeriesID != "0" {
				currentDramas[item.SeriesID] = notificationDramaFrom(item)
			}
		}
		if !firstCheck {
			for id, item := range current {
				previous, exists := state.Follow[id]
				if !exists || notificationSignature(Drama{EpisodeCount: item.EpisodeCount, FollowUpdateTime: item.FollowUpdateTime}) == notificationSignature(Drama{EpisodeCount: previous.EpisodeCount, FollowUpdateTime: previous.FollowUpdateTime}) {
					continue
				}
				episode := item.EpisodeCount
				message := "《" + item.Title + "》有新内容"
				if episode > previous.EpisodeCount && episode > 0 {
					message = "《" + item.Title + "》更新到第" + strconv.Itoa(episode) + "集"
				}
				notification := NotificationItem{ID: "follow:" + id + ":" + strconv.Itoa(item.EpisodeCount) + ":" + strconv.FormatInt(item.FollowUpdateTime, 10), Kind: "follow_update", SeriesID: id, Title: item.Title, Episode: episode, Message: message, CreatedAt: time.Now().UnixMilli()}
				if snapshot, exists := currentDramas[id]; exists {
					notification.Drama = &snapshot
				}
				appendNotification(&state, notification)
			}
		}
		state.Follow = current
	} else {
		problems = append(problems, "追更检查失败："+followErr.Error())
	}

	onlineItems, onlineErr := fetchReservationNotifications(ctx, c, "")
	upcomingItems, upcomingErr := fetchReservationNotifications(ctx, c, "upcoming")
	if onlineErr == nil && upcomingErr == nil {
		combined := append(append([]Drama{}, onlineItems...), upcomingItems...)
		for _, item := range combined {
			if validID(item.SeriesID) && item.SeriesID != "0" {
				if _, exists := currentDramas[item.SeriesID]; !exists {
					currentDramas[item.SeriesID] = notificationDramaFrom(item)
				}
			}
		}
		current := reservationSnapshotMap(combined)
		if !firstCheck {
			for id, item := range current {
				previous, exists := state.Reservations[id]
				if !exists || !previous.Upcoming || item.Upcoming {
					continue
				}
				message := "《" + item.Title + "》已上线，可以播放了"
				notification := NotificationItem{ID: "reservation:" + id, Kind: "reservation_online", SeriesID: item.SeriesID, ReservationID: id, Title: item.Title, Message: message, CreatedAt: time.Now().UnixMilli()}
				if snapshot, exists := currentDramas[item.SeriesID]; exists {
					notification.Drama = &snapshot
				}
				appendNotification(&state, notification)
			}
		}
		state.Reservations = current
	} else {
		if onlineErr != nil {
			problems = append(problems, "已上线预约检查失败："+onlineErr.Error())
		}
		if upcomingErr != nil {
			problems = append(problems, "待上线预约检查失败："+upcomingErr.Error())
		}
	}
	for i := range state.Items {
		item := &state.Items[i]
		if item.Drama != nil || item.SeriesID == "" {
			continue
		}
		if snapshot, exists := currentDramas[item.SeriesID]; exists {
			item.Drama = &snapshot
		}
	}
	if !m.sameGeneration(generation) {
		return notificationState{}, nil, errAccountChanged
	}
	if len(problems) == 0 {
		state.LastCheckAt = time.Now().UnixMilli()
	}
	if err := atomicPrivateJSON(path, normalizeNotificationState(state)); err != nil {
		return notificationState{}, nil, errors.New("更新提醒记录保存失败")
	}
	return state, problems, nil
}

func notificationPayload(state notificationState, problems []string) notificationResponse {
	state = normalizeNotificationState(state)
	response := notificationResponse{OK: true, Items: state.Items, CheckedAt: state.LastCheckAt, Stale: len(problems) > 0}
	for _, item := range state.Items {
		if !item.Read {
			response.UnreadCount++
		}
	}
	if len(problems) > 0 {
		response.Error = strings.Join(problems, "；")
	}
	return response
}

func (s *server) notifications(w http.ResponseWriter, r *http.Request) {
	uid := s.accounts.currentAccountUID()
	if uid == "" {
		writeError(w, http.StatusUnauthorized, errListLogin.Error())
		return
	}
	if r.Method == http.MethodGet {
		state, problems, err := s.accounts.refreshNotifications(r.Context())
		if err != nil {
			if errors.Is(err, errListLogin) {
				writeError(w, http.StatusUnauthorized, err.Error())
			} else {
				writeError(w, http.StatusBadGateway, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusOK, notificationPayload(state, problems))
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		ID  string `json:"id"`
		All bool   `json:"all"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || (!body.All && strings.TrimSpace(body.ID) == "") {
		writeError(w, http.StatusBadRequest, "更新提醒参数无效")
		return
	}
	path := s.accounts.notificationPath(uid)
	s.accounts.notificationMu.Lock()
	defer s.accounts.notificationMu.Unlock()
	state, err := readNotificationState(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "更新提醒记录读取失败")
		return
	}
	if body.All {
		for i := range state.Items {
			state.Items[i].Read = true
		}
	} else {
		for i := range state.Items {
			if state.Items[i].ID == body.ID {
				state.Items[i].Read = true
			}
		}
	}
	if err := atomicPrivateJSON(path, normalizeNotificationState(state)); err != nil {
		writeError(w, http.StatusInternalServerError, "更新提醒记录保存失败")
		return
	}
	writeJSON(w, http.StatusOK, notificationPayload(state, nil))
}
