package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNotificationStateNormalizesAndTrims(t *testing.T) {
	state := notificationState{Items: make([]NotificationItem, notificationItemLimit+3)}
	for i := range state.Items {
		state.Items[i].ID = string(rune('a'+i%26)) + ":" + string(rune(i))
	}
	state = normalizeNotificationState(state)
	if state.Version != notificationStateVersion || len(state.Follow) != 0 || len(state.Reservations) != 0 || len(state.Items) != notificationItemLimit {
		t.Fatalf("state was not normalized: %+v", state)
	}
}

func TestAppendNotificationDeduplicatesAndBounds(t *testing.T) {
	state := emptyNotificationState()
	item := NotificationItem{ID: "follow:1:2", Title: "测试短剧"}
	appendNotification(&state, item)
	appendNotification(&state, item)
	if len(state.Items) != 1 {
		t.Fatalf("duplicate notification appended: %+v", state.Items)
	}
	for i := 0; i < notificationItemLimit+5; i++ {
		appendNotification(&state, NotificationItem{ID: "id:" + string(rune(i+1))})
	}
	if len(state.Items) != notificationItemLimit || state.Items[len(state.Items)-1].ID == item.ID {
		t.Fatalf("notification limit/order failed: first=%v last=%v len=%d", state.Items[0].ID, state.Items[len(state.Items)-1].ID, len(state.Items))
	}
}

func TestNotificationPayloadCountsUnreadAndReportsStale(t *testing.T) {
	state := emptyNotificationState()
	state.LastCheckAt = 123
	state.Items = []NotificationItem{{ID: "1", Read: false}, {ID: "2", Read: true}}
	payload := notificationPayload(state, []string{"追更检查失败"})
	if !payload.OK || payload.UnreadCount != 1 || !payload.Stale || payload.Error == "" || payload.CheckedAt != 123 {
		t.Fatalf("bad notification payload: %+v", payload)
	}
}

func TestNotificationDramaStoresOnlyPlayableCardMetadata(t *testing.T) {
	item := Drama{
		SeriesID: "1234567890123456789", Title: "测试短剧", Cover: "cover.jpg",
		CoverFallback: "cover-fallback.jpg", Intro: "简介", Score: "9.2", EpisodeCount: 24,
		Tags: []string{"短剧", "都市"}, Heat: "热度 1.2万", SeasonIndex: 2,
		Vid: "episode-1", VidList: []string{"episode-1", "episode-2"},
		Episodes: []Episode{{Index: 1, VideoID: "episode-1"}},
	}
	card := notificationDramaFrom(item)
	data, err := json.Marshal(NotificationItem{ID: "follow:test", SeriesID: item.SeriesID, Title: item.Title, Drama: &card})
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(data)
	for _, want := range []string{`"cover":"cover.jpg"`, `"episode_count":24`, `"season_index":2`, `"heat":"热度 1.2万"`} {
		if !strings.Contains(encoded, want) {
			t.Fatalf("notification card metadata missing %s in %s", want, encoded)
		}
	}
	for _, unwanted := range []string{`"vid"`, `"vid_list"`, `"episodes"`, `"video_id"`} {
		if strings.Contains(encoded, unwanted) {
			t.Fatalf("notification persisted playback payload %s in %s", unwanted, encoded)
		}
	}
}
