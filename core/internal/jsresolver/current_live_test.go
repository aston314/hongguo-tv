package jsresolver

import (
	"context"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestCurrentJSLive(t *testing.T) {
	if os.Getenv("HONGGUO_CURRENT_LIVE") != "1" {
		t.Skip("opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	r, e := New(ctx, Source(), HTTPTransport(&http.Client{Timeout: 8 * time.Second}))
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close(ctx)
	start := time.Now()
	o, e := r.Resolve(ctx, resolverwire.Request{VID: "7706514815799282713", CodecMode: "default", ContentType: "1004"})
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("JS current: options=%d codec=%s quality=%s elapsed_ms=%d", len(o), o[0].Codec, o[0].Quality, time.Since(start).Milliseconds())
}
