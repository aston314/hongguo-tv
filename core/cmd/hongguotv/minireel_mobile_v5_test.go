package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func mobileV5Fixture(client *http.Client, registered *int) *miniReelMobileV5Source {
	return &miniReelMobileV5Source{endpoint: "https://api.fqnovel.com/mobile", client: client, identity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		*registered++
		return miniReelDevice{deviceID: strconv.Itoa(*registered + 100), installID: "456", cdid: "synthetic", cookie: "must-not-be-sent"}, nil
	})}
}

func TestMiniReelMobileV5RequestAndCompatibility(t *testing.T) {
	for _, mode := range []string{"inline", "nested", "bytevc2", "wrong-episode", "empty-wrong-episode", "direct-model", "empty", "business", "http", "invalid", "large"} {
		t.Run(mode, func(t *testing.T) {
			registered, calls, recoveryCalls := 0, 0, 0
			var recoveryIdentity string
			var codecs []string
			client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
				status, body := 200, ""
				model := codecFallbackModel("h265", "123", 90)
				if r.URL.Path == "/fallback" {
					if r.Header.Get("X-Medusa") != "" || r.Header.Get("Cookie") != "" {
						t.Error("fallback leaked request identity")
					}
					codecs = append(codecs, r.URL.Query().Get("codec_type"))
					if r.URL.Query().Get("codec_type") != "1" {
						model = codecFallbackModel("bytevc2", "123", 90)
					}
					b, _ := json.Marshal(map[string]any{"code": 0, "video_info": map[string]any{"code": 0, "data": model}})
					body = string(b)
				} else if r.Method == http.MethodGet {
					recoveryCalls++
					if r.URL.Path != miniReelVideoTabPath || r.Header.Get("X-SS-STUB") != "" || r.Header.Get("Content-Type") != "" {
						t.Error("wrong video_tab recovery request shape")
					}
					if got := r.URL.Query().Get("video_id"); got != "123" {
						t.Errorf("video_tab recovery video_id = %q", got)
					}
					if got := r.URL.Query().Get("device_id"); got == "" {
						t.Error("video_tab recovery omitted device identity")
					} else {
						recoveryIdentity = got
					}
					if r.Header.Get("X-Khronos") == "" || r.Header.Get("X-Helios") == "" || r.Header.Get("X-Medusa") == "" {
						t.Error("video_tab recovery omitted signed headers")
					}
					if mode == "wrong-episode" || mode == "empty-wrong-episode" {
						body = `{"code":0,"data":{"video_model_data":{"124":{"video_model":{"video_list":[]}}}}}`
					} else {
						b, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"video_model_data": map[string]any{"123": map[string]any{"video_model": model}}}})
						body = string(b)
					}
				} else {
					calls++
					raw, _ := io.ReadAll(r.Body)
					if r.Method != "POST" || r.Header.Get("Content-Encoding") != "gzip" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Gorgon") != "" {
						t.Error("wrong request shape")
					}
					m := md5.Sum(raw)
					if r.Header.Get("X-SS-STUB") != strings.ToUpper(hex.EncodeToString(m[:])) {
						t.Error("signed bytes differ from sent bytes")
					}
					ts, _ := strconv.ParseUint(r.Header.Get("X-Khronos"), 10, 32)
					iv, _, _ := passportBranch(r.URL.RawQuery, raw, uint32(ts))
					if iv&15 != 12 {
						t.Error("signature not bound to final query/body")
					}
					zr, e := gzip.NewReader(bytes.NewReader(raw))
					if e != nil {
						t.Fatal(e)
					}
					plain, _ := io.ReadAll(zr)
					zr.Close()
					var request map[string]any
					if json.Unmarshal(plain, &request) != nil || nestedMiniReelValue(request, "mixed_video_id_map", "1004") == nil || request["dr_scene"] != "player" {
						t.Error("wrong payload")
					}
					biz, _ := request["biz_param"].(map[string]any)
					if fmt.Sprint(biz["device_level"]) != "1" {
						t.Errorf("device_level = %v, want 1", biz["device_level"])
					}
					if mode == "bytevc2" {
						model = codecFallbackModel("bytevc2", "123", 90)
						model["fallback_api"] = "https://api.fqnovel.com/fallback?sig=a%2fb&codec_type=4"
					}
					id := "123"
					if mode == "wrong-episode" {
						id = "124"
					}
					var data any = map[string]any{id: map[string]any{"video_model": model}}
					if mode == "nested" {
						data = map[string]any{"1004": data}
					}
					if mode == "direct-model" {
						data = map[string]any{"video_model": model}
					}
					envelope := map[string]any{"code": 0, "data": data}
					if mode == "business" {
						envelope["code"] = 12345
					}
					b, _ := json.Marshal(envelope)
					body = string(b)
					switch mode {
					case "empty", "empty-wrong-episode":
						body = " \n"
					case "http":
						status = 403
					case "invalid":
						body = "{}{}"
					case "large":
						body = strings.Repeat(" ", miniReelMobileV5MaxJSON+1)
					}
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
			})}
			source := mobileV5Fixture(client, &registered)
			options, err := source.options(context.Background(), "123", "default", "")
			if mode == "inline" || mode == "nested" || mode == "bytevc2" || mode == "empty" {
				if err != nil || len(options) != 1 || options[0].Codec != "h265" {
					t.Fatalf("compatible source failed: %v", err)
				}
				if calls != 1 || registered != 1 {
					t.Fatal("unnecessary request/registration")
				}
			} else if err == nil {
				t.Fatal("invalid model accepted")
			}
			if mode == "empty" {
				if calls != 1 || recoveryCalls != 1 || registered != 1 || recoveryIdentity != "101" || err != nil {
					t.Fatalf("empty recovery failed: calls=%d recovery=%d registered=%d identity=%q err=%v", calls, recoveryCalls, registered, recoveryIdentity, err)
				}
			} else if mode == "wrong-episode" {
				if calls != 1 || recoveryCalls != 0 || registered != 1 || !errors.Is(err, errMiniReelVideoModelMissing) {
					t.Fatal("nonempty wrong-episode response was unexpectedly recovered")
				}
			} else if mode == "empty-wrong-episode" {
				if calls != 1 || recoveryCalls != 1 || registered != 1 || !errors.Is(err, errMiniReelVideoModelEmpty) {
					t.Fatal("wrong-episode recovery accepted or churned identity")
				}
			} else if calls != 1 || registered != 1 {
				t.Fatal("nonempty failure churned identities")
			}
			if mode == "bytevc2" {
				if !reflect.DeepEqual(codecs, []string{"4", "1"}) {
					t.Fatal(codecs)
				}
			} else if len(codecs) != 0 {
				t.Fatal("healthy inline model requested fallback")
			}
		})
	}
}

func TestMiniReelMobileV5EmptyRetryAfterSkipsVideoTabRecovery(t *testing.T) {
	registered, posts, gets := 0, 0, 0
	client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodGet {
			gets++
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"code":0}`)), Header: make(http.Header)}, nil
		}
		posts++
		header := make(http.Header)
		header.Set("Retry-After", "1")
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("\n")), Header: header}, nil
	})}
	source := mobileV5Fixture(client, &registered)
	_, err := source.options(context.Background(), "123", "default", "1004")
	if !errors.Is(err, errMiniReelVideoModelEmpty) {
		t.Fatalf("error = %v, want VIDEO_MODEL_EMPTY", err)
	}
	if posts != 1 || gets != 0 || registered != 1 {
		t.Fatalf("requests after Retry-After: posts=%d gets=%d registrations=%d", posts, gets, registered)
	}
}

func TestMiniReelMobileV5SourceSequence(t *testing.T) {
	for _, mode := range []string{"tab", "v5", "old", "media", "cancel", "business", "register"} {
		t.Run(mode, func(t *testing.T) {
			var paths []string
			registered := 0
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
				paths = append(paths, r.URL.Path)
				model := codecFallbackModel("h265", "123", 90)
				data := map[string]any{"123": map[string]any{"video_model": model}}
				var envelope any = map[string]any{"code": 0, "data": data}
				if r.URL.Path == "/tab" {
					envelope = map[string]any{"code": 0, "data": map[string]any{"video_model_data": data}}
					if mode != "tab" {
						return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
					}
				}
				if r.URL.Path == "/mobile" {
					if deadline, ok := r.Context().Deadline(); !ok || time.Until(deadline) > 8*time.Second {
						t.Error("v5 escaped provider budget")
					}
					if mode == "old" {
						envelope = map[string]any{"code": 0, "data": map[string]any{}}
					}
					if mode == "business" {
						envelope = map[string]any{"code": 12345}
					}
					if mode == "cancel" {
						cancel()
						return nil, context.Canceled
					}
				}
				b, _ := json.Marshal(envelope)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(b)), Header: make(http.Header)}, nil
			})}
			mobile := mobileV5Fixture(client, &registered)
			if mode == "register" {
				mobile.identity = newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelDevice{}, errors.New("register failed") })
			}
			sources := miniReelPlaybackSources{tabEndpoint: "https://api.fqnovel.com/tab", tabIdentity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelDevice{}, nil }), mobileV5: mobile, legacyEndpoints: []string{"https://api.fqnovel.com/old"}, register: func(context.Context) (miniReelDevice, error) { return miniReelDevice{}, nil }, client: client}
			job := &miniReelMediaJob{CodecMode: "default", ContentType: "1004"}
			prepared := 0
			prepareMiniReelWithSources(ctx, job, "series", "123", "1080P", true, sources, func(miniReelOption) error {
				prepared++
				if mode == "media" && prepared == 1 {
					return wrapPlaybackPreparation(errors.New("unavailable"), "download", "MEDIA_DOWNLOAD_FAILED")
				}
				return nil
			})
			want := []string{"/tab", "/mobile"}
			if mode == "tab" {
				want = []string{"/tab"}
			}
			if mode == "old" || mode == "media" {
				want = append(want, "/old")
			}
			if mode == "register" {
				want = []string{"/tab", "/old"}
			}
			if !reflect.DeepEqual(paths, want) {
				t.Fatalf("paths=%v want=%v", paths, want)
			}
			if mode == "cancel" || mode == "business" {
				if job.Err == nil {
					t.Fatal("failure/cancellation lost")
				}
			} else if job.Err != nil {
				t.Fatal(job.Err)
			}
		})
	}
}

func TestMiniReelMobileV5ReuseAndCancellation(t *testing.T) {
	registered, calls := 0, 0
	ctx, cancel := context.WithCancel(context.Background())
	client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			cancel()
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
		data, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"123": map[string]any{"video_model": codecFallbackModel("h265", "123", 90)}}})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}, nil
	})}
	source := mobileV5Fixture(client, &registered)
	if _, err := source.options(ctx, "123", "default", "1004"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation lost")
	}
	for i := 0; i < 2; i++ {
		if _, err := source.options(context.Background(), "123", "default", "1004"); err != nil {
			t.Fatal(err)
		}
	}
	if registered != 1 || calls != 3 {
		t.Fatal("cancel/success churned reusable identity")
	}
	if _, err := source.options(ctx, "123", "default", "1004"); !errors.Is(err, context.Canceled) {
		t.Fatal("already cancelled request continued")
	}
	if calls != 3 || registered != 1 {
		t.Fatal("cancelled request performed I/O")
	}
}
