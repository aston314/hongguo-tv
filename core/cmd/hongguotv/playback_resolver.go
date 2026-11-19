package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
)

// playbackResolver is the stable host contract for obtaining playable source
// models. A WASM resolver owns anonymous registration, signing and model/codec
// resolution. The host owns bounded HTTP, media validation/decryption and the
// production source sequence. No account session crosses the module boundary.
type playbackResolver interface {
	Resolve(context.Context, playbackResolverRequest) ([]miniReelOption, error)
	Metadata() playbackResolverMetadata
}

type playbackResolverRequest struct {
	VID         string
	CodecMode   string
	ContentType string
}

type playbackResolverMetadata struct {
	Name     string
	Version  string
	Protocol int
}

const (
	builtInPlaybackResolverName     = "embedded-v5"
	builtInPlaybackResolverVersion  = "2026.11.19.1"
	builtInPlaybackResolverProtocol = 1
)

// The manifest endpoint belongs to the product's existing public release
// channel. Users never enter it. The signing key is injected into release
// builds; an empty key deliberately disables resolver traffic in development
// builds until the first real module is reviewed and signed.
const playbackResolverManifestURL = "https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/playback-resolver.json"

var playbackResolverPublicKeyRaw string

type embeddedPlaybackResolver struct {
	source *miniReelMobileV5Source
}

func (r *embeddedPlaybackResolver) Resolve(ctx context.Context, request playbackResolverRequest) ([]miniReelOption, error) {
	if r == nil || r.source == nil {
		return nil, errMiniReelVideoModelMissing
	}
	return r.source.options(ctx, request.VID, request.CodecMode, request.ContentType)
}

func (*embeddedPlaybackResolver) Metadata() playbackResolverMetadata {
	return playbackResolverMetadata{Name: builtInPlaybackResolverName, Version: builtInPlaybackResolverVersion, Protocol: builtInPlaybackResolverProtocol}
}

var productionPlaybackResolver playbackResolver = &embeddedPlaybackResolver{source: productionMobileV5}

// Production starts on the embedded implementation. Startup may restore or
// activate a verified local WASM module through this runtime; the resolver
// returned by Current still falls back to embedded V5 on every module error.
var (
	productionPlaybackResolverRuntimeMu sync.RWMutex
	productionPlaybackResolverRuntime   = newPlaybackResolverRuntime(filepath.Join(defaultLibraryDir(), "playback-resolver"), productionPlaybackResolver, nil)
)

func currentProductionPlaybackResolver() playbackResolver {
	productionPlaybackResolverRuntimeMu.RLock()
	runtime := productionPlaybackResolverRuntime
	productionPlaybackResolverRuntimeMu.RUnlock()
	return runtime.Current()
}

// configureProductionPlaybackResolverRuntime binds the resolver to the same
// private data directory as the rest of the core. It is called once during
// startup, before playback jobs are created, so --data-dir cannot accidentally
// leave a resolver in the user's default config directory.
func configureProductionPlaybackResolverRuntime(dataDir string, publicKey ed25519.PublicKey) *playbackResolverRuntime {
	if strings.TrimSpace(dataDir) == "" {
		dataDir = defaultLibraryDir()
	}
	runtime := newPlaybackResolverRuntime(filepath.Join(dataDir, "playback-resolver"), productionPlaybackResolver, publicKey)
	productionPlaybackResolverRuntimeMu.Lock()
	productionPlaybackResolverRuntime = runtime
	productionPlaybackResolverRuntimeMu.Unlock()
	return runtime
}

func productionPlaybackResolverRuntimeSnapshot() *playbackResolverRuntime {
	productionPlaybackResolverRuntimeMu.RLock()
	defer productionPlaybackResolverRuntimeMu.RUnlock()
	return productionPlaybackResolverRuntime
}

// restoreProductionPlaybackResolver restores a previously activated module.
// An empty key means the application is running the embedded resolver-only
// configuration; it deliberately does not trust arbitrary files in the data
// directory.
func restoreProductionPlaybackResolver(ctx context.Context) error {
	runtime := productionPlaybackResolverRuntimeSnapshot()
	if runtime == nil || !runtime.Configured() {
		return nil
	}
	return runtime.Restore(ctx, newWASMPlaybackResolverLoader(http.DefaultClient))
}

// parsePlaybackResolverPublicKey accepts the deployment-safe text forms used
// by launchers and CI: base64 (preferred) or exactly 64 hexadecimal chars.
// It rejects all other input instead of silently enabling unsigned modules.
func parsePlaybackResolverPublicKey(raw string) (ed25519.PublicKey, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && len(decoded) == ed25519.PublicKeySize {
		return ed25519.PublicKey(decoded), nil
	}
	if decoded, err := hex.DecodeString(raw); err == nil && len(decoded) == ed25519.PublicKeySize {
		return ed25519.PublicKey(decoded), nil
	}
	return nil, errors.New("playback resolver public key must be 32-byte base64 or hex")
}

func (s miniReelPlaybackSources) resolver() playbackResolver {
	if s.resolverOverride != nil {
		return s.resolverOverride
	}
	// Keep test/custom source lists source-compatible while callers migrate to
	// the stable resolver contract.
	if s.mobileV5 != nil {
		return &embeddedPlaybackResolver{source: s.mobileV5}
	}
	return nil
}

type playbackResolverWithFallback struct {
	active   playbackResolver
	embedded playbackResolver
}

func (r playbackResolverWithFallback) Resolve(ctx context.Context, request playbackResolverRequest) ([]miniReelOption, error) {
	if r.active != nil {
		options, err := r.active.Resolve(ctx, request)
		if err == nil && len(options) > 0 {
			return options, nil
		}
		if r.embedded == nil && err != nil {
			return nil, err
		}
	}
	if r.embedded == nil {
		return nil, errPlaybackResolverRuntimeUnavailable
	}
	return r.embedded.Resolve(ctx, request)
}

func (r playbackResolverWithFallback) Metadata() playbackResolverMetadata {
	if r.active != nil {
		return r.active.Metadata()
	}
	if r.embedded != nil {
		return r.embedded.Metadata()
	}
	return playbackResolverMetadata{}
}
