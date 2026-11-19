package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestWASMPlaybackResolverWireParity(t *testing.T) {
	paths := []string{os.Getenv("HONGGUO_RESOLVER_REFERENCE_FILE"), os.Getenv("HONGGUO_RESOLVER_WASM_FILE")}
	if paths[0] == "" || paths[1] == "" {
		t.Skip("two real modules required")
	}
	type captured struct {
		query   url.Values
		headers http.Header
		body    []byte
	}
	captures := make([]map[string]captured, 2)
	for i, artifact := range paths {
		captures[i] = map[string]captured{}
		client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
			body, _ := io.ReadAll(r.Body)
			captures[i][r.URL.Path] = captured{r.URL.Query(), r.Header.Clone(), body}
			result := []byte(`{"device_id_str":"1234567891234567","install_id_str":"2345678912345678"}`)
			if r.URL.Path != "/service/2/device_register/" {
				result, _ = json.Marshal(map[string]any{"code": 0, "data": map[string]any{"7702841946812714008": map[string]any{"video_model": codecFallbackModel("h265", "7702841946812714008", 90)}}})
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(result))}, nil
		})}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		resolver, err := loadWASMPlaybackResolverWithHTTP(ctx, playbackResolverManifest{Version: "2026.11.19.1", Protocol: 1}, artifact, client)
		if err != nil {
			t.Fatal(err)
		}
		_, err = resolver.Resolve(ctx, playbackResolverRequest{VID: "7702841946812714008", CodecMode: "default", ContentType: "1004"})
		closePlaybackResolver(context.Background(), resolver)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"/service/2/device_register/", "/novel/player/multi_video_model/player/v1"} {
		a, b := captures[0][path], captures[1][path]
		for _, key := range []string{"ts", "_rticket", "cdid", "openudid"} {
			a.query.Del(key)
			b.query.Del(key)
		}
		if !reflect.DeepEqual(a.query, b.query) {
			t.Errorf("query profile differs: %s", path)
		}
		for _, key := range []string{"User-Agent", "Content-Type", "Content-Encoding", "Accept", "X-SS-DP", "Passport-Sdk-Version", "Lc", "Sdk-Version", "X-Tt-Store-Region", "X-Tt-Request-Tag"} {
			if a.headers.Get(key) != b.headers.Get(key) {
				t.Errorf("header %s differs at %s", key, path)
			}
		}
		for _, request := range []captured{a, b} {
			digest := md5.Sum(request.body)
			if !strings.EqualFold(request.headers.Get("X-SS-STUB"), hex.EncodeToString(digest[:])) {
				t.Errorf("stub does not cover exact outbound body at %s", path)
			}
		}
		if path == "/service/2/device_register/" {
			var decoded [2]map[string]any
			for i, data := range [][]byte{a.body, b.body} {
				plain, err := passportTTDecrypt(data)
				if err != nil {
					t.Fatal(err)
				}
				json.Unmarshal(plain, &decoded[i])
				delete(decoded[i], "_gen_time")
				header := decoded[i]["header"].(map[string]any)
				for _, key := range []string{"cdid", "clientudid", "openudid", "apk_first_install_time"} {
					delete(header, key)
				}
			}
			if !reflect.DeepEqual(decoded[0], decoded[1]) {
				t.Error("registration profile differs")
			}
		} else {
			// Go versions may choose different valid DEFLATE blocks. Require the
			// same JSON payload and a stub matching each exact compressed body.
			var payloads [2]any
			for i, body := range [][]byte{a.body, b.body} {
				reader, err := gzip.NewReader(bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				if json.NewDecoder(reader).Decode(&payloads[i]) != nil {
					t.Fatal("invalid compressed JSON")
				}
				reader.Close()
			}
			if !reflect.DeepEqual(payloads[0], payloads[1]) {
				t.Error("V5 JSON request payload changed")
			}
		}
	}
}
