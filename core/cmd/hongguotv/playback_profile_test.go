package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"github.com/aston314/hongguo-tv/core/internal/jsupdate"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/playbackprofile"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

func TestNativeProfileRequestIdentityAndByteVC2Fallback(t *testing.T) {
	for _, variant := range []string{"tab", "post", "bytevc2", "wrong-id", "software", "business", "cancel"} {
		t.Run(variant, func(t *testing.T) {
			loaded, e := loadNativeProfile(context.Background(), playbackprofile.Builtin(), playbackprofile.Version)
			if e != nil {
				t.Fatal(e)
			}
			r := loaded.(*nativeProfileRuntime)
			defer r.Close(context.Background())
			const id = "7704857946630409240"
			r.identity = newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("profile"), nil })
			calls := []string{}
			fallback := []string{}
			r.client = &http.Client{Transport: miniReelTestRoundTripper(func(q *http.Request) (*http.Response, error) {
				calls = append(calls, q.Method)
				body := ""
				model := codecFallbackModel("h265", id, 90)
				if q.URL.Path == "/fallback" {
					fallback = append(fallback, q.URL.Query().Get("codec_type"))
					if q.URL.Query().Get("codec_type") != "3" {
						model = codecFallbackModel("bytevc2", id, 90)
					}
					b, _ := json.Marshal(map[string]any{"code": 0, "video_info": map[string]any{"code": 0, "data": model}})
					body = string(b)
				} else {
					if q.Header.Get("X-Medusa") == "" || q.Header.Get("X-Helios") == "" || q.Header.Get("X-Khronos") == "" || q.Header.Get("Cookie") != "" {
						t.Error("invalid signed request")
					}
					if variant == "cancel" {
						<-q.Context().Done()
						return nil, q.Context().Err()
					}
					if variant == "business" {
						body = `{"code":110001}`
					} else if q.Method == "POST" {
						raw, _ := io.ReadAll(q.Body)
						z, e := gzip.NewReader(bytes.NewReader(raw))
						if e != nil {
							t.Fatal(e)
						}
						plain, _ := io.ReadAll(z)
						z.Close()
						if !strings.Contains(string(plain), `"1003":["`+id+`"]`) {
							t.Error("lost precise ID or content type")
						}
						entryID := id
						if variant == "wrong-id" {
							entryID = "123"
						}
						b, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"1003": map[string]any{entryID: map[string]any{"video_model": model}}}})
						body = string(b)
					} else if variant == "tab" || variant == "bytevc2" || variant == "wrong-id" || variant == "software" {
						if q.URL.Query().Get("video_id") != id {
							t.Error("lost exact tab ID")
						}
						if variant == "bytevc2" {
							model = codecFallbackModel("bytevc2", id, 90)
							model["fallback_api"] = "https://api.fqnovel.com/fallback?signed=unchanged&codec_type=4"
						}
						entryID := id
						if variant == "wrong-id" {
							entryID = "123"
						}
						b, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"video_model_data": map[string]any{entryID: map[string]any{"video_model": model}}}})
						body = string(b)
					}
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			ctx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer stop()
			mode := "default"
			if variant == "software" {
				mode = "software"
			}
			out, e := r.Resolve(ctx, resolverwire.Request{VID: id, ContentType: "1003", CodecMode: mode})
			switch variant {
			case "business":
				var up *jsresolver.Error
				if !errors.As(e, &up) || up.Code != "VIDEO_MODEL_BUSINESS" || len(calls) != 1 {
					t.Fatal("business retry escaped", len(calls), e)
				}
			case "wrong-id":
				if e == nil {
					t.Fatal("accepted wrong episode")
				}
			case "cancel":
				if !errors.Is(e, context.DeadlineExceeded) || len(calls) != 1 {
					t.Fatal("cancel lost", e, len(calls))
				}
			default:
				if e != nil || len(out) == 0 || miniReelIsByteVC2(out[0].Codec) {
					t.Fatal("no compatible source", e)
				}
				if variant == "tab" && !reflect.DeepEqual(calls, []string{"GET"}) {
					t.Fatal("continued after successful tab")
				}
				if variant == "bytevc2" && !reflect.DeepEqual(fallback, []string{"4", "1", "0", "3"}) {
					t.Fatal("lost codec fallback", fallback)
				}
			}
		})
	}
}
func TestNativeProfileIndependentOfJSSettingAndMediaFallback(t *testing.T) {
	service, e := newNativeProfileService(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer service.close(context.Background())
	repair, _, count := repairServiceForTest(t)
	if repair.status().Enabled || count.Load() != 0 {
		t.Fatal("started JS")
	}
	if service.manager.Status().Version != playbackprofile.Version {
		t.Fatal("missing automatic builtin")
	}
	order := []string{}
	sources := miniReelPlaybackSources{
		repair: func(context.Context, string, string, string) ([]miniReelOption, error) {
			order = append(order, "js")
			return nil, nil
		},
		profile: func(context.Context, string, string, string) ([]miniReelOption, error) {
			order = append(order, "json")
			return []miniReelOption{{URL: "https://cdn.example/data.mp4", Codec: "h265"}}, nil
		},
	}
	seq := newMiniReelSourceSequence(sources, "123", "default", "1004", "")
	out, e := seq.next(context.Background())
	if e != nil || len(out) != 1 || !reflect.DeepEqual(order, []string{"js", "json"}) {
		t.Fatal("wrong priority", order, e)
	}
	// The next call represents a media failure: neither optional path restarts.
	ctx, stop := context.WithCancel(context.Background())
	stop()
	seq.next(ctx)
	if len(order) != 2 {
		t.Fatal("retried after cancel")
	}
	seq.sources.profile = func(context.Context, string, string, string) ([]miniReelOption, error) {
		t.Fatal("repeated JSON after media failure")
		return nil, nil
	}
	seq.stage = 3
	out, _ = seq.next(context.Background())
	if len(out) != 0 {
		t.Fatal("exhausted sources accepted")
	}
}

func TestNativeProfileCheckStatusDoesNotChangeJSState(t *testing.T) {
	life, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	f := &fakeRepairRuntime{status: jsupdate.Status{Source: "embedded", Automatic: true, Format: "json", Version: "builtin", SHA256: "old"}}
	var calls atomic.Int32
	f.check = func(ctx context.Context) error {
		calls.Add(1)
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			return ctx.Err()
		}
		f.setStatus(jsupdate.Status{Source: "downloaded", Automatic: true, Format: "json", Enabled: true, Revision: 2, ActiveRevision: 2, Version: "json.2", SHA256: "new"})
		return nil
	}
	service := &nativeProfileService{manager: f, life: life, cancel: cancel}
	previous := defaultNativeProfile.Swap(service)
	defer defaultNativeProfile.Store(previous)
	js, _, jsCount := repairServiceForTest(t)
	service.check()
	<-entered
	state := js.status()
	if state.Enabled || state.Checking || state.Revision != 0 || state.NativeProfile == nil || !state.NativeProfile.Checking || state.NativeProfile.Event != "checking" || jsCount.Load() != 0 {
		t.Fatal("JSON changed JS state", state)
	}
	service.check()
	if calls.Load() != 1 {
		t.Fatal("duplicate check")
	}
	close(release)
	wait := func() nativeProfileStatus {
		until := time.Now().Add(time.Second)
		for time.Now().Before(until) {
			s := service.status()
			if !s.Checking {
				return s
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatal("check stalled")
		return nativeProfileStatus{}
	}
	current := wait()
	if current.Event != "updated" || current.LastChecked == 0 || current.LastUpdated == 0 || current.Version != "json.2" {
		t.Fatal("no completed update metadata", current)
	}
	f.check = func(context.Context) error { return errors.New("offline") }
	service.check()
	failed := wait()
	if failed.Event != "check_failed" || failed.Version != "json.2" || failed.LastUpdated != current.LastUpdated || failed.Change <= current.Change {
		t.Fatal("offline check changed usable version", failed)
	}
	if jsCount.Load() != 0 || js.status().Enabled || js.status().Checking {
		t.Fatal("JSON status loaded JS")
	}
}
