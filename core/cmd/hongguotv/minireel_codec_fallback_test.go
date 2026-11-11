package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestMiniReelFallbackEncryptedURL(t *testing.T) {
	data, err := os.ReadFile("testdata/playback-url-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ Seed, Encoded, Plain string }
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	m := codecFallbackModel("h265", "id", 90)
	m["key_seed"] = v.Seed
	row := m["video_list"].([]any)[0].(map[string]any)
	row["main_url"] = v.Encoded
	options := miniReelOptionsFromModel(m)
	if len(options) != 1 || options[0].URL != v.Plain || len(options[0].Key) != 0 {
		t.Fatal("URL decryption changed media encryption contract")
	}
	row["encrypt"] = true
	if len(miniReelOptionsFromModel(m)) != 0 {
		t.Fatal("encrypted media without content key was accepted")
	}
	delete(row, "encrypt")
	for _, invalid := range []string{"", "!bad", v.Encoded[:len(v.Encoded)-8], base64.StdEncoding.EncodeToString(make([]byte, 20))} {
		row["main_url"] = invalid
		if len(miniReelOptionsFromModel(m)) != 0 {
			t.Fatal("malformed encrypted URL accepted")
		}
	}
	delete(m, "key_seed")
	for _, raw := range []string{v.Plain, base64.StdEncoding.EncodeToString([]byte(v.Plain)), base64.RawStdEncoding.EncodeToString([]byte(v.Plain))} {
		if miniReelModelURL(raw, m) != v.Plain {
			t.Fatal("existing URL encoding regressed")
		}
	}
}

func codecFallbackModel(codec, id string, duration float64) map[string]any {
	return map[string]any{"video_id": id, "video_duration": duration, "video_list": []any{map[string]any{"codec_type": codec, "main_url": "https://media.example.test/episode.mp4", "vheight": 1080}}}
}

func TestMiniReelCompatibleFallbackOrderAndIdentity(t *testing.T) {
	for _, mode := range []string{"inline", "mixed", "original", "hevc", "h264", "bytevc1", "mismatch-id", "mismatch-duration", "unusable", "all-bytevc2", "original-error", "original-mismatch", "codec3-error", "cancel", "cancel-codec3"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			model := codecFallbackModel("bytevc2", "same-video", 90)
			raw := "https://api.fqnovel.com/playback/fallback?sig=a%2fb%2BC&same=1&same=2&codec_type=4&force_codec=old&token=x%3D"
			model["fallback_api"] = raw
			if mode == "inline" {
				model = codecFallbackModel("h265", "same-video", 90)
				model["fallback_api"] = raw
			}
			if mode == "mixed" {
				model["video_list"] = append(model["video_list"].([]any), codecFallbackModel("h264", "same-video", 90)["video_list"].([]any)...)
			}
			calls := 0
			successAt := map[string]int{"original": 1, "hevc": 2, "h264": 3, "bytevc1": 4, "mismatch-id": 2, "mismatch-duration": 2, "unusable": 2}[mode]
			client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
				calls++
				if mode == "original-error" {
					return nil, errors.New("upstream temporarily unavailable")
				}
				if r.Header.Get("Cookie") != "" || r.Header.Get("X-Argus") != "" {
					t.Error("fallback leaked identity or signature headers")
				}
				want := raw
				if calls == 2 {
					want = "https://api.fqnovel.com/playback/fallback?sig=a%2fb%2BC&same=1&same=2&token=x%3D&codec_type=1"
				}
				if calls == 3 {
					want = "https://api.fqnovel.com/playback/fallback?sig=a%2fb%2BC&same=1&same=2&token=x%3D&codec_type=0&force_codec=h264"
				}
				if calls == 4 {
					want = "https://api.fqnovel.com/playback/fallback?sig=a%2fb%2BC&same=1&same=2&token=x%3D&codec_type=3"
				}
				if r.URL.String() != want {
					t.Errorf("signed raw query changed: %s", r.URL.RawQuery)
				}
				candidate := codecFallbackModel("bvc2", "same-video", 90)
				if mode == "original-mismatch" {
					candidate["video_id"] = "other-video"
				}
				if mode == "cancel" || mode == "cancel-codec3" && calls == 4 {
					cancel()
					return nil, context.Canceled
				}
				if mode == "codec3-error" && calls == 4 {
					return nil, errors.New("upstream temporarily unavailable")
				}
				if calls == successAt {
					candidate = codecFallbackModel("h265", "same-video", 90)
					if mode == "bytevc1" {
						candidate["video_list"].([]any)[0].(map[string]any)["codec_type"] = "bytevc1"
					}
				}
				if calls >= 2 && mode == "mismatch-id" {
					candidate["video_id"] = "other-video"
				}
				if calls >= 2 && mode == "mismatch-duration" {
					candidate["video_duration"] = 91
				}
				if calls >= 2 && mode == "unusable" {
					candidate["video_list"].([]any)[0].(map[string]any)["main_url"] = "not-a-url"
				}
				b, _ := json.Marshal(map[string]any{"code": 0, "video_info": map[string]any{"code": 0, "data": candidate}})
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(b))), Request: r}, nil
			})}
			envelope := map[string]any{"data": map[string]any{"123": map[string]any{"video_model": model}}}
			opts, err := miniReelOptionsFromEnvelope(ctx, "123", envelope, client, "default", &playbackPreparationDiagnostic{})
			wantCalls := 4
			switch mode {
			case "inline", "mixed":
				wantCalls = 0
			case "original", "original-error", "original-mismatch", "cancel":
				wantCalls = 1
			case "hevc":
				wantCalls = 2
			case "h264":
				wantCalls = 3
			}
			if calls != wantCalls {
				t.Fatalf("calls=%d want=%d", calls, wantCalls)
			}
			if mode == "cancel" || mode == "cancel-codec3" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation lost: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			wantOptions := 1
			if strings.HasPrefix(mode, "mismatch") || mode == "all-bytevc2" || mode == "unusable" || mode == "original-error" || mode == "original-mismatch" || mode == "codec3-error" {
				wantOptions = 0
			}
			if len(opts) != wantOptions {
				t.Fatalf("options=%d want=%d", len(opts), wantOptions)
			}
		})
	}
}

func TestMiniReelCompatibleFallbackMetadataBounds(t *testing.T) {
	base := codecFallbackModel("bytevc2", "id", 90)
	for _, d := range []float64{89.5, 90.5, 0} {
		if !miniReelSameFallbackVideo(base, codecFallbackModel("h264", "id", d)) {
			t.Fatal("rejected duration boundary or absent duration")
		}
	}
	if miniReelSameFallbackVideo(base, codecFallbackModel("h264", "id", 90.501)) {
		t.Fatal("accepted duration mismatch")
	}
	raw := "https://api.fqnovel.com/x?s=a%2Fb&%63odec_type=4&force_codec=x&&s=c+d"
	got := miniReelFallbackCodecURL(raw, "codec_type=1")
	if got != "https://api.fqnovel.com/x?s=a%2Fb&&s=c+d&codec_type=1" {
		t.Fatalf("raw query: %s", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	base["fallback_api"] = "https://api.fqnovel.com/x"
	_, err := miniReelCompatibleModel(ctx, base, &http.Client{Transport: miniReelTestRoundTripper(func(*http.Request) (*http.Response, error) { t.Fatal("request after cancel"); return nil, nil })})
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	_, err = miniReelFetchFallbackModelWithClient(context.Background(), "https://api.fqnovel.com/x?secret=private", &http.Client{Transport: miniReelTestRoundTripper(func(*http.Request) (*http.Response, error) {
		return nil, &url.Error{Op: "Get", URL: "https://api.fqnovel.com/x?secret=private", Err: context.DeadlineExceeded}
	})})
	if err == nil || !errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "private") {
		t.Fatal("transport classification/privacy failed")
	}
}

func TestMiniReelCompatibleFallbackBusinessRejectionStops(t *testing.T) {
	for _, rejectedAttempt := range []int{1, 2, 3, 4} {
		model := codecFallbackModel("bytevc2", "id", 90)
		model["fallback_api"] = "https://api.fqnovel.com/playback/fallback?codec_type=4"
		calls := 0
		client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
			calls++
			var payload any = map[string]any{"code": 0, "video_info": map[string]any{"code": 0, "data": model}}
			if calls == rejectedAttempt {
				payload = map[string]any{"code": 0, "video_info": map[string]any{"code": 110001}}
			}
			body, _ := json.Marshal(payload)
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body))), Request: r}, nil
		})}
		_, err := miniReelCompatibleModel(context.Background(), model, client)
		if err == nil || playbackPreparationDetails(err).BusinessCode != "110001" || calls != rejectedAttempt {
			t.Fatalf("business rejection lost or retried: calls=%d err=%v", calls, err)
		}
	}
}
