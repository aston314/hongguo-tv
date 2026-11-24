package jsresolver

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

func fixture(codec, vid string) map[string]any {
	return map[string]any{"video_id": vid, "video_duration": 90.5, "video_list": map[string]any{"q1080": map[string]any{"codec_type": codec, "main_url": "https://cdn.example/episode.mp4", "vwidth": 1920, "vheight": 1080, "definition": "1080P"}}}
}
func encoded(v any) resolverwire.HTTPResponse {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return resolverwire.HTTPResponse{Status: 200, Body: b}
}
func newTest(t *testing.T, do Transport) *Resolver {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r, e := New(ctx, Source(), do)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { r.Close(context.Background()) })
	return r
}
func noHTTP(context.Context, resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
	return resolverwire.HTTPResponse{}, errors.New("unexpected HTTP")
}

func TestJSResolverIndependentVectors(t *testing.T) {
	r := newTest(t, noHTTP)
	digest := sumSM3([]byte("abc"))
	if hex.EncodeToString(digest[:]) != "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0" {
		t.Fatal("standard SM3 vector mismatch")
	}
	metadata, e := r.Metadata(context.Background())
	if e != nil || !metadata.NativeSM3 || metadata.Version != Version {
		t.Fatal("script/host hash capability or version mismatch")
	}
	b, e := os.ReadFile("../playbackresolver/testdata/signing-v5-wire.json")
	if e != nil {
		t.Fatal(e)
	}
	n, e := r.SelfTest(context.Background(), b)
	if e != nil || n != 4 {
		t.Fatalf("vectors=%d error=%v", n, e)
	}
	var vector struct{ Plain, Ciphertext, Seed, DerivedKey string }
	b, e = os.ReadFile("../playbackresolver/testdata/passport-device-vector.json")
	if e != nil {
		t.Fatal(e)
	}
	json.Unmarshal(b, &vector)
	var actual string
	e = r.run(context.Background(), func() error {
		r.vm.Set("__test", r.api.Get("test"))
		r.vm.Set("__ciphertext", vector.Ciphertext)
		r.vm.Set("__seed", vector.Seed)
		v, e := r.vm.RunString(`JSON.stringify({plain:__test.device.ttDecrypt(Buffer.from(__ciphertext,'base64')).toString('utf8'),key:__test.device.deviceKey(Buffer.from(__seed,'hex')).toString('hex')})`)
		if e == nil {
			actual = v.String()
		}
		return e
	})
	if e != nil {
		t.Fatal(e)
	}
	var got map[string]string
	json.Unmarshal([]byte(actual), &got)
	if got["plain"] != vector.Plain {
		t.Fatal("independent TTDecrypt mismatch")
	}
	var raw map[string]string
	json.Unmarshal(b, &raw)
	if got["key"] != raw["derived_key"] {
		t.Fatal("independent SHA512 device-key mismatch")
	}
}

func TestJSResolverCancellationAndCapabilities(t *testing.T) {
	r := newTest(t, func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		<-ctx.Done()
		return resolverwire.HTTPResponse{}, ctx.Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, e := r.Resolve(ctx, resolverwire.Request{VID: "123"}); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatalf("cancellation=%v", e)
	}
	e := r.run(context.Background(), func() error {
		v, e := r.vm.RunString(`typeof require==='undefined'&&typeof process==='undefined'&&typeof __resolverHost.sign==='undefined'&&typeof __resolverHost.register==='undefined'&&typeof __resolverHost.resolve==='undefined'`)
		if e != nil {
			return e
		}
		if !v.ToBoolean() {
			return errors.New("native high-level capability leaked")
		}
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	ctx2, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer stop()
	if e = r.run(ctx2, func() error { _, e := r.vm.RunString(`for(;;){}`); return e }); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal("infinite JS not interrupted")
	}
	if e = r.run(context.Background(), func() error { _, e := r.vm.RunString(`1+1`); return e }); e != nil {
		t.Fatal("cancellation poisoned next call")
	}
	for _, u := range []string{"https://evil.example/x", "https://api.fqnovel.com@evil.example/x", "http://api.fqnovel.com/x", "https://api.fqnovel.com:444/x", "https://api.fqnovel.com/x#fragment"} {
		if ValidHTTPURL(u) {
			t.Fatal("untrusted URL accepted")
		}
	}
}
