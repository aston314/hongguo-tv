//go:build resolverjstest

package main

import (
	"context"
	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestJSPlaybackResolverLiveMedia(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_RESOLVER_JS") != "1" {
		t.Skip("live JS playback is opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	b := jsresolver.Source()
	if p := os.Getenv("HONGGUO_RESOLVER_JS_FILE"); p != "" {
		var e error
		b, e = os.ReadFile(p)
		if e != nil {
			t.Fatal(e)
		}
	}
	r, e := newJSPlaybackResolver(ctx, playbackResolverManifest{Version: jsresolver.Version, Protocol: 1}, b, http.DefaultClient)
	if e != nil {
		t.Fatal(e)
	}
	defer closePlaybackResolver(context.Background(), r)
	runPlaybackResolverLiveMedia(t, ctx, r)
}
