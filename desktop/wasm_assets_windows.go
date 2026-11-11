//go:build windows

package main

import (
	"bytes"
	"embed"
	"io"
	"net/http"
	"strings"
	"time"
)

// Keep source/relink archives outside the executable; packaging ships them
// alongside it. README.txt also permits development without generated assets.
//
//go:embed wasm-runtime/[dFNR]*
var wasmAssets embed.FS

func desktopWasmAvailable() bool {
	f, err := wasmAssets.Open("wasm-runtime/decoder.wasm")
	if err != nil {
		return false
	}
	defer f.Close()
	var header [8]byte
	_, err = io.ReadFull(f, header[:])
	return err == nil && bytes.Equal(header[:], []byte{0, 'a', 's', 'm', 1, 0, 0, 0})
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
