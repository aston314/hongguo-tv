package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const playbackResolverRuntimeStateSchema = 1

var errPlaybackResolverRuntimeUnavailable = errors.New("playback resolver runtime unavailable")

// playbackResolverRuntimeLoader is deliberately injected. Platform-specific
// local WASM loaders can implement it without changing activation, signature,
// rollback or source-selection policy in the host.
type playbackResolverRuntimeLoader func(context.Context, playbackResolverManifest, string) (playbackResolver, error)

type closablePlaybackResolver interface {
	Close(context.Context) error
}

type playbackResolverRuntimeState struct {
	Schema   int                      `json:"schema"`
	Artifact string                   `json:"artifact"`
	Manifest playbackResolverManifest `json:"manifest"`
}

type playbackResolverRuntime struct {
	mu        sync.RWMutex
	dir       string
	state     string
	publicKey ed25519.PublicKey
	embedded  playbackResolver
	active    playbackResolver
	manifest  *playbackResolverManifest
}

func newPlaybackResolverRuntime(directory string, embedded playbackResolver, publicKey ed25519.PublicKey) *playbackResolverRuntime {
	return &playbackResolverRuntime{
		dir:       directory,
		state:     filepath.Join(directory, "playback-resolver-state.json"),
		publicKey: append(ed25519.PublicKey(nil), publicKey...),
		embedded:  embedded,
	}
}

func (r *playbackResolverRuntime) Configured() bool {
	return r != nil && len(r.publicKey) == ed25519.PublicKeySize
}

func (r *playbackResolverRuntime) Current() playbackResolver {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.active != nil {
		return playbackResolverWithFallback{active: r.active, embedded: r.embedded}
	}
	return r.embedded
}

func (r *playbackResolverRuntime) ActiveMetadata() (playbackResolverMetadata, bool) {
	if r == nil {
		return playbackResolverMetadata{}, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.active == nil || r.manifest == nil {
		return playbackResolverMetadata{}, false
	}
	return r.active.Metadata(), true
}

func (r *playbackResolverRuntime) ActiveVersion() (string, bool) {
	if r == nil {
		return "", false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.active == nil || r.manifest == nil {
		return "", false
	}
	return r.manifest.Version, true
}

// Activate validates the already-downloaded artifact, asks the platform
// loader to instantiate it, then persists the activation record atomically.
// The old active resolver remains usable until every step succeeds.
func (r *playbackResolverRuntime) Activate(ctx context.Context, manifest playbackResolverManifest, artifact string, loader playbackResolverRuntimeLoader) error {
	if r == nil || loader == nil {
		return errPlaybackResolverRuntimeUnavailable
	}
	if err := verifyPlaybackResolverManifest(manifest, r.publicKey); err != nil {
		return err
	}
	if err := validatePlaybackResolverActivationManifest(manifest); err != nil {
		return err
	}
	if err := r.validateArtifactPath(artifact); err != nil {
		return err
	}
	if err := verifyPlaybackResolverArtifactFile(artifact, manifest); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	r.mu.RLock()
	previous := r.manifest
	r.mu.RUnlock()
	if previous != nil {
		cmp, err := comparePlaybackResolverVersions(manifest.Version, previous.Version)
		if err != nil {
			return err
		}
		if cmp < 0 {
			return errors.New("playback resolver downgrade rejected")
		}
	}
	loaded, err := loader(ctx, manifest, artifact)
	if err != nil {
		return fmt.Errorf("load playback resolver: %w", err)
	}
	if loaded == nil {
		return errors.New("load playback resolver returned nil")
	}
	if metadata := loaded.Metadata(); metadata.Name == "" || metadata.Version != manifest.Version || metadata.Protocol != manifest.Protocol {
		return errors.New("loaded playback resolver metadata mismatch")
	}
	state := playbackResolverRuntimeState{Schema: playbackResolverRuntimeStateSchema, Artifact: filepath.Base(artifact), Manifest: manifest}
	if err := writePlaybackResolverRuntimeState(r.state, state); err != nil {
		_ = closePlaybackResolver(ctx, loaded)
		return err
	}
	r.mu.Lock()
	previousActive := r.active
	r.active = loaded
	copyManifest := manifest
	r.manifest = &copyManifest
	r.mu.Unlock()
	_ = closePlaybackResolver(ctx, previousActive)
	return nil
}

// Restore activates only a previously persisted, fully verified resolver. Any
// failed restore clears the activation record and leaves the embedded resolver
// as the safe fallback.
func (r *playbackResolverRuntime) Restore(ctx context.Context, loader playbackResolverRuntimeLoader) error {
	if r == nil || loader == nil {
		return errPlaybackResolverRuntimeUnavailable
	}
	b, err := os.ReadFile(r.state)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var state playbackResolverRuntimeState
	if len(b) > 128*1024 || json.Unmarshal(b, &state) != nil || state.Schema != playbackResolverRuntimeStateSchema {
		return r.clearFailedRestore(errors.New("invalid playback resolver state"))
	}
	if err := verifyPlaybackResolverManifest(state.Manifest, r.publicKey); err != nil {
		return r.clearFailedRestore(err)
	}
	if err := validatePlaybackResolverActivationManifest(state.Manifest); err != nil {
		return r.clearFailedRestore(err)
	}
	artifact := filepath.Join(r.dir, state.Artifact)
	if err := r.validateArtifactPath(artifact); err != nil {
		return r.clearFailedRestore(err)
	}
	if err := verifyPlaybackResolverArtifactFile(artifact, state.Manifest); err != nil {
		return r.clearFailedRestore(err)
	}
	loaded, err := loader(ctx, state.Manifest, artifact)
	if err != nil {
		return r.clearFailedRestore(fmt.Errorf("restore playback resolver: %w", err))
	}
	if loaded == nil {
		return r.clearFailedRestore(errors.New("restore playback resolver returned nil"))
	}
	metadata := loaded.Metadata()
	if metadata.Name == "" || metadata.Version != state.Manifest.Version || metadata.Protocol != state.Manifest.Protocol {
		return r.clearFailedRestore(errors.New("restored playback resolver metadata mismatch"))
	}
	r.mu.Lock()
	previousActive := r.active
	r.active = loaded
	copyManifest := state.Manifest
	r.manifest = &copyManifest
	r.mu.Unlock()
	_ = closePlaybackResolver(ctx, previousActive)
	return nil
}

func closePlaybackResolver(ctx context.Context, resolver playbackResolver) error {
	if closable, ok := resolver.(closablePlaybackResolver); ok {
		return closable.Close(ctx)
	}
	return nil
}

func (r *playbackResolverRuntime) clearFailedRestore(err error) error {
	r.mu.Lock()
	r.active = nil
	r.manifest = nil
	r.mu.Unlock()
	_ = os.Remove(r.state)
	return err
}

func (r *playbackResolverRuntime) validateArtifactPath(path string) error {
	if r.dir == "" || path == "" {
		return errors.New("playback resolver directory is not configured")
	}
	root, err := filepath.Abs(r.dir)
	if err != nil {
		return err
	}
	candidate, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, candidate)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.Base(rel) != rel {
		return errors.New("playback resolver artifact must be in its private directory")
	}
	if filepath.Base(candidate) == "" || strings.HasPrefix(filepath.Base(candidate), ".") {
		return errors.New("invalid playback resolver artifact name")
	}
	return nil
}

func validatePlaybackResolverActivationManifest(m playbackResolverManifest) error {
	if err := validatePlaybackResolverManifest(m); err != nil {
		return err
	}
	if m.Protocol != builtInPlaybackResolverProtocol {
		return fmt.Errorf("unsupported playback resolver protocol %d", m.Protocol)
	}
	return nil
}

func verifyPlaybackResolverArtifactFile(path string, m playbackResolverManifest) error {
	lstat, err := os.Lstat(path)
	if err != nil || !lstat.Mode().IsRegular() {
		return errors.New("playback resolver artifact is not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() != m.Size {
		return errors.New("playback resolver artifact size mismatch")
	}
	digest := sha256.New()
	if _, err := io.CopyN(digest, f, m.Size); err != nil {
		return err
	}
	if !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), m.SHA256) {
		return errors.New("playback resolver artifact SHA256 mismatch")
	}
	return nil
}

func writePlaybackResolverRuntimeState(path string, state playbackResolverRuntimeState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".resolver-state-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(b)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func comparePlaybackResolverVersions(a, b string) (int, error) {
	parse := func(value string) ([]int, error) {
		if !playbackResolverVersionRE.MatchString(value) {
			return nil, errors.New("invalid playback resolver version")
		}
		base := strings.SplitN(value, "-", 2)[0]
		base = strings.SplitN(base, "+", 2)[0]
		parts := strings.Split(base, ".")
		result := make([]int, len(parts))
		for i, part := range parts {
			n, err := strconv.Atoi(part)
			if err != nil {
				return nil, err
			}
			result[i] = n
		}
		return result, nil
	}
	aa, err := parse(a)
	if err != nil {
		return 0, err
	}
	bb, err := parse(b)
	if err != nil {
		return 0, err
	}
	for i := 0; i < len(aa) || i < len(bb); i++ {
		av, bv := 0, 0
		if i < len(aa) {
			av = aa[i]
		}
		if i < len(bb) {
			bv = bb[i]
		}
		if av < bv {
			return -1, nil
		}
		if av > bv {
			return 1, nil
		}
	}
	return 0, nil
}
