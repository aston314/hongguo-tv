package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestWASMPlaybackResolverLiveMedia(t *testing.T) {
	artifact := os.Getenv("HONGGUO_RESOLVER_WASM_FILE")
	if artifact == "" || os.Getenv("HONGGUO_LIVE_RESOLVER_WASM") != "1" {
		t.Skip("live WASM verification is opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	client := http.DefaultClient
	if os.Getenv("HONGGUO_RESOLVER_TRACE_TIMING") == "1" {
		var registered time.Time
		client = &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
			if r.URL.Path == "/novel/player/multi_video_model/player/v1" {
				ts, _ := strconv.ParseInt(r.Header.Get("X-Khronos"), 10, 64)
				ticket, _ := strconv.ParseInt(r.URL.Query().Get("_rticket"), 10, 64)
				t.Logf("request registration_gap_ms=%d header_skew_ms=%d ticket_skew_ms=%d", time.Since(registered).Milliseconds(), time.Now().UnixMilli()-ts*1000, time.Now().UnixMilli()-ticket)
			}
			res, err := http.DefaultTransport.RoundTrip(r)
			if r.URL.Path == "/service/2/device_register/" {
				registered = time.Now()
			}
			return res, err
		})}
	}
	if delay, _ := strconv.Atoi(os.Getenv("HONGGUO_RESOLVER_REGISTRATION_DELAY_MS")); delay > 0 && delay <= 3000 {
		client = &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
			res, err := http.DefaultTransport.RoundTrip(r)
			if err == nil && r.URL.Path == "/service/2/device_register/" {
				time.Sleep(time.Duration(delay) * time.Millisecond)
			}
			return res, err
		})}
	}
	resolver, err := loadWASMPlaybackResolverWithHTTP(ctx, playbackResolverManifest{Version: "2026.11.19.1", Protocol: 1}, artifact, client)
	if err != nil {
		t.Fatal(err)
	}
	defer closePlaybackResolver(context.Background(), resolver)
	ids := []string{"7706514645208534041", "7706514815799282713", "7706514627462433817", "7702841946812714008", "7702841953875938328", "7703473857562151961"}
	if raw := os.Getenv("HONGGUO_LIVE_MINIREEL_VIDEO_ID"); raw != "" {
		ids = strings.Split(raw, ",")
	}
	for _, vid := range ids {
		t.Run(vid, func(t *testing.T) {
			start := time.Now()
			resolveCtx, stop := context.WithTimeout(ctx, 25*time.Second)
			options, err := resolver.Resolve(resolveCtx, playbackResolverRequest{VID: vid, CodecMode: "default", ContentType: "1004"})
			stop()
			if err != nil {
				d := playbackPreparationDetails(err)
				t.Fatalf("WASM model stage=%s code=%s", d.Stage, d.Code)
			}
			resolveMS := time.Since(start).Milliseconds()
			option, err := selectMiniReelQuality(options, "1080P", true)
			if err != nil {
				t.Fatal("no compatible quality")
			}
			file := filepath.Join(t.TempDir(), "episode.mp4")
			if downloadMiniReelMedia(ctx, option.URL, file) != nil {
				t.Fatal("media download failed")
			}
			if len(option.Key) > 0 && decryptMiniReelMP4(file, option.Key) != nil {
				t.Fatal("media decryption failed")
			}
			probe, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height:format=duration,size", "-of", "json", file).Output()
			if err != nil {
				t.Fatal("ffprobe failed")
			}
			var media struct {
				Streams []struct {
					CodecName     string `json:"codec_name"`
					CodecType     string `json:"codec_type"`
					Width, Height int
				}
				Format map[string]string
			}
			if json.Unmarshal(probe, &media) != nil {
				t.Fatal("invalid media metadata")
			}
			video, audio := false, false
			for _, s := range media.Streams {
				if s.CodecType == "video" && (s.CodecName == "hevc" || s.CodecName == "h264") {
					video = true
				}
				if s.CodecType == "audio" {
					audio = true
				}
			}
			if !video || !audio {
				t.Fatal("no compatible video/audio")
			}
			if exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", file, "-t", "8", "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-").Run() != nil {
				t.Fatal("audio/video decode failed")
			}
			t.Logf("resolver=wasm-only options=%d codec=%s model_dimensions=%dx%d resolve_ms=%d bytes=%s duration=%s decoded_seconds=8", len(options), option.Codec, option.Width, option.Height, resolveMS, media.Format["size"], media.Format["duration"])
		})
	}
}
