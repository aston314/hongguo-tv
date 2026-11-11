//go:build !windows

package main

import (
	"net/http"
	"strings"
)

func desktopWasmAvailable() bool { return false }
func serveDesktopWasm(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/windows-wasm/") {
		return false
	}
	http.NotFound(w, r)
	return true
}
