package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

// Exercise the public play/info contract, not just the resolver's internal map.
// Both foreground and prefetch clients must receive the selected codec.
func TestPlayInfoPreservesSelectedCodecThroughPublicAPI(t *testing.T) {
	s := &server{hongguo: newHongguoClient()}
	for _, mode := range []string{"range", "full"} {
		for _, codec := range []string{"h264", "bytevc1", ""} {
			t.Run(mode+"/"+codec, func(t *testing.T) {
				series, vid := "823456789001", "823456789002"
				token := miniReelCacheTokenWithCodec(series, vid, "", true, mode, "default")
				ready := make(chan struct{})
				close(ready)
				job := &miniReelMediaJob{Ready: ready, Accessed: time.Now(), Mode: mode, Quality: "720P", Qualities: []string{"720P"}, VideoWidth: 720, VideoHeight: 1280, VideoCodec: codec}
				miniReelState.Lock()
				miniReelState.jobs[token] = job
				miniReelState.Unlock()
				defer func() { miniReelState.Lock(); delete(miniReelState.jobs, token); miniReelState.Unlock() }()
				for _, extra := range []string{"", "&prefetch=1"} {
					r := httptest.NewRequest("GET", "http://127.0.0.1/api/v1/play/info?series_id="+series+"&vid="+vid+"&mode="+mode+"&fallback=1"+extra, nil)
					w := httptest.NewRecorder()
					s.playInfo(w, r)
					if w.Code != 200 {
						t.Fatal(w.Code, w.Body.String())
					}
					var response struct {
						OK   bool     `json:"ok"`
						Data PlayInfo `json:"data"`
					}
					if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
						t.Fatal(err)
					}
					if !response.OK || response.Data.VideoCodec != codec || response.Data.Path == "" || response.Data.VideoWidth != 720 {
						t.Fatalf("codec lost in %s: %s", mode, w.Body.String())
					}
				}
			})
		}
	}
}
