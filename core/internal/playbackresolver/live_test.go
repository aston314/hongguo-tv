package playbackresolver

import (
	"bytes"
	"context"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestStandaloneNativeLive(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_STANDALONE") != "1" {
		t.Skip("live opt-in")
	}
	r := New(func(ctx context.Context, input resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		req, err := http.NewRequestWithContext(ctx, input.Method, input.URL, bytes.NewReader(input.Body))
		if err != nil {
			return resolverwire.HTTPResponse{}, err
		}
		for k, v := range input.Headers {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return resolverwire.HTTPResponse{}, err
		}
		defer res.Body.Close()
		body, err := io.ReadAll(io.LimitReader(res.Body, resolverwire.MaxHTTPBody))
		return resolverwire.HTTPResponse{Status: res.StatusCode, Body: body}, err
	})
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	options, err := r.Resolve(ctx, resolverwire.Request{VID: "7702841946812714008", CodecMode: "default", ContentType: "1004"})
	if err != nil || len(options) == 0 {
		t.Fatalf("native standalone options=%d err=%v", len(options), err)
	}
	t.Logf("options=%d codec=%s", len(options), options[0].Codec)
}
