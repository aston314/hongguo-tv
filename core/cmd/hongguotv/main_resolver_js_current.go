//go:build resolverjsprobe

package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sync"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/jsupdate"
	"github.com/aston314/hongguo-tv/core/internal/jsupdatelab"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

//go:embed resolver-probe.html
var currentProbePage []byte

type currentTrace struct {
	Stage  string `json:"stage"`
	Status int    `json:"status"`
	Bytes  int64  `json:"bytes"`
	MS     int64  `json:"ms"`
}
type currentTransport struct {
	base http.RoundTripper
	mu   sync.Mutex
	rows []currentTrace
}
type currentBody struct {
	io.ReadCloser
	n    int64
	done func(int64)
}

func (b *currentBody) Read(p []byte) (int, error) {
	n, e := b.ReadCloser.Read(p)
	b.n += int64(n)
	return n, e
}
func (b *currentBody) Close() error {
	e := b.ReadCloser.Close()
	if b.done != nil {
		b.done(b.n)
		b.done = nil
	}
	return e
}
func (t *currentTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	r, e := t.base.RoundTrip(req)
	stage := "media"
	switch req.URL.Path {
	case "/service/2/device_register/":
		stage = "device_register"
	case miniReelVideoTabPath:
		stage = "video_tab"
	case "/novel/player/multi_video_model/player/v1":
		stage = "v5_model"
	case miniReelAPIPath:
		stage = "legacy_model"
	case miniReelSinglePath:
		stage = "single_model"
	default:
		if req.URL.Hostname() != "" && (req.URL.Query().Get("codec_type") != "" || req.URL.Query().Get("force_codec") != "") {
			stage = "fallback_api"
		}
	}
	row := currentTrace{Stage: stage, Bytes: -1, MS: time.Since(start).Milliseconds()}
	if e != nil {
		t.mu.Lock()
		t.rows = append(t.rows, row)
		t.mu.Unlock()
		return nil, e
	}
	row.Status = r.StatusCode
	r.Body = &currentBody{ReadCloser: r.Body, done: func(n int64) { row.Bytes = n; t.mu.Lock(); t.rows = append(t.rows, row); t.mu.Unlock() }}
	return r, nil
}
func (t *currentTransport) snapshot(clear bool) []currentTrace {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := append([]currentTrace(nil), t.rows...)
	if clear {
		t.rows = nil
	}
	return out
}

type currentResult struct {
	VID        string         `json:"vid"`
	OK         bool           `json:"ok"`
	Code       string         `json:"code,omitempty"`
	Stage      string         `json:"stage,omitempty"`
	Codec      string         `json:"codec,omitempty"`
	Width      int            `json:"width,omitempty"`
	Height     int            `json:"height,omitempty"`
	Options    int            `json:"options"`
	ResolveMS  int64          `json:"resolve_ms"`
	TotalMS    int64          `json:"total_ms"`
	MediaBytes int64          `json:"media_bytes,omitempty"`
	Media      string         `json:"media,omitempty"`
	MediaSHA   string         `json:"media_sha256,omitempty"`
	Requests   []currentTrace `json:"requests"`
}

func main() {
	port := flag.Int("port", 0, "loopback")
	parent := flag.Int("parent-pid", 0, "parent")
	dir := flag.String("data-dir", "", "isolated data")
	engine := flag.String("engine", "js", "js/native")
	candidate := flag.String("js-file", "", "private candidate")
	flag.String("module-version", jsresolver.Version, "diagnostic version")
	updateLab := flag.Bool("update-lab", false, "fixed signed update lab; isolated APK only")
	stale := flag.Bool("simulate-stale", false, "simulate old embedded algorithm; isolated APK only")
	flag.Parse()
	if *dir == "" || (*engine != "js" && *engine != "native") {
		log.Fatal("invalid probe flags")
	}
	if e := os.MkdirAll(*dir, 0700); e != nil {
		log.Fatal("data directory unavailable")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	trace := &currentTransport{base: http.DefaultTransport}
	http.DefaultTransport = trace
	client := &http.Client{Transport: trace, Timeout: 8 * time.Second}
	script := jsresolver.Source()
	if *candidate != "" {
		if filepath.Clean(*candidate) != filepath.Join(*dir, "candidate.js") {
			log.Fatal("candidate outside private directory")
		}
		var e error
		script, e = os.ReadFile(*candidate)
		if e != nil {
			log.Fatal("candidate unavailable")
		}
	}
	if *stale {
		script = jsupdatelab.Stale(script)
	}
	start := time.Now()
	var manager *jsupdate.Manager
	var js interface {
		Resolve(context.Context, resolverwire.Request) ([]resolverwire.Option, error)
		Close(context.Context) error
	}
	var err error
	if *engine == "js" {
		if *updateLab {
			manager, err = jsupdatelab.New(ctx, filepath.Join(*dir, "updates"), script, jsresolver.HTTPTransport(client))
			js = manager
		} else {
			js, err = jsresolver.New(ctx, script, jsresolver.HTTPTransport(client))
		}
		if err != nil {
			log.Fatal(err)
		}
		defer js.Close(ctx)
	}
	loadMS := time.Since(start).Milliseconds()
	digest := sha256.Sum256(script)
	var jobMu, mu sync.Mutex
	var results []currentResult
	var playback []json.RawMessage
	write := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(v)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(currentProbePage)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		health := map[string]any{"ok": true, "engine": *engine, "resolver": *engine + "-only", "native_baseline": "production-fd454dc", "embedded_fallback": manager != nil, "native_fallback": false, "script_loaded": js != nil, "script_bytes": len(script), "load_ms": loadMS, "sha256": hex.EncodeToString(digest[:]), "module_version": jsresolver.Version}
		if manager != nil {
			s := manager.Status()
			health["update"] = s
			health["sha256"] = s.SHA256
			health["module_version"] = s.Version
		}
		write(w, health)
	})
	mux.HandleFunc("/api/update", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		if manager == nil {
			w.WriteHeader(404)
			return
		}
		e := manager.Check(r.Context())
		code := ""
		if e != nil {
			code = e.Error()
		}
		write(w, map[string]any{"ok": e == nil, "error": code, "update": manager.Status()})
	})
	if manager != nil {
		go func() {
			e := manager.Check(ctx)
			log.Printf("probe startup update ok=%t status=%s", e == nil, manager.Status().Event)
		}()
	}
	mux.HandleFunc("/memory", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			if !jobMu.TryLock() {
				w.WriteHeader(409)
				return
			}
			defer jobMu.Unlock()
			runtime.GC()
			debug.FreeOSMemory()
		}
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		write(w, map[string]any{"host_heap_alloc": m.HeapAlloc, "host_heap_inuse": m.HeapInuse, "host_heap_sys": m.HeapSys, "host_heap_idle": m.HeapIdle, "host_heap_released": m.HeapReleased, "host_sys": m.Sys, "total_alloc": m.TotalAlloc, "heap_objects": m.HeapObjects, "goroutines": runtime.NumGoroutine(), "num_gc": m.NumGC})
	})
	mux.HandleFunc("/report", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == "POST" {
			var row json.RawMessage
			if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&row) == nil && len(playback) < 256 {
				playback = append(playback, row)
			}
			write(w, map[string]bool{"ok": true})
			return
		}
		write(w, map[string]any{"engine": *engine, "results": results, "playback": playback})
	})
	run := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		if !jobMu.TryLock() {
			w.WriteHeader(409)
			return
		}
		defer jobMu.Unlock()
		var in struct {
			VID string `json:"vid"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&in) != nil || !miniReelIDRE.MatchString(in.VID) {
			w.WriteHeader(400)
			return
		}
		trace.snapshot(true)
		row := currentResult{VID: in.VID}
		start := time.Now()
		job, stop := context.WithTimeout(r.Context(), 90*time.Second)
		defer stop()
		resolveCtx, end := context.WithTimeout(job, 30*time.Second)
		var opts []miniReelOption
		var e error
		if js != nil {
			var out []resolverwire.Option
			out, e = js.Resolve(resolveCtx, resolverwire.Request{VID: in.VID, CodecMode: "default", ContentType: "1004"})
			for _, o := range out {
				opts = append(opts, miniReelOption(o))
			}
		} else {
			opts, e = miniReelNativeOptionsWithSources(resolveCtx, in.VID, "default", "1004", miniReelProductionSources())
		}
		end()
		row.ResolveMS = time.Since(start).Milliseconds()
		row.Options = len(opts)
		if e != nil {
			if j, ok := e.(*jsresolver.Error); ok {
				row.Code = j.Code
				row.Stage = j.Stage
			} else {
				d := playbackPreparationDetails(e)
				row.Code = d.Code
				row.Stage = d.Stage
				if row.Code == "" {
					row.Code = "RESOLVE_FAILED"
				}
			}
		} else {
			option, selectErr := selectMiniReelQuality(opts, "1080P", true)
			if selectErr != nil {
				row.Code = "NO_COMPATIBLE_QUALITY"
			} else {
				row.Codec = option.Codec
				row.Width = option.Width
				row.Height = option.Height
				if r.URL.Path == "/api/resolve" {
					row.OK = true
				} else {
					file := filepath.Join(*dir, "current.mp4")
					os.Remove(file)
					if downloadMiniReelMedia(job, option.URL, file) != nil {
						row.Code = "MEDIA_DOWNLOAD_FAILED"
					} else if len(option.Key) > 0 && decryptMiniReelMP4(file, option.Key) != nil {
						row.Code = "MEDIA_DECRYPT_FAILED"
					} else if f, e := os.Open(file); e == nil {
						h := sha256.New()
						n, e := io.Copy(h, f)
						f.Close()
						if e == nil {
							row.OK = true
							row.MediaBytes = n
							row.Media = "/media/current.mp4"
							row.MediaSHA = hex.EncodeToString(h.Sum(nil))
						}
					}
				}
			}
		}
		row.TotalMS = time.Since(start).Milliseconds()
		row.Requests = trace.snapshot(true)
		mu.Lock()
		if len(results) < 256 {
			results = append(results, row)
		}
		mu.Unlock()
		log.Printf("probe engine=%s ok=%t options=%d resolve_ms=%d code=%s", *engine, row.OK, row.Options, row.ResolveMS, row.Code)
		write(w, row)
	}
	mux.HandleFunc("/api/run", run)
	mux.HandleFunc("/api/resolve", run)
	mux.HandleFunc("/media/current.mp4", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeFile(w, r, filepath.Join(*dir, "current.mp4"))
	})
	if e := serveLocalCore(ctx, *port, "resolver-js-current", *parent, mux); e != nil {
		log.Printf("probe exit: %v", e)
	}
}
