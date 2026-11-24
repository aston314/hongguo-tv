package jsresolver

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
	"io"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

const tabPath = "/reading/bookapi/video_tab/multi_video_model/v1/"

func regFixture(n int) resolverwire.HTTPResponse {
	r := encoded(map[string]any{"device_id_str": "1234567891234567", "install_id_str": "2345678912345678"})
	r.Cookies = map[string]string{"store-region": "cn-tj", "ttreq": "fixture", "sessionid": "never"}
	return r
}
func tabFixture(codec string) resolverwire.HTTPResponse {
	return encoded(map[string]any{"code": 0, "data": map[string]any{"video_model_data": map[string]any{"123": map[string]any{"video_model": fixture(codec, "media-video-id")}}}})
}
func TestProductionJSVideoTabFastPath(t *testing.T) {
	regs, gets, activations := 0, 0, 0
	r := newTest(t, func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		u, _ := url.Parse(in.URL)
		if u.Path == "/service/2/device_register/" {
			regs++
			return regFixture(regs), nil
		}
		if u.Path == "/service/2/app_alert_check/" {
			activations++
			deadline, bounded := ctx.Deadline()
			if in.Method != "GET" || u.Query().Get("device_id") != "1234567891234567" || !bounded || time.Until(deadline) > 3*time.Second {
				t.Fatal("activation profile or timeout")
			}
			return encoded(map[string]any{}), nil
		}
		if u.Path != tabPath || in.Method != "GET" {
			t.Fatalf("unexpected path %s", u.Path)
		}
		gets++
		for k, v := range map[string]string{"video_id": "123", "version_code": "74332", "device_level": "1", "need_all_video_definition": "1", "resolution": "1920*1080", "host_abi": "arm64-v8a", "os_api": "31", "rom_version": "V417IR+release-keys"} {
			if u.Query().Get(k) != v {
				t.Fatal("wrong tab query", k)
			}
		}
		if in.Headers["Cookie"] != "" || in.Headers["X-SS-STUB"] != "" || len(in.Body) != 0 {
			t.Fatal("official GET contains cookies, body or body digest header")
		}
		if in.Headers["X-Medusa"] == "" || in.Headers["X-Helios"] == "" || in.Headers["X-Khronos"] == "" {
			t.Fatal("missing official tab signature")
		}
		return tabFixture("h265"), nil
	})
	for i := 0; i < 2; i++ {
		o, e := r.Resolve(context.Background(), resolverwire.Request{VID: "123"})
		if e != nil || len(o) != 1 {
			t.Fatal(e)
		}
	}
	if regs != 1 || gets != 2 || activations != 1 {
		t.Fatal(regs, gets, activations)
	}
}
func TestProductionJSV5HostsReuseIdentity(t *testing.T) {
	var hosts, ids []string
	regs := 0
	r := newTest(t, func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		u, _ := url.Parse(in.URL)
		if u.Path == "/service/2/device_register/" {
			regs++
			return regFixture(regs), nil
		}
		if u.Path == "/service/2/app_alert_check/" {
			return encoded(map[string]any{}), nil
		}
		if u.Path == tabPath {
			return resolverwire.HTTPResponse{Status: 200}, nil
		}
		if in.Method != "POST" || u.Path != "/novel/player/multi_video_model/player/v1" {
			t.Fatal("unexpected fallback", u.Path)
		}
		hosts = append(hosts, u.Host)
		ids = append(ids, u.Query().Get("device_id"))
		if u.Query().Get("manifest_version_code") != "74332" || in.Headers["X-Medusa"] == "" {
			t.Fatal("v5 profile/signature")
		}
		zr, e := gzip.NewReader(bytes.NewReader(in.Body))
		if e != nil {
			t.Fatal(e)
		}
		b, _ := io.ReadAll(zr)
		zr.Close()
		var p map[string]any
		json.Unmarshal(b, &p)
		if p["biz_param"].(map[string]any)["device_level"] != float64(1) {
			t.Fatal("v5 device level")
		}
		if len(hosts) == 1 {
			return resolverwire.HTTPResponse{Status: 200}, nil
		}
		return encoded(map[string]any{"code": 0, "data": map[string]any{"1004": map[string]any{"123": map[string]any{"video_model": fixture("h265", "cdn-id")}}}}), nil
	})
	o, e := r.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	if e != nil || len(o) != 1 {
		t.Fatal(e)
	}
	if regs != 2 || len(hosts) != 2 || !strings.Contains(hosts[0], "sinfonlineb") || !strings.Contains(hosts[1], "sinfonlinea") || ids[0] != ids[1] {
		t.Fatal(regs, hosts, ids)
	}
}
func TestProductionJSRegisteredSingleFallback(t *testing.T) {
	var sequence []string
	r := newTest(t, func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		u, _ := url.Parse(in.URL)
		if u.Path == "/service/2/device_register/" {
			return regFixture(0), nil
		}
		if u.Path == "/service/2/app_alert_check/" {
			return encoded(map[string]any{}), nil
		}
		sequence = append(sequence, u.Path)
		if u.Path != "/novel/player/video_model/v1/" {
			return resolverwire.HTTPResponse{Status: 200}, nil
		}
		for _, h := range []string{"X-Argus", "X-Gorgon", "X-Ladon", "X-Khronos"} {
			if in.Headers[h] == "" {
				t.Fatal("single signature", h)
			}
		}
		sum := md5.Sum(in.Body)
		if in.Headers["X-SS-STUB"] != strings.ToUpper(hex.EncodeToString(sum[:])) {
			t.Fatal("body signature mismatch")
		}
		if in.Headers["Cookie"] != "" {
			t.Fatal("single cookie leak")
		}
		return encoded(map[string]any{"code": 0, "data": fixture("h264", "cdn-id")}), nil
	})
	o, e := r.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	if e != nil || len(o) != 1 {
		t.Fatal(e)
	}
	want := []string{tabPath, "/novel/player/multi_video_model/player/v1", "/novel/player/multi_video_model/player/v1", tabPath, "/novel/player/multi_video_model/v1/", "/novel/player/multi_video_model/v1/", "/novel/player/multi_video_model/v1/", "/novel/player/multi_video_model/v1/", "/novel/player/video_model/v1/"}
	if !reflect.DeepEqual(sequence, want) {
		t.Fatal(sequence)
	}
}
func TestProductionJSByteVC2Compatibility(t *testing.T) {
	var codecs []string
	r := newTest(t, func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		u, _ := url.Parse(in.URL)
		if u.Path == "/service/2/device_register/" {
			return regFixture(0), nil
		}
		if u.Path == "/fallback" {
			c := u.Query().Get("codec_type")
			codecs = append(codecs, c)
			if !strings.Contains(u.RawQuery, "signed=a%2Fb%2B") {
				t.Fatal("signature reencoded")
			}
			codec := "bytevc2"
			if c == "3" {
				codec = "h265"
			}
			return encoded(map[string]any{"code": 0, "video_info": map[string]any{"data": fixture(codec, "media-video-id")}}), nil
		}
		m := fixture("bytevc2", "media-video-id")
		m["fallback_api"] = "https://api.fqnovel.com/fallback?signed=a%2Fb%2B&codec_type=4"
		return encoded(map[string]any{"code": 0, "data": map[string]any{"video_model_data": map[string]any{"123": map[string]any{"video_model": m}}}}), nil
	})
	o, e := r.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	if e != nil || len(o) != 1 || o[0].Codec != "h265" {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(codecs, []string{"4", "1", "0", "3"}) {
		t.Fatal(codecs)
	}
}
func TestProductionJSCookieBoundary(t *testing.T) {
	for _, s := range []string{"sessionid=secret", "install_id=1; sessionid=x", "install_id=1\r\nx:y", "", "odin_tt=x"} {
		if validPlaybackCookieHeader(s) {
			t.Fatal("accepted", s)
		}
	}
	if !validPlaybackCookieHeader("install_id=123; ttreq=fixture; store-region=cn-tj") {
		t.Fatal("rejected anonymous cookie")
	}
}
