package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// Opt-in production directory -> resolver -> decrypted media check. Never log
// signed URLs, keys, account cookies or raw upstream payloads.
func TestSeriesDirectoryLivePlayback(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_SERIES_DIRECTORY") != "1" {
		t.Skip("live upstream/media verification is opt-in")
	}
	profile, err := newNativeProfileService(t.TempDir())
	if err != nil {
		t.Fatal("initialize builtin native profile")
	}
	previous := defaultNativeProfile.Swap(profile)
	defer func() { defaultNativeProfile.Store(previous); _ = profile.close(context.Background()) }()
	client := newHongguoClient()
	for _, tc := range []struct {
		series         string
		episode, total int
	}{
		{"7687919221593885758", 1, 76}, {"7687919221593885758", 4, 76},
		{"7704857878514895896", 153, 193}, {"7690163276214176792", 209, 209},
		{"7687919221593885758", 1, 76},
	} {
		t.Run(tc.series+"/"+strconv.Itoa(tc.episode), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
			defer cancel()
			detail, err := client.SeriesDetail(ctx, tc.series)
			if err != nil || len(detail.VidList) != tc.total || len(detail.Episodes) != tc.total {
				t.Fatalf("directory failed: %v count=%d", err, len(detail.VidList))
			}
			vid := detail.VidList[tc.episode-1]
			if tc.episode == 153 && vid != "7704857946630409240" {
				t.Fatal("known episode identity changed")
			}
			started := time.Now()
			options, err := miniReelNativeOptionsWithSources(ctx, vid, "default", "1004", miniReelProductionSources())
			if err != nil {
				d := playbackPreparationDetails(err)
				t.Fatalf("resolve failed stage=%s code=%s business=%s", d.Stage, d.Code, d.BusinessCode)
			}
			option, err := selectMiniReelQuality(options, "1080P", true)
			if err != nil {
				t.Fatal("no compatible media quality")
			}
			resolveMS := time.Since(started).Milliseconds()
			file := filepath.Join(t.TempDir(), "episode.mp4")
			if downloadMiniReelMedia(ctx, option.URL, file) != nil {
				t.Fatal("media download failed")
			}
			if len(option.Key) > 0 && decryptMiniReelMP4(file, option.Key) != nil {
				t.Fatal("media decryption failed")
			}
			info, err := os.Stat(file)
			if err != nil || info.Size() < 1024*1024 {
				t.Fatal("media did not reach 1 MiB")
			}
			raw, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height:format=duration,size", "-of", "json", file).Output()
			if err != nil {
				t.Fatal("media probe failed")
			}
			var media struct {
				Streams []struct {
					CodecName     string `json:"codec_name"`
					CodecType     string `json:"codec_type"`
					Width, Height int
				}
				Format map[string]string
			}
			if json.Unmarshal(raw, &media) != nil {
				t.Fatal("media metadata invalid")
			}
			video, audio := false, false
			var actualWidth, actualHeight int
			for _, s := range media.Streams {
				if s.CodecType == "video" && (s.CodecName == "hevc" || s.CodecName == "h264") {
					video = true
					actualWidth, actualHeight = s.Width, s.Height
				}
				if s.CodecType == "audio" {
					audio = true
				}
			}
			if !video || !audio {
				t.Fatal("missing compatible video or audio")
			}
			output, err := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-").CombinedOutput()
			if err != nil || len(bytes.TrimSpace(output)) != 0 {
				t.Fatal("full media decode failed")
			}
			t.Logf("directory=%d episode=%d vid=%s codec=%s resolution=%dx%d resolve_ms=%d bytes=%d duration=%s full_decode=true", tc.total, tc.episode, vid, option.Codec, actualWidth, actualHeight, resolveMS, info.Size(), media.Format["duration"])
		})
	}
}
