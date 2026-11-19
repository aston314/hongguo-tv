package jsresolver

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"reflect"
	"strings"
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

func TestJSResolverSignsAndCachesAnonymousIdentity(t *testing.T) {
	registered, models := 0, 0
	r := newTest(t, func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		u, _ := url.Parse(in.URL)
		if _, ok := in.Headers["Cookie"]; ok {
			t.Fatal("account cookie crossed boundary")
		}
		if u.Path == "/service/2/device_register/" {
			registered++
			if !bytes.HasPrefix(in.Body, []byte{0x74, 0x63, 5, 0x10, 0, 0}) || in.Headers["X-Gorgon"] == "" {
				t.Fatal("missing JS registration/signature")
			}
			return encoded(map[string]any{"device_id_str": "7390000000000000001", "install_id_str": "7390000000000000002"}), nil
		}
		models++
		if in.Headers["X-Medusa"] == "" || in.Headers["X-Helios"] == "" {
			t.Fatal("JS V5 signature missing")
		}
		sum := md5.Sum(in.Body)
		if in.Headers["X-SS-STUB"] != strings.ToUpper(hex.EncodeToString(sum[:])) {
			t.Fatal("signature body differs")
		}
		zr, e := gzip.NewReader(bytes.NewReader(in.Body))
		if e != nil {
			t.Fatal(e)
		}
		plain, _ := io.ReadAll(zr)
		zr.Close()
		if !bytes.Contains(plain, []byte(`"123"`)) {
			t.Fatal("VID not bound to payload")
		}
		return encoded(map[string]any{"code": 0, "data": map[string]any{"123": map[string]any{"video_model": fixture("h265", "123")}}}), nil
	})
	for i := 0; i < 2; i++ {
		opts, e := r.Resolve(context.Background(), resolverwire.Request{VID: "123"})
		if e != nil || len(opts) != 1 || opts[0].Codec != "h265" || opts[0].Duration != 90 {
			t.Fatalf("options=%d error=%v", len(opts), e)
		}
	}
	if registered != 1 || models != 2 {
		t.Fatalf("registrations=%d models=%d", registered, models)
	}
}

func TestJSResolverEmptyRefreshAndCompatibleCodec(t *testing.T) {
	registered, models := 0, 0
	var codecs []string
	r := newTest(t, func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		u, _ := url.Parse(in.URL)
		if u.Path == "/service/2/device_register/" {
			registered++
			return encoded(map[string]any{"device_id_str": "7390000000000000001", "install_id_str": "7390000000000000002"}), nil
		}
		if u.Path == "/fallback" {
			codec := u.Query().Get("codec_type")
			codecs = append(codecs, codec)
			if !strings.Contains(u.RawQuery, "signed=a%2Fb%2B") {
				t.Fatal("signed raw query was re-encoded")
			}
			c := "bytevc2"
			if codec == "3" {
				c = "h265"
			}
			return encoded(map[string]any{"code": 0, "video_info": map[string]any{"code": 0, "data": fixture(c, "123")}}), nil
		}
		models++
		if models == 1 {
			return resolverwire.HTTPResponse{Status: 200}, nil
		}
		m := fixture("bytevc2", "123")
		m["fallback_api"] = "https://api.fqnovel.com/fallback?signed=a%2Fb%2B&codec_type=4"
		return encoded(map[string]any{"code": 0, "data": map[string]any{"1004": map[string]any{"123": map[string]any{"video_model": m}}}}), nil
	})
	opts, e := r.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	if e != nil || len(opts) != 1 || opts[0].Codec != "h265" {
		t.Fatalf("options=%d error=%v", len(opts), e)
	}
	if registered != 2 || models != 2 || !reflect.DeepEqual(codecs, []string{"4", "1", "0", "3"}) {
		t.Fatalf("registrations=%d models=%d codecs=%v", registered, models, codecs)
	}
}

func TestJSResolverRejectsWrongEpisodeAndBusinessErrors(t *testing.T) {
	for _, kind := range []string{"missing", "business", "wrong-fallback"} {
		t.Run(kind, func(t *testing.T) {
			r := newTest(t, func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
				u, _ := url.Parse(in.URL)
				if u.Path == "/service/2/device_register/" {
					return encoded(map[string]any{"device_id_str": "123", "install_id_str": "456"}), nil
				}
				if kind == "business" {
					return encoded(map[string]any{"code": 42}), nil
				}
				if kind == "missing" {
					return encoded(map[string]any{"code": 0, "data": map[string]any{"456": map[string]any{"video_model": fixture("h265", "456")}}}), nil
				}
				if u.Path == "/fallback" {
					return encoded(map[string]any{"code": 0, "video_info": map[string]any{"data": fixture("h265", "456")}}), nil
				}
				m := fixture("bytevc2", "123")
				m["fallback_api"] = "https://api.fqnovel.com/fallback"
				return encoded(map[string]any{"code": 0, "data": map[string]any{"123": map[string]any{"video_model": m}}}), nil
			})
			opts, e := r.Resolve(context.Background(), resolverwire.Request{VID: "123"})
			var detail *Error
			expected := map[string]string{"missing": "VIDEO_MODEL_MISSING", "business": "VIDEO_MODEL_BUSINESS", "wrong-fallback": "VIDEO_MODEL_LIST_EMPTY"}[kind]
			if !errors.As(e, &detail) || detail.Code != expected || len(opts) > 0 {
				t.Fatalf("expected %s; error=%v", expected, e)
			}
		})
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
