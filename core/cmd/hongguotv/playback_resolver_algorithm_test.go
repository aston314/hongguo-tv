package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Compile with scripts/build_playback_resolver.sh, then set this path. Unlike
// fixedPlaybackResolverWASM, this executes the real registration and V5 signer.
func TestWASMPlaybackResolverRealAlgorithm(t *testing.T) {
	artifact := os.Getenv("HONGGUO_RESOLVER_WASM_FILE")
	if artifact == "" {
		t.Skip("compiled algorithm not supplied")
	}
	registered, models := 0, 0
	client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
		var body []byte
		if r.URL.Path == "/service/2/device_register/" {
			registered++
			if r.URL.Hostname() != "log.snssdk.com" || r.Header.Get("X-Gorgon") == "" {
				t.Error("registration was not signed in guest")
			}
			body = []byte(`{"device_id_str":"1234567891234567","install_id_str":"2345678912345678"}`)
		} else if r.URL.Path == "/novel/player/multi_video_model/player/v1" {
			models++
			if r.Header.Get("X-Medusa") == "" || r.Header.Get("X-Helios") == "" || r.Header.Get("X-Khronos") == "" || r.Header.Get("Cookie") != "" {
				t.Error("V5 signature missing or account header leaked")
			}
			body, _ = json.Marshal(map[string]any{"code": 0, "data": map[string]any{"7706514645208534041": map[string]any{"video_model": codecFallbackModel("h265", "7706514645208534041", 90)}}})
		} else {
			t.Errorf("unexpected request path %s", r.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resolver, err := loadWASMPlaybackResolverWithHTTP(ctx, playbackResolverManifest{Version: "2026.11.19.1", Protocol: 1}, artifact, client)
	if err != nil {
		t.Fatal(err)
	}
	defer closePlaybackResolver(context.Background(), resolver)
	for i := 0; i < 2; i++ {
		options, err := resolver.Resolve(ctx, playbackResolverRequest{VID: "7706514645208534041", CodecMode: "default", ContentType: "1004"})
		if err != nil || len(options) == 0 {
			t.Fatalf("real algorithm round %d error=%v options=%d", i, err, len(options))
		}
		if options[0].Codec != "h265" {
			t.Fatalf("codec=%s", options[0].Codec)
		}
	}
	if registered != 1 || models != 2 {
		t.Fatalf("guest identity cache registrations=%d model_requests=%d", registered, models)
	}
}

func TestWASMPlaybackResolverRealEmptyAndByteVC2Recovery(t *testing.T) {
	artifact := os.Getenv("HONGGUO_RESOLVER_WASM_FILE")
	if artifact == "" {
		t.Skip("compiled algorithm not supplied")
	}
	registered, models := 0, 0
	var codecs []string
	vid := "7702841946812714008"
	client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
		var body []byte
		switch r.URL.Path {
		case "/service/2/device_register/":
			registered++
			body = []byte(`{"device_id_str":"1234567891234567","install_id_str":"2345678912345678"}`)
		case "/novel/player/multi_video_model/player/v1":
			models++
			if models == 1 {
				break
			} // Confirmed empty 200 must register again inside WASM.
			model := codecFallbackModel("bytevc2", vid, 90)
			model["fallback_api"] = "https://api.fqnovel.com/fallback?codec_type=4"
			body, _ = json.Marshal(map[string]any{"code": 0, "data": map[string]any{vid: map[string]any{"video_model": model}}})
		case "/fallback":
			codec := r.URL.Query().Get("codec_type")
			codecs = append(codecs, codec)
			model := codecFallbackModel("bytevc2", vid, 90)
			if codec == "1" {
				model = codecFallbackModel("h265", vid, 90)
			}
			body, _ = json.Marshal(map[string]any{"code": 0, "video_info": map[string]any{"code": 0, "data": model}})
		default:
			t.Error("unexpected guest route")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resolver, err := loadWASMPlaybackResolverWithHTTP(ctx, playbackResolverManifest{Version: "2026.11.19.1", Protocol: 1}, artifact, client)
	if err != nil {
		t.Fatal(err)
	}
	defer closePlaybackResolver(context.Background(), resolver)
	options, err := resolver.Resolve(ctx, playbackResolverRequest{VID: vid, CodecMode: "default", ContentType: "1004"})
	if err != nil || len(options) != 1 || options[0].Codec != "h265" {
		t.Fatalf("guest recovery options=%d err=%v", len(options), err)
	}
	if registered != 2 || models != 2 || !reflect.DeepEqual(codecs, []string{"4", "1"}) {
		t.Fatalf("registered=%d models=%d fallback_codecs=%v", registered, models, codecs)
	}
}
