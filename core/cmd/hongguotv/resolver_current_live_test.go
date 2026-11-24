package main

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestCurrentProductionResolverLive(t *testing.T) {
	if os.Getenv("HONGGUO_CURRENT_LIVE") != "1" {
		t.Skip("opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	start := time.Now()
	opts, err := miniReelNativeOptionsWithSources(ctx, "7706514815799282713", "default", "1004", miniReelProductionSources())
	if err != nil {
		t.Fatal(err)
	}
	if len(opts) == 0 {
		t.Fatal("no source")
	}
	t.Logf("current production: options=%d codec=%s quality=%s elapsed_ms=%d", len(opts), opts[0].Codec, opts[0].Quality, time.Since(start).Milliseconds())
}
