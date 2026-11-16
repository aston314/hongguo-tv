package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Explicit live check of this implementation, including our unchanged codec
// fallback, complete media decryption and full audio/video decode. No raw model,
// signed URL, identity or content key is ever printed or persisted.
func TestMiniReelMobileV5LiveMedia(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_MOBILE_V5") != "1" {
		t.Skip("live upstream verification is opt-in")
	}
	ids := []string{"7706514645208534041", "7706514815799282713", "7706514627462433817", "7702841946812714008", "7702841953875938328", "7703473857562151961"}
	if value := os.Getenv("HONGGUO_LIVE_MINIREEL_VIDEO_ID"); value != "" {
		ids = strings.Split(value, ",")
	}
	for _, id := range ids {
		t.Run(id, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			onlyByteVC2 := false
			var codecs []string
			client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
				res, err := http.DefaultTransport.RoundTrip(r)
				if err != nil {
					return res, err
				}
				if r.URL.Path == "/novel/player/multi_video_model/player/v1" {
					raw, e := miniReelReadLimited(res.Body, miniReelMobileV5MaxJSON)
					res.Body.Close()
					if e != nil {
						return nil, e
					}
					res.Body = io.NopCloser(bytes.NewReader(raw))
					var root map[string]any
					if json.Unmarshal(raw, &root) == nil {
						value := nestedMiniReelValue(root, "data", id, "video_model")
						if value == nil {
							value = nestedMiniReelValue(root, "data", "1004", id, "video_model")
						}
						var model map[string]any
						switch v := value.(type) {
						case map[string]any:
							model = v
						case string:
							json.Unmarshal([]byte(v), &model)
						}
						onlyByteVC2 = miniReelOnlyByteVC2(model)
					}
				} else {
					codecs = append(codecs, r.URL.Query().Get("codec_type"))
				}
				return res, nil
			})}
			source := *productionMobileV5
			source.client = client
			start := time.Now()
			resolveCtx, stop := context.WithTimeout(ctx, 8*time.Second)
			options, err := source.options(resolveCtx, id, "default", "1004")
			stop()
			if err != nil {
				d := playbackPreparationDetails(err)
				t.Fatalf("model failed stage=%s code=%s business=%s", d.Stage, d.Code, d.BusinessCode)
			}
			resolveMS := time.Since(start).Milliseconds()
			option, err := selectMiniReelQuality(options, "1080P", true)
			if err != nil {
				t.Fatal("no compatible quality")
			}
			file := filepath.Join(t.TempDir(), "episode.mp4")
			if downloadMiniReelMedia(ctx, option.URL, file) != nil {
				t.Fatal("full media download failed")
			}
			if len(option.Key) > 0 && decryptMiniReelMP4(file, option.Key) != nil {
				t.Fatal("full media decrypt failed")
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
			hevc, audio := false, false
			for _, s := range media.Streams {
				if s.CodecType == "video" && s.CodecName == "hevc" {
					hevc = true
				}
				if s.CodecType == "audio" {
					audio = true
				}
			}
			if !hevc || !audio {
				t.Fatal("expected HEVC video and audio")
			}
			decoded, err := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-").CombinedOutput()
			if err != nil || len(bytes.TrimSpace(decoded)) != 0 {
				t.Fatal("full audio/video decode failed")
			}
			t.Logf("only_bytevc2=%t fallback_codecs=%v selected=%s %dx%d resolve_ms=%d duration=%s bytes=%s full_decode=true", onlyByteVC2, codecs, option.Codec, option.Width, option.Height, resolveMS, media.Format["duration"], media.Format["size"])
		})
	}
}
