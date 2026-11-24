//go:build resolverjstest

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

func TestJSResolverRegistrationWireParity(t *testing.T) {
	seen := false
	client := &http.Client{Transport: miniReelTestRoundTripper(func(in *http.Request) (*http.Response, error) {
		if in.URL.Path == "/service/2/device_register/" {
			seen = true
			if in.URL.RawQuery != in.URL.Query().Encode() {
				t.Error("JS registration query does not match native canonical encoding")
			}
			body, _ := io.ReadAll(in.Body)
			plain, e := passportTTDecrypt(body)
			if e != nil {
				t.Fatal("JS registration body cannot be decrypted by native implementation")
			}
			var actual map[string]any
			if json.Unmarshal(plain, &actual) != nil {
				t.Fatal("invalid registration JSON")
			}
			h := actual["header"].(map[string]any)
			d := &passportDevice{CDID: h["cdid"].(string), ClientUDID: h["clientudid"].(string), OpenUDID: h["openudid"].(string), Created: int64(h["apk_first_install_time"].(float64))}
			var expected map[string]any
			json.Unmarshal(d.payload(int64(actual["_gen_time"].(float64))), &expected)
			if !reflect.DeepEqual(actual, expected) {
				t.Error("JS registration device profile differs from native")
			}
			stamp, _ := strconv.ParseInt(in.URL.Query().Get("_rticket"), 10, 64)
			if delta := time.Now().UnixMilli() - stamp; delta < -5000 || delta > 5000 {
				t.Error("JS registration clock skew")
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewBufferString(`{"device_id_str":"123","install_id_str":"456"}`))}, nil
		}
		body, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"123": map[string]any{"video_model": codecFallbackModel("h265", "123", 90)}}})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body))}, nil
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r, e := jsresolver.New(ctx, jsresolver.Source(), jsresolver.HTTPTransport(client))
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close(context.Background())
	if _, e = r.Resolve(ctx, resolverwire.Request{VID: "123"}); e != nil {
		t.Fatal(e)
	}
	if !seen {
		t.Fatal("registration not executed")
	}
}
