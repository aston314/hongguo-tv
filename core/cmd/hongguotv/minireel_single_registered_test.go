package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMiniReelSingleRegisteredSignatureVector(t *testing.T) {
	b, err := os.ReadFile("testdata/single-registered-sign-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Query, Body, Argus, Gorgon, Ladon string
		TS, Nonce                         uint32
	}
	if json.Unmarshal(b, &v) != nil {
		t.Fatal("bad vector")
	}
	if singleRegisteredArgus(v.Query, []byte(v.Body), v.TS, v.Nonce) != v.Argus || singleRegisteredGorgon(v.Query, []byte(v.Body), v.TS) != v.Gorgon || playbackLadon(v.TS, "8662", 0x04030201) != v.Ladon {
		t.Fatalf("Argus=%t Gorgon=%t Ladon=%t", singleRegisteredArgus(v.Query, []byte(v.Body), v.TS, v.Nonce) == v.Argus, singleRegisteredGorgon(v.Query, []byte(v.Body), v.TS) == v.Gorgon, playbackLadon(v.TS, "8662", 0x04030201) == v.Ladon)
	}
	for _, changed := range []string{singleRegisteredArgus(v.Query+"&device_id=changed", []byte(v.Body), v.TS, v.Nonce), singleRegisteredArgus(v.Query, []byte(v.Body+" "), v.TS, v.Nonce), singleRegisteredArgus(v.Query, []byte(v.Body), v.TS+1, v.Nonce), singleRegisteredArgus(v.Query, []byte(v.Body), v.TS, v.Nonce+1)} {
		if changed == v.Argus {
			t.Fatal("signature failed to bind request")
		}
	}
}

// Exercise the production profile against real upstream data only when requested.
// Full download/decryption verifies media rather than accepting a model URL alone.
func TestMiniReelSingleRegisteredLiveMedia(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_SINGLE_REGISTERED") != "1" {
		t.Skip("live upstream verification is opt-in")
	}
	vids := []string{"7703473857562151961", "7702841946812714008", "7702841953875938328"}
	if vid := os.Getenv("HONGGUO_LIVE_MINIREEL_VIDEO_ID"); vid != "" {
		vids = []string{vid}
	}
	for _, vid := range vids {
		t.Run(vid, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			started := time.Now()
			options, err := productionSingleRegistered.options(ctx, vid, "default")
			if err != nil {
				t.Fatal(err)
			}
			option, err := selectMiniReelQuality(options, "1080P", false)
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(t.TempDir(), "episode.mp4")
			if err := downloadMiniReelMedia(ctx, option.URL, file); err != nil {
				t.Fatal(err)
			}
			if len(option.Key) > 0 {
				if err := decryptMiniReelMP4(file, option.Key); err != nil {
					t.Fatal(err)
				}
			}
			data, err := os.ReadFile(file)
			if err != nil || len(data) < 1<<20 || !bytes.Contains(data, []byte("hvcC")) || bytes.Contains(data, []byte("bv2C")) {
				t.Fatalf("expected complete HEVC media: bytes=%d read_error=%v", len(data), err)
			}
			t.Logf("codec=%s quality=%s size=%dx%d decrypted_bytes=%d elapsed_ms=%d", option.Codec, option.Quality, option.Width, option.Height, len(data), time.Since(started).Milliseconds())
		})
	}
}
func TestMiniReelSingleRegisteredProtocolReuseAndModelShapes(t *testing.T) {
	for _, shape := range []string{"object", "json", "base64", "direct"} {
		t.Run(shape, func(t *testing.T) {
			var registrations, calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/service/2/device_register/" {
					registrations.Add(1)
					var p map[string]any
					if json.NewDecoder(r.Body).Decode(&p) != nil || p["magic_tag"] != "ss_app_log" {
						t.Error("expected JSON registration")
					}
					h, _ := p["header"].(map[string]any)
					if h["app_version"] != "7.3.5.32" || h["device_model"] != "25053RT47C" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Argus") != "" {
						t.Error("registration profile contamination")
					}
					io.WriteString(w, `{"device_id":7000000000000000001,"install_id_str":"7000000000000000002"}`)
					return
				}
				calls.Add(1)
				q := r.URL.Query()
				if q.Get("version_name") != "7.3.5.32" || q.Get("device_type") != "25053RT47C" || q.Get("device_id") != "7000000000000000001" || q.Has("ts") || q.Has("cdid") {
					t.Error("wrong playback profile")
				}
				for _, h := range []string{"Cookie", "X-Medusa", "X-Helios", "X-Tt-Token"} {
					if r.Header.Get(h) != "" {
						t.Errorf("unexpected %s", h)
					}
				}
				for _, h := range []string{"X-Argus", "X-Gorgon", "X-Ladon", "X-Khronos", "X-SS-STUB"} {
					if r.Header.Get(h) == "" {
						t.Errorf("missing %s", h)
					}
				}
				var p map[string]any
				_ = json.NewDecoder(r.Body).Decode(&p)
				if p["content_type"] != float64(1) || p["video_id"] == nil {
					t.Error("incorrect request body")
				}
				model := map[string]any{"video_list": []any{map[string]any{"main_url": "https://media.example/video.mp4", "codec_type": "bytevc1", "video_meta": map[string]any{"vheight": 1080}}}}
				var value any = model
				b, _ := json.Marshal(model)
				if shape == "json" {
					value = string(b)
				}
				if shape == "base64" {
					value = base64.StdEncoding.EncodeToString(b)
				}
				data := map[string]any{"video_model": value}
				if shape == "direct" {
					data = model
				}
				json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
			}))
			defer server.Close()
			cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
				return registerSingleRegisteredDevice(context.Background(), server.URL, server.Client())
			})
			source := &miniReelSingleRegisteredSource{endpoint: server.URL + "/single", identity: cache, client: server.Client()}
			for _, vid := range []string{"123", "456"} {
				o, e := source.options(context.Background(), vid, "default")
				if e != nil || len(o) != 1 || o[0].Codec != "bytevc1" {
					t.Fatalf("options=%d error=%v", len(o), e)
				}
			}
			if registrations.Load() != 1 || calls.Load() != 2 {
				t.Fatal("identity was not reused")
			}
		})
	}
}
func TestMiniReelSingleRegisteredEmptyRecoveryShared(t *testing.T) {
	var registrations atomic.Int32
	var arrived atomic.Int32
	ready := make(chan struct{})
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		n := registrations.Add(1)
		return miniReelDevice{deviceID: fmt.Sprint(n), installID: "9"}, nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("device_id") == "1" {
			if arrived.Add(1) == 2 {
				close(ready)
			}
			<-ready
			return
		}
		io.WriteString(w, `{"data":{"video_model":{"video_list":[{"main_url":"https://media.example/v.mp4","codec_type":"bytevc1","video_meta":{"vheight":720}}]}}}`)
	}))
	defer server.Close()
	source := &miniReelSingleRegisteredSource{endpoint: server.URL, identity: cache, client: server.Client()}
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			o, e := source.options(context.Background(), "123", "default")
			if e != nil || len(o) != 1 {
				t.Errorf("recovery failed: %v", e)
			}
		}()
	}
	wg.Wait()
	if registrations.Load() != 2 {
		t.Fatal("concurrent recovery duplicated registration")
	}
}
func TestMiniReelSingleRegisteredFallbackBoundaries(t *testing.T) {
	for _, failure := range []string{"empty", "codec", "invalid-json", "null", "business", "cancel", "media", "success"} {
		t.Run(failure, func(t *testing.T) {
			var calls []string
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.URL.Path)
				if r.URL.Path == "/new" {
					switch failure {
					case "empty":
						return
					case "codec":
						io.WriteString(w, strings.ReplaceAll(miniReelRecoveryModel, "h264", "bytevc2"))
						return
					case "invalid-json":
						io.WriteString(w, "invalid")
						return
					case "null":
						io.WriteString(w, "null")
						return
					case "business":
						io.WriteString(w, `{"code":100103}`)
						return
					case "cancel":
						cancel()
						return
					}
				}
				io.WriteString(w, miniReelRecoveryModel)
			}))
			defer server.Close()
			registered := &miniReelSingleRegisteredSource{endpoint: server.URL + "/new", identity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("new"), nil })}
			sources := miniReelPlaybackSources{registeredSingle: registered, singleEndpoint: server.URL + "/old", registerSingle: func(context.Context) (miniReelDevice, error) { return miniReelRecoveryDevice("old"), nil }}
			job := &miniReelMediaJob{CodecMode: "default", ContentType: "1004"}
			prepared := 0
			prepareMiniReelWithSources(ctx, job, "999", "123", "", true, sources, func(miniReelOption) error {
				prepared++
				if failure == "media" && prepared == 1 {
					return wrapPlaybackPreparation(errors.New("invalid media"), "media_decrypt", "MEDIA_DECRYPT_FAILED")
				}
				return nil
			})
			want := []string{"/new"}
			if failure == "empty" {
				want = []string{"/new", "/new", "/old"}
			}
			if failure == "codec" || failure == "media" || failure == "invalid-json" || failure == "null" {
				want = append(want, "/old")
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("calls=%v expected=%v error=%v", calls, want, job.Err)
			}
			if failure == "business" || failure == "cancel" {
				if job.Err == nil {
					t.Fatal("expected failure")
				}
			} else if job.Err != nil {
				t.Fatal(job.Err)
			}
		})
	}
}
