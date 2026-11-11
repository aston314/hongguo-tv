package main

import (
	"bytes"
	"embed"
	"net/http"
	"runtime"
	"strings"
	"time"
)

//go:embed wasm-runtime/*
var wasmAssets embed.FS

func desktopWasmAvailable() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	b, err := wasmAssets.ReadFile("wasm-runtime/decoder.wasm")
	return err == nil && len(b) > 8 && bytes.Equal(b[:4], []byte{0, 'a', 's', 'm'})
}
func serveDesktopWasm(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/windows-wasm/") {
		return false
	}
	name := strings.TrimPrefix(r.URL.Path, "/windows-wasm/")
	if !desktopWasmAvailable() || r.Method != http.MethodGet || name != "decoder.js" && name != "decoder.wasm" && name != "NOTICE.txt" && name != "FFmpeg-LICENSE.txt" {
		http.NotFound(w, r)
		return true
	}
	b, err := wasmAssets.ReadFile("wasm-runtime/" + name)
	if err != nil {
		http.NotFound(w, r)
		return true
	}
	if name == "decoder.wasm" {
		w.Header().Set("Content-Type", "application/wasm")
	} else if name == "decoder.js" {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(b))
	return true
}
