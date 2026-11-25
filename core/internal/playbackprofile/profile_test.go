package playbackprofile

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestBaselineAndIndependentKotlinVectors(t *testing.T) {
	p, e := Parse(Builtin())
	if e != nil {
		t.Fatal(e)
	}
	var rows []struct {
		Values                map[string]string `json:"values"`
		Stamp                 int64             `json:"stamp"`
		TS                    uint32            `json:"ts"`
		Query, Medusa, Helios string
	}
	b, e := os.ReadFile("../jsresolver/testdata/signing-v5-official.json")
	if e != nil {
		t.Fatal(e)
	}
	if json.Unmarshal(b, &rows) != nil {
		t.Fatal("invalid vectors")
	}
	for _, r := range rows {
		stamp := r.Stamp
		if stamp == 0 {
			stamp = int64(r.TS) * 1000
		}
		pairs := p.Query(map[string]string{"device_id": "123", "iid": "456", "cdid": "synthetic", "klink_egdi": "synthetic+egdi"}, "123", true)
		// Vectors use the production query exactly, including its original key order.
		pairs = nil
		for _, part := range strings.Split(strings.Split(r.Query, "&_rticket=")[0], "&") {
			key := strings.SplitN(part, "=", 2)[0]
			pairs = append(pairs, Pair{key, r.Values[key]})
		}
		if stamp == 0 {
			t.Fatal("missing vector time")
		}
		got, e := p.Sign(context.Background(), pairs, nil, stamp, [4]uint32{0x80000000, 0x80000000, 0x80000000, 0x80000000}, Process{"synthetic", 1800000000000, 1800000000000, 110, 11001})
		if e != nil || got.Query != r.Query || got.Headers["X-Medusa"] != r.Medusa || got.Headers["X-Helios"] != r.Helios {
			t.Fatalf("independent vector mismatch ts=%d err=%v", stamp, e)
		}
	}
}
func TestRejectInvalidConfigurationBeforeActivation(t *testing.T) {
	for _, mutate := range []func(map[string]any){
		func(p map[string]any) { p["schema"] = 2 },
		func(p map[string]any) {
			med := p["v5"].(map[string]any)["medusa"].(map[string]any)
			var fields []any
			for i := 1; i <= 96; i++ {
				fields = append(fields, map[string]any{"tag": i, "type": "string", "value": strings.Repeat("a", 2048)})
			}
			med["device"] = fields
		},
		func(p map[string]any) { p["unexpected"] = true },
		func(p map[string]any) { p["v5"].(map[string]any)["sbox"] = "00" },
		func(p map[string]any) {
			p["v5"].(map[string]any)["gates"].(map[string]any)["model"].(map[string]any)["host"] = "evil.example"
		},
		func(p map[string]any) {
			p["v5"].(map[string]any)["medusa"].(map[string]any)["message"].([]any)[0].(map[string]any)["value"] = "${ts}"
		},
		func(p map[string]any) {
			p["v5"].(map[string]any)["medusa"].(map[string]any)["device"].([]any)[0].(map[string]any)["value"] = "${env}"
		},
		func(p map[string]any) {
			p["v5"].(map[string]any)["modelBody"] = `{"mixed_video_id_map":{"${content_type}":["wrong"]},"device_level":${device_level},"ignored":"${id}"}`
		},
	} {
		var v map[string]any
		json.Unmarshal(Builtin(), &v)
		mutate(v)
		b, _ := json.Marshal(v)
		if _, e := Parse(b); e == nil {
			t.Fatal("invalid config accepted")
		}
	}
	if _, e := Parse(append([]byte(`{"schema":1,`), Builtin()[1:]...)); e == nil {
		t.Fatal("duplicate accepted")
	}
}
func TestProfileOnlyChangesAndCancel(t *testing.T) {
	p, e := Parse(Builtin())
	if e != nil {
		t.Fatal(e)
	}
	pairs := p.Query(map[string]string{"device_id": "123", "iid": "456", "cdid": "synthetic"}, "789", true)
	process := Process{"synthetic", 1800000000000, 1800000000000, 110, 11001}
	n := [4]uint32{1, 2, 3, 4}
	a, e := p.Sign(context.Background(), pairs, nil, 1800000000000, n, process)
	if e != nil {
		t.Fatal(e)
	}
	b := strings.Replace(string(Builtin()), `"value": 312`, `"value": 377`, 1)
	q, e := Parse([]byte(b))
	if e != nil {
		t.Fatal(e)
	}
	changed, e := q.Sign(context.Background(), pairs, nil, 1800000000000, n, process)
	if e != nil || a.Query != changed.Query || a.Headers["X-Medusa"] == changed.Headers["X-Medusa"] {
		t.Fatal("JSON did not change signature")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e = p.Sign(ctx, pairs, nil, 1800000000000, n, process); e != context.Canceled {
		t.Fatal("cancel not preserved")
	}
	if body, e := p.Body("7704857946630409240", "1003"); e != nil || !strings.Contains(string(body), `"1003":["7704857946630409240"]`) {
		t.Fatal("ID or content type changed")
	}
}

// CPU/allocation measurement only; this excludes network and device PSS.
func BenchmarkNativeProfileParse(b *testing.B) {
	data := Builtin()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, e := Parse(data); e != nil {
			b.Fatal(e)
		}
	}
}
func BenchmarkNativeProfileSign(b *testing.B) {
	p, e := Parse(Builtin())
	if e != nil {
		b.Fatal(e)
	}
	pairs := p.Query(map[string]string{"device_id": "123", "iid": "456", "cdid": "synthetic"}, "789", true)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, e := p.Sign(context.Background(), pairs, nil, 1800000000000, [4]uint32{1, 2, 3, 4}, Process{"synthetic", 1800000000000, 1800000000000, 110, 11001}); e != nil {
			b.Fatal(e)
		}
	}
}
