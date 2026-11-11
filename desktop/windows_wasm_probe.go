//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func runDesktopDiagnosticMode() bool {
	if len(os.Args) != 2 || os.Args[1] != "--windows-wasm-self-test" {
		return false
	}
	if err := runWindowsWasmProbe(); err != nil {
		log.Fatal(err)
	}
	return true
}
func runWindowsWasmProbe() error {
	out, media := os.Getenv("HONGGUO_WASM_PROBE_OUTPUT"), os.Getenv("HONGGUO_WASM_PROBE_MEDIA")
	script, err := os.ReadFile(os.Getenv("HONGGUO_WASM_PROBE_JS"))
	if out == "" || media == "" || err != nil || !desktopWasmAvailable() {
		return fmt.Errorf("isolated WASM probe configuration missing")
	}
	if err = os.MkdirAll(out, 0700); err != nil {
		return err
	}
	data, err := os.MkdirTemp("", "hongguo-wasm-probe-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(data)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Range")
		w.Header().Set("Access-Control-Allow-Headers", "Range")
		if r.Method == http.MethodOptions {
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/minireel-proxy/media/")
		if r.URL.Path != "/minireel-proxy/media/"+name || name != "hevc720.mp4" && name != "hevc1080.mp4" && name != "h264.mp4" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(media, name))
	}))
	defer server.Close()
	host := newCoreHost()
	host.dataDir = data
	app := &desktopApp{core: host, updater: newDesktopUpdater(0, data, data, desktopPlatform())}
	var ctx context.Context
	var mu sync.Mutex
	var result map[string]interface{}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !desktopRequestAllowed(r) {
			http.Error(w, "forbidden", 403)
			return
		}
		if r.URL.Path == "/__wasm_probe/report" && r.Method == http.MethodPost {
			var report map[string]interface{}
			if json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&report) != nil {
				http.Error(w, "invalid", 400)
				return
			}
			mu.Lock()
			result = report
			mu.Unlock()
			body, _ := json.MarshalIndent(report, "", "  ")
			_ = os.WriteFile(filepath.Join(out, "wasm-validation.json"), body, 0600)
			w.WriteHeader(204)
			go func() { time.Sleep(time.Second); wruntime.Quit(ctx) }()
			return
		}
		if r.URL.Path == "/__wasm_probe.js" {
			w.Header().Set("Content-Type", "text/javascript")
			_, _ = w.Write(script)
			return
		}
		if r.URL.Path == "/wasm-probe.html" {
			config, _ := json.Marshal(map[string]interface{}{"platform": "windows", "wasmDecoder": true, "mediaBase": server.URL})
			fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><script>window.HongguoDesktop=%s;</script></head><body style="background:#111;color:white"><video id="hero-video" style="width:960px;height:540px"></video><pre id="results"></pre><script src="/windows-wasm-player.js"></script><script src="/__wasm_probe.js"></script></body></html>`, config)
			return
		}
		host.proxy(w, r)
	})
	opts := desktopOptions(app, data)
	opts.Title = "Hongguo Windows WASM validation"
	opts.AssetServer = &assetserver.Options{Handler: handler}
	opts.OnBeforeClose = nil
	opts.OnStartup = func(c context.Context) {
		ctx = c
		app.ctx = c
		host.start()
		go func() {
			deadline := time.Now().Add(30 * time.Second)
			for host.target() == "" && time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
			}
			wruntime.WindowExecJS(c, "location.href='/wasm-probe.html';")
			time.Sleep(180 * time.Second)
			wruntime.Quit(c)
		}()
	}
	err = wails.Run(opts)
	host.stop()
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	if result == nil || result["ok"] != true {
		return fmt.Errorf("WASM probe failed; inspect wasm-validation.json")
	}
	return nil
}
