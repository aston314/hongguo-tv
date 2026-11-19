//go:build resolverprobe && !resolverwasm

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

//go:embed resolver-probe-assets/resolver.wasm
var resolverProbeArtifact []byte

//go:embed resolver-probe.html
var resolverProbePage []byte

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
	row := resolverProbeHTTP{Stage: r.URL.Path, Codec: r.URL.Query().Get("codec_type"), MS: time.Since(start).Milliseconds()}
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
	flag.Parse()
	if *dir == "" {
		log.Fatal("private data directory required")
	}
	if err := os.MkdirAll(*dir, 0700); err != nil {
		log.Fatal("private directory failed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatal("test key failed")
	}
	digest := sha256.Sum256(resolverProbeArtifact)
	manifest := playbackResolverManifest{Schema: 1, Product: playbackResolverProduct, Version: "2026.11.19.1", Protocol: 1, Size: int64(len(resolverProbeArtifact)), SHA256: hex.EncodeToString(digest[:]), URL: "https://github.com/aston314/hongguo-tv/releases/download/resolver-probe/resolver.wasm"}
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, playbackResolverSignatureMessage(manifest)))
	artifact := filepath.Join(*dir, "resolver.wasm")
	if os.WriteFile(artifact, resolverProbeArtifact, 0600) != nil {
		log.Fatal("module write failed")
	}
	var mu sync.Mutex
	var traces []resolverProbeHTTP
	client := &http.Client{Timeout: 20 * time.Second, Transport: resolverProbeTransport{record: func(row resolverProbeHTTP) { mu.Lock(); traces = append(traces, row); mu.Unlock() }}}
	// nil embedded resolver makes a successful fallback impossible.
	runtime := newPlaybackResolverRuntime(*dir, nil, public)
	start := time.Now()
	if runtime.Activate(ctx, manifest, artifact, newWASMPlaybackResolverLoader(client)) != nil {
		log.Fatal("signed WASM activation failed")
	}
	loadMS := time.Since(start).Milliseconds()
	defer closePlaybackResolver(context.Background(), runtime.Current().(playbackResolverWithFallback).active)
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
		write(w, map[string]any{"ok": true, "resolver": "wasm-only", "embedded_fallback": false, "sha256": manifest.SHA256, "load_ms": loadMS, "wasm_bytes": manifest.Size})
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
		write(w, map[string]any{"resolver": "wasm-only", "embedded_fallback": false, "load_ms": loadMS, "sha256": manifest.SHA256, "results": results, "playback": playbackReports})
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
		options, err := runtime.Current().Resolve(resolveCtx, playbackResolverRequest{VID: input.VID, CodecMode: "default", ContentType: "1004"})
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
	if err := serveLocalCore(ctx, *port, "resolver-probe", *parent, mux); err != nil {
		log.Print("probe stopped")
	}
}
