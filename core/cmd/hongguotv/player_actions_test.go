package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type playerReadProbeTransport struct{ dir string }

func (p playerReadProbeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err == nil && strings.HasPrefix(r.URL.Path, "/novel/commentapi/reply/list/") {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		resp.Body = io.NopCloser(bytes.NewReader(b))
		_ = os.WriteFile(filepath.Join(p.dir, "replies-raw.json"), b, 0600)
	}
	return resp, err
}

// Explicitly enabled anonymous reads only; this never calls publishing methods.
func TestLivePlayerReplies(t *testing.T) {
	dir := os.Getenv("HONGGUO_PLAYER_READ_PROBE_DIR")
	if dir == "" {
		t.Skip("anonymous read-only replies probe")
	}
	c := newPassportClient(accountSession{DeviceID: miniReelRandomID(), InstallID: miniReelRandomID(), Cookies: map[string]string{}})
	c.http.Transport = playerReadProbeTransport{dir}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	q := url.Values{"series_id": {"7690163276214176792"}, "vid": {"7690223053078268953"}}
	comments, err := c.Discussion(ctx, q, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, comment := range comments.Items {
		if comment.Replies > 0 {
			q.Set("comment_id", comment.CommentID)
			break
		}
	}
	if q.Get("comment_id") == "" {
		t.Fatal("sample has no replies")
	}
	out, err := c.Replies(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Items) == 0 {
		t.Fatal("sample returned no normalized replies")
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "replies-anonymous.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("anonymous replies count=%d total=%d more=%v", len(out.Items), out.Total, out.HasMore)
}

func TestCommentOwnershipUsesAccountUIDNotSeriesAuthor(t *testing.T) {
	row := map[string]any{"comment_id": "789", "common": map[string]any{"content": map[string]any{"text": "内容"}, "user_info": map[string]any{"base_info": map[string]any{"user_id": "123"}}}, "user_action": map[string]any{"author": true, "user_digg": true}}
	if item := discussionItem(row, false, "456"); item.Own || !item.Liked {
		t.Fatal("series-author flag must not grant comment ownership", item)
	}
	if !discussionItem(row, false, "123").Own || discussionItem(row, false, "").Own {
		t.Fatal("comment ownership must match logged-in UID")
	}
}

func TestPlayerActionRejectsExtraJSONAndStaleAccountResult(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	m := loggedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		ioJSON(w, `{"code":0,"data":{"comment_info":{"comment_id":789}}}`)
	})
	s := &server{accounts: m}
	for _, body := range []string{`{"action":"comment","series_id":"123","vid":"456","text":"内容","unexpected":true}`, `{"action":"comment","series_id":"123","vid":"456","text":"内容"} {}`} {
		res := httptest.NewRecorder()
		s.playerAction(res, httptest.NewRequest("POST", "/api/v1/player/action", strings.NewReader(body)))
		if res.Code != 400 {
			t.Fatal("malformed write accepted", res.Code)
		}
	}
	res := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.playerAction(res, httptest.NewRequest("POST", "/api/v1/player/action", strings.NewReader(`{"action":"comment","series_id":"123","vid":"456","text":"内容"}`)))
	}()
	<-entered
	if err := m.logout(); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done
	if res.Code != 409 {
		t.Fatal("late result leaked into the next account", res.Code)
	}
}

func TestPlayerWriteProtocolAndConfirmedIDs(t *testing.T) {
	for _, action := range []string{"comment", "reply", "danmaku", "comment-like", "comment-delete"} {
		t.Run(action, func(t *testing.T) {
			value := true
			c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				dec := json.NewDecoder(r.Body)
				dec.UseNumber()
				if err := dec.Decode(&body); err != nil {
					t.Fatal(err)
				}
				if r.Method != http.MethodPost || r.Header.Get("X-Medusa") == "" {
					t.Error("unsigned write")
				}
				if action == "comment-like" {
					if r.URL.Path != "/novel/commentapi/comment/do_action/v1/" || body["object_id"] != "7691344565400093502" || asInt(body["action_type"]) != 8 || asInt(body["object_type"]) != 8 || asInt(body["comment_type"]) != 4 {
						t.Error("wrong like protocol", body)
					}
					ioJSON(w, `{"code":0,"data":{}}`)
					return
				}
				if action == "comment-delete" {
					if r.URL.Path != "/novel/commentapi/comment/del/v1/" || body["comment_id"] != "7691344565400093502" || asInt(body["service_id"]) != 4 {
						t.Error("wrong delete protocol")
					}
					ioJSON(w, `{"code":0,"data":{}}`)
					return
				}
				business, _ := asMap(body["business_param"])
				if business["book_id"] != "7690163276214176792" || body["group_id"] != "7690223053078268953" || asInt(body["group_type"]) != 30 || body["text"] != "测试内容" {
					t.Error("lost exact IDs or text", body)
				}
				if action == "danmaku" {
					if asInt(body["commit_source"]) != 1500 || asInt(body["data_type"]) != 20 || asInt64(business["offset"]) != 19345 {
						t.Error("wrong danmaku units")
					}
				} else if action == "reply" {
					if r.URL.Path != "/novel/commentapi/reply/add/v1/" || asInt(body["commit_source"]) != 9 || body["reply_to_comment_id"] != "7691344565400093502" {
						t.Error("wrong reply protocol")
					}
					ioJSON(w, `{"code":0,"data":{"reply":{"reply_id":7691344565400093503}}}`)
					return
				} else if asInt(body["commit_source"]) != 3 || asInt(body["data_type"]) != 4 {
					t.Error("wrong comment protocol")
				}
				ioJSON(w, `{"code":0,"data":{"comment_info":{"comment_id":7691344565400093503}}}`)
			})
			defer close()
			out, err := c.PlayerAction(context.Background(), PlayerAction{Action: action, SeriesID: "7690163276214176792", Vid: "7690223053078268953", CommentID: "7691344565400093502", Text: " 测试内容 ", OffsetMS: 19345, Value: &value})
			if err != nil {
				t.Fatal(err)
			}
			if out != nil && out.CommentID != "7691344565400093503" {
				t.Error("ID lost precision", out)
			}
		})
	}
}

func TestPlayerWritesRejectUnconfirmedSuccessAndMalformedInput(t *testing.T) {
	for _, response := range []string{`{"code":0,"data":{}}`, `{"code":1,"message":"拒绝"}`, `{}`} {
		c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) { ioJSON(w, response) })
		_, err := c.PlayerAction(context.Background(), PlayerAction{Action: "comment", SeriesID: "123", Vid: "456", Text: "内容"})
		close()
		if err == nil {
			t.Error("unconfirmed post accepted", response)
		}
	}
	for _, a := range []PlayerAction{{Action: "comment", SeriesID: "123", Vid: "456", Text: strings.Repeat("字", 501)}, {Action: "danmaku", SeriesID: "123", Vid: "456", Text: "内容", OffsetMS: -1}, {Action: "comment-like", SeriesID: "123", Vid: "456", CommentID: "789"}, {Action: "reply", SeriesID: "123", Vid: "456", Text: "内容", CommentID: "0"}} {
		if a.validate() == nil {
			t.Error("invalid input accepted", a.Action)
		}
	}
	m := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) { t.Error("guest must not call upstream") })
	s := &server{accounts: m}
	res := httptest.NewRecorder()
	s.playerAction(res, httptest.NewRequest("POST", "/api/v1/player/action", strings.NewReader(`{"action":"comment","series_id":"123","vid":"456","text":"内容"}`)))
	if res.Code != 401 {
		t.Error("guest write not rejected", res.Code)
	}
}

func TestReplyPaginationAndOwnership(t *testing.T) {
	c, close := listFixtureClient(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if r.Method != http.MethodPost || r.URL.Path != "/novel/commentapi/reply/list/7691344565400093502/v1/" || r.Header.Get("comment-source") != "504" || asInt(body["comment_source"]) != 504 || asInt(body["count"]) != 10 || body["cursor"] != "page1" {
			t.Error("reply request lost target or cursor")
		}
		ioJSON(w, `{"code":0,"data":{"comment_list_info":{"cursor":"page2","has_more":true,"total":30},"reply_list":[{"reply_id":7691344565400093503,"Common":{"content":{"text":"回复"},"user_info":{"base_info":{"user_name":"观众"}}}}]}}`)
	})
	defer close()
	out, err := c.Replies(context.Background(), url.Values{"series_id": {"123"}, "vid": {"456"}, "comment_id": {"7691344565400093502"}, "cursor": {"page1"}})
	if err != nil || len(out.Items) != 1 || out.Items[0].CommentID != "7691344565400093503" || out.Items[0].Text != "回复" || !out.HasMore {
		t.Fatal(out, err)
	}
}

func TestQualitySelectionAndIndependentCacheKeys(t *testing.T) {
	options := []miniReelOption{{Height: 1080, Quality: "1080P"}, {Height: 720, Quality: "720P"}, {Height: 480, Quality: "480P"}, {Height: 720, Quality: "720P"}}
	if got, _ := selectMiniReelQuality(options, "", false); got.Quality != "720P" {
		t.Error("auto changed")
	}
	if got, err := selectMiniReelQuality(options, "1080P", false); err != nil || got.Quality != "1080P" {
		t.Fatal(got, err)
	}
	if _, err := selectMiniReelQuality(options, "2160P", false); err == nil {
		t.Error("missing choice must fail")
	}
	if got, err := selectMiniReelQuality(options, "2160P", true); err != nil || got.Quality != "720P" {
		t.Error("next episode fallback failed")
	}
	if got := miniReelQualities(options); len(got) != 3 || got[0] != "480P" || got[2] != "1080P" {
		t.Error(got)
	}
	if miniReelQualityToken("123", "456", "720P", true) == miniReelQualityToken("123", "456", "1080P", true) {
		t.Error("quality shared cache")
	}
	if miniReelQualityToken("123", "456", "", true) == miniReelQualityToken("123", "456", "", false) {
		t.Error("fallback policy shared AUTO cache")
	}
	if miniReelQualityToken("123", "456", "720P", true) == miniReelCacheToken("123", "456", "720P", true, "range") {
		t.Error("full and Range shared cache")
	}
	if miniReelCacheTokenWithCodec("123", "456", "720P", true, "range", "auto") == miniReelCacheTokenWithCodec("123", "456", "720P", true, "range", "software") {
		t.Error("different codec modes shared a Range cache")
	}
	if _, err := normalizePlaybackQuality("https://example.com"); err == nil {
		t.Error("invalid quality accepted")
	}
}
