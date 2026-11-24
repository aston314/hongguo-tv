package jsresolver

import (
	"context"
	"encoding/json"
	"github.com/dop251/goja"
	"strings"
	"testing"

	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

func benchmarkResolver(b *testing.B) *Resolver {
	b.Helper()
	script := strings.Replace(string(Source()), "test:{device:device", "test:{v5:v5,device:device", 1)
	r, e := New(context.Background(), []byte(script), func(context.Context, resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		return resolverwire.HTTPResponse{}, nil
	})
	if e != nil {
		b.Fatal(e)
	}
	b.Cleanup(func() { r.Close(context.Background()) })
	if e = r.run(context.Background(), func() error {
		r.vm.Set("__benchAPI", r.api.Get("test"))
		_, e := r.vm.RunString("var __benchDevice={deviceID:'1234567891234567',installID:'2345678912345678',cdid:'00000000-0000-4000-8000-000000000001'};")
		return e
	}); e != nil {
		b.Fatal(e)
	}
	return r
}
func BenchmarkResolverStages(b *testing.B) {
	for _, stage := range []string{"parse_24k", "v5_build", "options"} {
		b.Run(stage, func(b *testing.B) {
			r := benchmarkResolver(b)
			raw, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"123": map[string]any{"video_model": fixture("h265", "cdn-id")}}, "padding": strings.Repeat("x", 24000)})
			r.vm.Set("__benchJSON", string(raw))
			expression := map[string]string{"parse_24k": "__benchAPI.model.parseExactJSON(__benchJSON)", "v5_build": "__benchAPI.v5.build('123','1004',__benchDevice,1800000000000)", "options": "__benchAPI.options(__benchAPI.model.parseExactJSON(__benchJSON).data['123'].video_model)"}[stage]
			program, e := r.vm.RunString("(function(){return " + expression + ";})")
			if e != nil {
				b.Fatal(e)
			}
			call, ok := goja.AssertFunction(program)
			fn := func() (goja.Value, error) { return call(goja.Undefined()) }
			if !ok {
				b.Fatal("missing function")
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if e := r.run(context.Background(), func() error { _, e := fn(); return e }); e != nil {
					b.Fatal(e)
				}
			}
		})
	}
}
