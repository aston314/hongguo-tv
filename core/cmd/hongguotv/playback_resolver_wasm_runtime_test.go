package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestWASMPlaybackResolverExecutesStableABI(t *testing.T) {
	dir := t.TempDir()
	artifact := filepath.Join(dir, "resolver.wasm")
	if err := os.WriteFile(artifact, fixedPlaybackResolverWASM(), 0600); err != nil {
		t.Fatal(err)
	}
	manifest := playbackResolverManifest{Version: "2026.11.20.1", Protocol: builtInPlaybackResolverProtocol}
	resolver, err := loadWASMPlaybackResolver(context.Background(), manifest, artifact)
	if err != nil {
		t.Fatal(err)
	}
	if got := resolver.Metadata(); got.Name != playbackResolverWASMName || got.Version != manifest.Version || got.Protocol != manifest.Protocol {
		t.Fatalf("metadata = %+v", got)
	}
	options, err := resolver.Resolve(context.Background(), playbackResolverRequest{VID: "vid-1", CodecMode: "default", ContentType: "1004"})
	if err != nil {
		t.Fatal(err)
	}
	if len(options) != 1 || options[0].URL != "https://example.com/video.mp4" || options[0].Width != 1280 || options[0].Height != 720 {
		t.Fatalf("options = %+v", options)
	}
}

func TestWASMPlaybackResolverRejectsUnsafeOptions(t *testing.T) {
	if err := validatePlaybackResolverWASMOptions([]miniReelOption{{URL: "http://example.com/video.mp4", Codec: "h264", Quality: "720p"}}); err == nil {
		t.Fatal("insecure URL accepted")
	}
	if err := validatePlaybackResolverWASMOptions([]miniReelOption{{URL: "https://example.com/video.mp4", Codec: "h264"}}); err == nil {
		t.Fatal("missing quality accepted")
	}
}

func TestWASMHTTPHostAllowList(t *testing.T) {
	for _, raw := range []string{
		"https://api5-normal-hl.fqnovel.com/novel/player/multi_video_model/v1/",
		"https://api5-normal-sinfonlineb.fqnovel.com/reading/bookapi/video_tab/multi_video_model/v1/",
		"https://log.snssdk.com/service/2/device_register/",
	} {
		if !validWASMHTTPURL(raw) {
			t.Fatalf("allowed URL rejected: %s", raw)
		}
	}
	for _, raw := range []string{
		"http://api5-normal-hl.fqnovel.com/",
		"https://example.com/",
		"https://fqnovel.com.evil.test/",
		"https://user:pass@fqnovel.com/",
		"https://log.snssdk.com.evil.test/",
		"https://log.snssdk.com:8080/",
	} {
		if validWASMHTTPURL(raw) {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
	if validWASMHTTPHeaders(map[string]string{"Cookie": "secret"}) || validWASMHTTPHeaders(map[string]string{"Authorization": "secret"}) {
		t.Fatal("account header accepted")
	}
}

// fixedPlaybackResolverWASM is a tiny no-import fixture. It ignores the
// request and returns one known-good candidate, which is enough to exercise
// compile, memory transfer, exported calls, JSON validation and fallback
// boundaries without bringing a compiler or a network dependency into tests.
func fixedPlaybackResolverWASM() []byte {
	response := []byte(`{"options":[{"url":"https://example.com/video.mp4","codec":"h264","width":1280,"height":720,"quality":"720p","duration":60}]}`)
	var wasm []byte
	wasm = append(wasm, 0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
	wasm = appendWASMSection(wasm, 1, []byte{0x03, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7e, 0x60, 0x02, 0x7f, 0x7f, 0x00})
	wasm = appendWASMSection(wasm, 3, []byte{0x03, 0x00, 0x01, 0x02})
	wasm = appendWASMSection(wasm, 5, []byte{0x01, 0x00, 0x01})
	exports := wasmExports(
		wasmExport{"memory", 0x02, 0},
		wasmExport{"resolver_alloc", 0x00, 0},
		wasmExport{"resolver_resolve", 0x00, 1},
		wasmExport{"resolver_free", 0x00, 2},
	)
	wasm = appendWASMSection(wasm, 7, exports)
	allocBody := appendWASMBody([]byte{0x41, 0x80, 0x08, 0x0b})
	packed := uint64(2048)<<32 | uint64(len(response))
	resolveBody := appendWASMBody(append(append([]byte{0x42}, wasmSLEB(packed, 64)...), 0x0b))
	freeBody := appendWASMBody([]byte{0x0b})
	code := []byte{0x03}
	code = append(code, allocBody...)
	code = append(code, resolveBody...)
	code = append(code, freeBody...)
	wasm = appendWASMSection(wasm, 10, code)
	data := []byte{0x01, 0x00, 0x41, 0x80, 0x10, 0x0b}
	data = append(data, wasmULEB(uint64(len(response)))...)
	data = append(data, response...)
	wasm = appendWASMSection(wasm, 11, data)
	return wasm
}

type wasmExport struct {
	name  string
	kind  byte
	index byte
}

func wasmExports(exports ...wasmExport) []byte {
	result := wasmULEB(uint64(len(exports)))
	for _, export := range exports {
		result = append(result, wasmULEB(uint64(len(export.name)))...)
		result = append(result, export.name...)
		result = append(result, export.kind, export.index)
	}
	return result
}

func appendWASMBody(body []byte) []byte {
	return append(wasmULEB(uint64(len(body)+1)), append([]byte{0x00}, body...)...)
}

func appendWASMSection(wasm []byte, id byte, payload []byte) []byte {
	wasm = append(wasm, id)
	wasm = append(wasm, wasmULEB(uint64(len(payload)))...)
	return append(wasm, payload...)
}

func wasmULEB(value uint64) []byte {
	var result []byte
	for {
		b := byte(value & 0x7f)
		value >>= 7
		if value != 0 {
			b |= 0x80
		}
		result = append(result, b)
		if value == 0 {
			return result
		}
	}
}

func wasmSLEB(value uint64, bits int) []byte {
	var result []byte
	more := true
	for more {
		b := byte(value & 0x7f)
		value >>= 7
		sign := b&0x40 != 0
		more = !((value == 0 && !sign) || (value == ^uint64(0)>>7 && sign))
		if more {
			b |= 0x80
		}
		result = append(result, b)
	}
	_ = bits
	return result
}
