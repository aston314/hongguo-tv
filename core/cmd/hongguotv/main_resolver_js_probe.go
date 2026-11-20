//go:build resolverjsprobe

package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/playbackresolver"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"time"
)

//go:embed resolver-probe.html
var rawJSProbePage []byte

//go:embed testdata/signing-v5-wire.json
var jsProbeVectors []byte

var resolverProbePage = bytes.ReplaceAll(bytes.ReplaceAll(rawJSProbePage, []byte("WASM"), []byte("JS")), []byte("wasm_bytes"), []byte("script_bytes"))

type nativeProbeReference struct{ resolver *playbackresolver.Resolver }

func (r *nativeProbeReference) Metadata() playbackResolverMetadata {
	return playbackResolverMetadata{Name: "native-reference", Version: "2026.11.20.1", Protocol: 1}
}
func (r *nativeProbeReference) Close(context.Context) error { return nil }
func (r *nativeProbeReference) Resolve(ctx context.Context, in playbackResolverRequest) ([]miniReelOption, error) {
	options, e := r.resolver.Resolve(ctx, resolverwire.Request{VID: in.VID, CodecMode: in.CodecMode, ContentType: in.ContentType})
	if e != nil {
		var detail *playbackresolver.Error
		if errors.As(e, &detail) {
			return nil, &playbackPreparationError{cause: errors.New("native reference failed"), diagnostic: playbackPreparationDiagnostic{Code: detail.Code, Stage: detail.Stage}}
		}
		return nil, e
	}
	out := make([]miniReelOption, len(options))
	for i, o := range options {
		out[i] = miniReelOption(o)
	}
	return out, nil
}

type resolverProbeHTTP struct {
	Stage  string `json:"stage"`
	Status int    `json:"status"`
	Bytes  int64  `json:"bytes"`
	MS     int64  `json:"ms"`
	Codec  string `json:"codec,omitempty"`
}
type resolverProbeResult struct {
	VID        string              `json:"vid"`
	OK         bool                `json:"ok"`
	Code       string              `json:"code,omitempty"`
	Stage      string              `json:"stage,omitempty"`
	Codec      string              `json:"codec,omitempty"`
	Width      int                 `json:"width,omitempty"`
	Height     int                 `json:"height,omitempty"`
	Options    int                 `json:"options,omitempty"`
	ResolveMS  int64               `json:"resolve_ms"`
	TotalMS    int64               `json:"total_ms"`
	MediaBytes int64               `json:"media_bytes,omitempty"`
	Media      string              `json:"media,omitempty"`
	Requests   []resolverProbeHTTP `json:"requests"`
}
type resolverProbeTransport struct{ record func(resolverProbeHTTP) }

func (p resolverProbeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	start := time.Now()
	res, err := http.DefaultTransport.RoundTrip(r)
	stage := "fallback_api"
	if r.URL.Path == "/service/2/device_register/" {
		stage = "device_register"
	}
	if r.URL.Path == "/novel/player/multi_video_model/player/v1" {
		stage = "v5_model"
	}
	row := resolverProbeHTTP{Stage: stage, Codec: r.URL.Query().Get("codec_type"), MS: time.Since(start).Milliseconds()}
	if err == nil {
		row.Status = res.StatusCode
		row.Bytes = res.ContentLength
	}
	p.record(row)
	return res, err
}

func main() {
	port := flag.Int("port", 0, "loopback port")
	parent := flag.Int("parent-pid", 0, "host process")
	dir := flag.String("data-dir", "", "private diagnostic directory")
	candidate := flag.String("js-file", "", "explicit private test script override")
	engine := flag.String("engine", "js", "js or native reference")
	moduleVersion := flag.String("module-version", jsresolver.Version, "diagnostic manifest version")
	flag.Parse()
	if *engine != "js" && *engine != "native" {
		log.Fatal("invalid test engine")
	}
	resolverProbeArtifact := jsresolver.Source()
	if *engine == "native" {
		resolverProbePage = bytes.ReplaceAll(resolverProbePage, []byte("已验签加载 "), []byte("原生参考，JS 未执行 · 文件 "))
		resolverProbePage = bytes.ReplaceAll(resolverProbePage, []byte("JS 播放解析 · 独立验证"), []byte("原生解析 · 内存对照验证"))
		resolverProbePage = bytes.ReplaceAll(resolverProbePage, []byte("注册、签名、模型解析、兼容编码回退均在本地 JS 内执行。内置解析回退：关闭。"), []byte("当前为原生参考模式，未加载 JS 解析器。使用相同页面和媒体流程，内置解析回退：关闭。"))
	}
	if *dir == "" {
		log.Fatal("private data directory required")
	}
	if err := os.MkdirAll(*dir, 0700); err != nil {
		log.Fatal("private directory failed")
	}
	if *candidate != "" {
		if filepath.Clean(*candidate) != filepath.Join(*dir, "candidate.js") {
			log.Fatal("test module must be in private diagnostic directory")
		}
		var err error
		resolverProbeArtifact, err = os.ReadFile(*candidate)
		if err != nil || len(resolverProbeArtifact) > jsresolver.MaxScript {
			log.Fatal("private test module unreadable")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatal("test key failed")
	}
	digest := sha256.Sum256(resolverProbeArtifact)
	manifest := playbackResolverManifest{Schema: 1, Product: playbackResolverProduct, Version: *moduleVersion, Protocol: 1, Size: int64(len(resolverProbeArtifact)), SHA256: hex.EncodeToString(digest[:]), URL: "https://github.com/aston314/hongguo-tv/releases/download/resolver-probe/resolver.js"}
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, playbackResolverSignatureMessage(manifest)))
	artifact := filepath.Join(*dir, "resolver.js")
	if os.WriteFile(artifact, resolverProbeArtifact, 0600) != nil {
		log.Fatal("module write failed")
	}
	var mu sync.Mutex
	var traces []resolverProbeHTTP
	client := &http.Client{Timeout: 20 * time.Second, Transport: resolverProbeTransport{record: func(row resolverProbeHTTP) { mu.Lock(); traces = append(traces, row); mu.Unlock() }}}
	// Exactly one selected resolver executes; JS cannot call the native reference.
	var active playbackResolver
	var wireTest uint32
	var nativeSM3 bool
	start := time.Now()
	if *engine == "js" {
		runtime := newPlaybackResolverRuntime(*dir, nil, public)
		if runtime.Activate(ctx, manifest, artifact, func(ctx context.Context, m playbackResolverManifest, path string) (playbackResolver, error) {
			return loadJSPlaybackResolver(ctx, m, path, client)
		}) != nil {
			log.Fatal("signed JS activation failed")
		}
		active = runtime.Current().(playbackResolverWithFallback).active
		metadata, e := active.(*jsPlaybackResolver).script.Metadata(ctx)
		if e != nil {
			log.Fatal("JS metadata unavailable")
		}
		nativeSM3 = metadata.NativeSM3
		wireTest, err = active.(*jsPlaybackResolver).script.SelfTest(ctx, jsProbeVectors)
		if err != nil || wireTest != 4 {
			log.Fatal("JS wire vectors failed")
		}
	} else {
		active = &nativeProbeReference{playbackresolver.New(playbackresolver.Transport(jsresolver.HTTPTransport(client)))}
		wireTest = playbackresolver.SelfTest()
	}
	loadMS := time.Since(start).Milliseconds()
	defer closePlaybackResolver(context.Background(), active)
	var runMu sync.Mutex
	var results []resolverProbeResult
	var playbackReports []json.RawMessage
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
		w.Write(resolverProbePage)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"ok": true, "resolver": *engine + "-only", "embedded_fallback": false, "sha256": manifest.SHA256, "load_ms": loadMS, "script_bytes": manifest.Size, "engine": *engine, "script_loaded": *engine == "js", "native_sm3": nativeSM3, "module_version": *moduleVersion, "wire_vectors": wireTest, "private_override": *candidate != ""})
	})
	mux.HandleFunc("/memory", func(w http.ResponseWriter, r *http.Request) {
		var stats goruntime.MemStats
		goruntime.ReadMemStats(&stats)
		write(w, map[string]any{"host_heap_alloc": stats.HeapAlloc, "host_heap_sys": stats.HeapSys, "host_heap_idle": stats.HeapIdle, "host_heap_released": stats.HeapReleased, "host_sys": stats.Sys})
	})
	mux.HandleFunc("/report", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var row json.RawMessage
			if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&row) == nil {
				mu.Lock()
				playbackReports = append(playbackReports, row)
				mu.Unlock()
			}
			write(w, map[string]bool{"ok": true})
			return
		}
		mu.Lock()
		defer mu.Unlock()
		write(w, map[string]any{"resolver": *engine + "-only", "embedded_fallback": false, "load_ms": loadMS, "sha256": manifest.SHA256, "results": results, "playback": playbackReports})
	})
	mux.HandleFunc("/api/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(405)
			return
		}
		if !runMu.TryLock() {
			w.WriteHeader(409)
			return
		}
		defer runMu.Unlock()
		var input struct {
			VID string `json:"vid"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&input) != nil || !miniReelIDRE.MatchString(input.VID) {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		traces = nil
		mu.Unlock()
		started := time.Now()
		row := resolverProbeResult{VID: input.VID}
		job, stop := context.WithTimeout(r.Context(), 90*time.Second)
		defer stop()
		resolveCtx, endResolve := context.WithTimeout(job, 25*time.Second)
		options, err := active.Resolve(resolveCtx, playbackResolverRequest{VID: input.VID, CodecMode: "default", ContentType: "1004"})
		endResolve()
		row.ResolveMS = time.Since(started).Milliseconds()
		row.Options = len(options)
		if err != nil {
			d := playbackPreparationDetails(err)
			row.Code = d.Code
			row.Stage = d.Stage
		} else {
			option, e := selectMiniReelQuality(options, "1080P", true)
			if e != nil {
				row.Code = "NO_COMPATIBLE_QUALITY"
			} else {
				row.Codec = option.Codec
				row.Width = option.Width
				row.Height = option.Height
				file := filepath.Join(*dir, "current.mp4")
				os.Remove(file)
				if downloadMiniReelMedia(job, option.URL, file) != nil {
					row.Code = "MEDIA_DOWNLOAD_FAILED"
				} else if len(option.Key) > 0 && decryptMiniReelMP4(file, option.Key) != nil {
					row.Code = "MEDIA_DECRYPT_FAILED"
				} else if info, e := os.Stat(file); e == nil {
					row.OK = true
					row.MediaBytes = info.Size()
					row.Media = "/media/current.mp4"
				}
			}
		}
		row.TotalMS = time.Since(started).Milliseconds()
		mu.Lock()
		row.Requests = append([]resolverProbeHTTP(nil), traces...)
		results = append(results, row)
		mu.Unlock()
		log.Printf("resolver_probe vid=%s ok=%t codec=%s resolve_ms=%d bytes=%d code=%s", row.VID, row.OK, row.Codec, row.ResolveMS, row.MediaBytes, row.Code)
		write(w, row)
	})
	mux.HandleFunc("/media/current.mp4", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeFile(w, r, filepath.Join(*dir, "current.mp4"))
	})
	if err := serveLocalCore(ctx, *port, "resolver-js-probe", *parent, mux); err != nil {
		log.Print("probe stopped")
	}
}
