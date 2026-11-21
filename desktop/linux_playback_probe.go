//go:build linux

package main

// The explicit --linux-playback-self-test mode exercises the packaged binary.
// Normal startup never loads the external diagnostic script or bridge.
import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type linuxProbeBridge struct{ dispatch func(string) string }

func (b *linuxProbeBridge) Dispatch(message string) string { return b.dispatch(message) }

func runDesktopDiagnosticMode() bool {
	if len(os.Args) != 2 || os.Args[1] != "--linux-playback-self-test" {
		return false
	}
	if err := runLinuxPlaybackProbe(); err != nil {
		log.Fatal(err)
	}
	return true
}

func runLinuxPlaybackProbe() error {
	output := os.Getenv("HONGGUO_PROBE_OUTPUT")
	if output == "" {
		return fmt.Errorf("probe requires an isolated output directory")
	}
	if os.Getenv("APPIMAGE") != "" && os.Getenv("HONGGUO_CORE_PATH") != "" {
		return fmt.Errorf("AppImage validation must use its bundled core")
	}
	if err := os.MkdirAll(output, 0700); err != nil {
		return err
	}
	script, err := os.ReadFile(os.Getenv("HONGGUO_PROBE_JS"))
	if err != nil {
		return err
	}
	data, err := os.MkdirTemp("", "hongguo-linux-probe-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(data)
	app := &desktopApp{core: newCoreHost(), updater: newDesktopUpdater(0, data, data, desktopPlatform())}
	app.core.dataDir = data
	var mu sync.Mutex
	var result map[string]interface{}
	var heartbeat map[string]interface{}
	var quit sync.Once
	finished := make(chan struct{})
	finish := func(ctx context.Context) {
		quit.Do(func() {
			app.exitConfirmed.Store(true)
			close(finished)
			go func() { time.Sleep(time.Second); wruntime.Quit(ctx) }()
		})
	}
	mediaPath := regexp.MustCompile(`^/minireel-proxy/media/[a-zA-Z0-9_-]+\.mp4$`)
	stageName := regexp.MustCompile(`^(first-a|first-b|after-seek|second-a|second-b|failure)$`)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__linux_probe/capture" && r.URL.Path != "/__linux_probe/report" && r.URL.Path != "/__linux_probe/heartbeat" && r.URL.Path != "/__linux_probe/activate" {
			if !desktopRequestAllowed(r) {
				log.Printf("shell request rejected: method=%s path=%s host=%s origin=%s", r.Method, r.URL.Path, r.Host, r.Header.Get("Origin"))
			}
			app.core.proxy(w, r)
			return
		}
		if r.Method != http.MethodPost || !desktopRequestAllowed(r) {
			http.Error(w, "invalid probe request", http.StatusForbidden)
			return
		}
		var payload map[string]interface{}
		if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&payload); err != nil {
			http.Error(w, "invalid probe JSON", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/__linux_probe/activate" {
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			id, err := exec.CommandContext(ctx, "xdotool", "search", "--onlyvisible", "--name", "^Hongguo Linux playback validation$").Output()
			window := strings.TrimSpace(string(id))
			if err == nil && regexp.MustCompile(`^[0-9]+$`).MatchString(window) {
				err = exec.CommandContext(ctx, "xdotool", "windowactivate", "--sync", window).Run()
				if err == nil {
					// XTEST key input exercises the normal app's Space/play handler.
					err = exec.CommandContext(ctx, "xdotool", "key", "--clearmodifiers", "space").Run()
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": err == nil, "input": "X11 Space key"})
			return
		}
		if r.URL.Path == "/__linux_probe/heartbeat" {
			payload["requireAutoplay"] = os.Getenv("HONGGUO_PROBE_REQUIRE_AUTOPLAY") == "1"
			payload["desktopVersion"] = desktopVersion
			payload["windowGeometry"] = (runtimeMiniWindow{app.ctx}).geometry()
			app.mini.mu.Lock()
			payload["miniAspectState"] = app.mini.windowStateLocked()
			app.mini.mu.Unlock()
			mu.Lock()
			heartbeat = payload
			mu.Unlock()
			payload["ok"] = true
			_ = json.NewEncoder(w).Encode(payload)
			return
		}
		if r.URL.Path == "/__linux_probe/report" {
			mu.Lock()
			payload["platform"] = desktopPlatform()
			payload["coreVersion"] = version
			payload["desktopVersion"] = desktopVersion
			payload["appimage"] = os.Getenv("APPIMAGE") != ""
			payload["requireAutoplay"] = os.Getenv("HONGGUO_PROBE_REQUIRE_AUTOPLAY") == "1"
			payload["updaterSupported"] = app.updater.snapshot().Supported
			result = payload
			mu.Unlock()
			encoded, _ := json.MarshalIndent(payload, "", "  ")
			_ = os.WriteFile(filepath.Join(output, "playback.json"), encoded, 0600)
			_, _ = w.Write([]byte(`{"ok":true}`))
			finish(app.ctx)
			return
		}
		stage, _ := payload["stage"].(string)
		if !stageName.MatchString(stage) {
			http.Error(w, "invalid stage", http.StatusBadRequest)
			return
		}
		// Screenshots come from the X11 compositor, not a poster/canvas substitute.
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		screenshotErr := exec.CommandContext(ctx, "import", "-window", "root", filepath.Join(output, stage+".png")).Run()
		capture := map[string]interface{}{"screenshot": screenshotErr == nil}
		if stage == "first-a" || stage == "second-a" {
			// A null sink proves decoded PCM without claiming physical speaker output.
			err := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "pulse", "-i", "linux_probe.monitor", "-t", "2", "-ar", "16000", "-ac", "1", filepath.Join(output, stage+".wav")).Run()
			capture["audio_capture"] = err == nil
			path, _ := payload["media_path"].(string)
			if mediaPath.MatchString(path) && app.core.target() != "" {
				bytes, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-rw_timeout", "12000000", "-show_entries", "stream=codec_name,codec_type,width,height,sample_rate,channels:format=duration", "-of", "json", app.core.target()+path).Output()
				var codecs interface{}
				if err == nil && json.Unmarshal(bytes, &codecs) == nil {
					capture["codecs"] = codecs
				}
			}
		}
		// Neither artifacts nor logs need the ephemeral media token.
		delete(payload, "media_path")
		capture["sample"] = payload
		encoded, _ := json.MarshalIndent(capture, "", "  ")
		_ = os.WriteFile(filepath.Join(output, stage+".json"), encoded, 0600)
		_ = json.NewEncoder(w).Encode(capture)
	})
	bridge := &linuxProbeBridge{dispatch: func(message string) string {
		var request struct {
			Kind    string          `json:"kind"`
			Payload json.RawMessage `json:"payload"`
		}
		if json.Unmarshal([]byte(message), &request) != nil || (request.Kind != "heartbeat" && request.Kind != "capture" && request.Kind != "report" && request.Kind != "activate") {
			return `{"error":"invalid diagnostic message"}`
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("POST", "http://wails.localhost/__linux_probe/"+request.Kind, strings.NewReader(string(request.Payload))))
		return response.Body.String()
	}}
	opts := desktopOptions(app, data)
	opts.Title = "Hongguo Linux playback validation"
	opts.WindowStartState = options.Fullscreen
	opts.AssetServer = &assetserver.Options{Handler: handler}
	opts.Bind = append(opts.Bind, bridge)
	opts.SingleInstanceLock = nil // The self-test uses an isolated, temporary profile.
	opts.OnDomReady = func(ctx context.Context) {
		log.Print("native document ready")
		wruntime.WindowExecJS(ctx, string(script))
	}
	opts.OnStartup = func(ctx context.Context) {
		app.startup(ctx)
		go func() {
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			timeout := time.NewTimer(5 * time.Minute)
			defer timeout.Stop()
			for {
				select {
				case <-finished:
					return
				case <-ticker.C:
					wruntime.WindowExecJS(ctx, string(script))
				case <-timeout.C:
					mu.Lock()
					app.core.mu.RLock()
					result = map[string]interface{}{"ok": false, "failure": "native window or JavaScript probe timed out", "heartbeat": heartbeat, "core_ready": app.core.baseURL != "", "core_failure": app.core.failure}
					app.core.mu.RUnlock()
					encoded, _ := json.MarshalIndent(result, "", "  ")
					_ = os.WriteFile(filepath.Join(output, "playback.json"), encoded, 0600)
					mu.Unlock()
					captureCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					_ = exec.CommandContext(captureCtx, "import", "-window", "root", filepath.Join(output, "failure.png")).Run()
					cancel()
					finish(ctx)
					return
				}
			}
		}()
	}
	err = wails.Run(opts)
	if err != nil {
		app.core.stop()
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	if result == nil || result["ok"] != true {
		return fmt.Errorf("Linux playback did not pass; inspect playback.json")
	}
	return nil
}
