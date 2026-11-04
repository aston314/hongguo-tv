package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMiniReelVideoTabUsesOfficialGetShapeAndRegisteredCookies(t *testing.T) {
	device := miniReelDevice{
		deviceID:  "1234567890123456789",
		installID: "2234567890123456789",
		cdid:      "00000000-0000-4000-8000-000000000001",
		cookie:    "install_id=2234567890123456789; store-region=cn-tj",
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != miniReelVideoTabPath {
			t.Errorf("path = %q", r.URL.Path)
		}
		if body, err := io.ReadAll(r.Body); err != nil || len(body) != 0 {
			t.Errorf("GET body = %q, err=%v", body, err)
		}
		for key, want := range map[string]string{
			"video_id":                  "123",
			"video_id_type":             "0",
			"device_level":              "1",
			"need_all_video_definition": "1",
			"need_mp4_align":            "0",
			"use_os_player":             "0",
			"video_platform":            "1024",
			"source":                    "0",
			"from_video_id":             "",
			"device_id":                 device.deviceID,
			"iid":                       device.installID,
			"cdid":                      device.cdid,
		} {
			if got := r.URL.Query().Get(key); got != want {
				t.Errorf("query %s = %q, want %q", key, got, want)
			}
		}
		if got := r.Header.Get("User-Agent"); got != miniReelPlaybackUA {
			t.Errorf("User-Agent = %q", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json; charset=utf-8" {
			t.Errorf("Accept = %q", got)
		}
		if got := r.Header.Get("Cookie"); got != device.cookie {
			t.Errorf("Cookie = %q, want %q", got, device.cookie)
		}
		for _, header := range []string{"X-Medusa", "X-Gorgon", "X-Argus", "X-Ladon"} {
			if got := r.Header.Get(header); got != "" {
				t.Errorf("unexpected full signature header %s=%q", header, got)
			}
		}
		response := map[string]any{
			"code": 0,
			"data": map[string]any{
				"video_model_data": map[string]any{
					"123": map[string]any{
						"video_model": map[string]any{
							"video_list": []any{
								map[string]any{
									"main_url": "https://media.example/720.mp4",
									"video_meta": map[string]any{
										"codec_type": "h264",
										"vwidth":     1280,
										"vheight":    720,
										"definition": "720p",
									},
									"encrypt_info": map[string]any{"encrypt": false},
								},
							},
							"video_duration": 61,
						},
					},
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	options, err := miniReelVideoTabOptions(context.Background(), "123", server.URL+miniReelVideoTabPath, device, "default")
	if err != nil {
		t.Fatalf("miniReelVideoTabOptions() error = %v", err)
	}
	if len(options) != 1 {
		t.Fatalf("options = %#v", options)
	}
	if got := options[0]; got.URL != "https://media.example/720.mp4" || got.Quality != "720P" || got.Width != 1280 || got.Height != 720 || got.Duration != 61 {
		t.Fatalf("option = %#v", got)
	}
}

func TestMiniReelPlaybackCookieHeaderFiltersAccountCookies(t *testing.T) {
	got := miniReelPlaybackCookieHeader(map[string]string{
		"sessionid":        "private-account-cookie",
		"install_id":       "install",
		"ttreq":            "request",
		"store-region":     "cn-tj",
		"store-region-src": "did",
		"odin_tt":          "telemetry-only",
	})
	if strings.Contains(got, "sessionid") || strings.Contains(got, "odin_tt") {
		t.Fatalf("account cookies leaked into playback header: %q", got)
	}
	if got != "install_id=install; store-region=cn-tj; store-region-src=did; ttreq=request" {
		t.Fatalf("cookie header = %q", got)
	}
}

func TestMiniReelVideoTabBusinessErrorIsRetryable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"code":100103,"message":"PARAM_INVALID"}`)
	}))
	defer server.Close()

	_, err := miniReelVideoTabOptions(context.Background(), "123", server.URL+miniReelVideoTabPath, miniReelDevice{
		deviceID: "1234567890123456789", installID: "2234567890123456789", cdid: "00000000-0000-4000-8000-000000000001",
	}, "default")
	if !errors.Is(err, errMiniReelStreamMiss) {
		t.Fatalf("business error = %v, want retryable stream miss", err)
	}
	diagnostic := playbackPreparationDetails(err)
	if diagnostic.Code != "VIDEO_TAB_BUSINESS" || diagnostic.BusinessCode != "100103" {
		t.Fatalf("diagnostic = %+v", diagnostic)
	}
}

func TestMiniReelLiveVideoTabPlaybackSource(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_MINIREEL_TAB") != "1" {
		t.Skip("set HONGGUO_LIVE_MINIREEL_TAB=1 to verify the official video_tab playback endpoint")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	vid := os.Getenv("HONGGUO_LIVE_MINIREEL_VIDEO_ID")
	if vid == "" {
		vid = "7690963562042248217"
	}
	device, err := miniReelPlaybackIdentity.get(ctx)
	if err != nil {
		t.Fatalf("anonymous playback device registration failed: %v", err)
	}
	options, err := miniReelVideoTabOptions(ctx, vid, miniReelVideoTabBase+miniReelVideoTabPath, device, "default")
	if err != nil {
		t.Fatalf("video_tab playback source request failed: %v", err)
	}
	if len(options) == 0 {
		t.Fatal("video_tab response contained no playable quality")
	}
	for _, option := range options {
		if !strings.HasPrefix(option.URL, "https://") {
			t.Fatalf("video_tab returned a non-HTTPS source")
		}
	}
	if len(options[0].Key) != 16 {
		t.Fatal("video_tab source did not contain a valid CENC key")
	}
	source, err := openMiniReelRangeSource(ctx, options[0], vid)
	if err != nil {
		t.Fatalf("video_tab Range initialization failed: %v", err)
	}
	if source.Length <= 0 || len(source.Prefix) == 0 || len(source.Samples) == 0 {
		t.Fatalf("video_tab Range index incomplete: length=%d prefix=%d samples=%d", source.Length, len(source.Prefix), len(source.Samples))
	}
	first := source.Samples[0]
	frame, err := source.readAndTransform(ctx, int64(first.Offset), int64(first.Offset+first.Size-1))
	if err != nil {
		t.Fatalf("video_tab first CENC sample failed: %v", err)
	}
	if len(frame) != first.Size {
		t.Fatalf("video_tab first sample bytes = %d, want %d", len(frame), first.Size)
	}
	t.Logf("video_tab playback verified: quality=%q codec=%q size=%dx%d range_bytes=%d init_bytes=%d indexed_samples=%d first_sample_bytes=%d", options[0].Quality, options[0].Codec, options[0].Width, options[0].Height, source.Length, len(source.Prefix), len(source.Samples), len(frame))
}
