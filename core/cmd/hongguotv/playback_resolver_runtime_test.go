package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPlaybackResolverRuntimeActivationAndRestore(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	artifact := []byte("signed resolver module")
	artifactPath := filepath.Join(directory, "resolver.wasm")
	if err := os.WriteFile(artifactPath, artifact, 0600); err != nil {
		t.Fatal(err)
	}
	manifest := signedRuntimeManifest(t, privateKey, "2026.11.20.1", "resolver.wasm", artifact)
	embedded := &stubPlaybackResolver{metadata: playbackResolverMetadata{Name: builtInPlaybackResolverName, Version: builtInPlaybackResolverVersion, Protocol: builtInPlaybackResolverProtocol}}
	remote := &stubPlaybackResolver{metadata: playbackResolverMetadata{Name: "remote-v5", Version: manifest.Version, Protocol: manifest.Protocol}}
	loader := func(_ context.Context, got playbackResolverManifest, path string) (playbackResolver, error) {
		if got.Version != manifest.Version || path != artifactPath {
			t.Fatalf("loader received manifest=%+v path=%s", got, path)
		}
		return remote, nil
	}
	runtime := newPlaybackResolverRuntime(directory, embedded, publicKey)
	if err := runtime.Activate(context.Background(), manifest, artifactPath, loader); err != nil {
		t.Fatal(err)
	}
	if got := runtime.Current().Metadata(); !reflect.DeepEqual(got, remote.metadata) {
		t.Fatalf("active metadata=%+v want=%+v", got, remote.metadata)
	}
	if _, err := os.Stat(filepath.Join(directory, "playback-resolver-state.json")); err != nil {
		t.Fatalf("activation state missing: %v", err)
	}

	restored := newPlaybackResolverRuntime(directory, embedded, publicKey)
	if err := restored.Restore(context.Background(), loader); err != nil {
		t.Fatal(err)
	}
	if got := restored.Current().Metadata(); !reflect.DeepEqual(got, remote.metadata) {
		t.Fatalf("restored metadata=%+v want=%+v", got, remote.metadata)
	}
	if got, ok := restored.ActiveMetadata(); !ok || !reflect.DeepEqual(got, remote.metadata) {
		t.Fatalf("active metadata=%+v present=%t", got, ok)
	}
	if got, ok := restored.ActiveVersion(); !ok || got != manifest.Version {
		t.Fatalf("active version=%q present=%t", got, ok)
	}

	if err := os.WriteFile(artifactPath, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	failed := newPlaybackResolverRuntime(directory, embedded, publicKey)
	if err := failed.Restore(context.Background(), loader); err == nil {
		t.Fatal("tampered resolver restored")
	}
	if got := failed.Current().Metadata(); !reflect.DeepEqual(got, embedded.metadata) {
		t.Fatalf("failed restore did not fall back: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(directory, "playback-resolver-state.json")); !os.IsNotExist(err) {
		t.Fatalf("failed restore retained activation state: %v", err)
	}
}

func TestPlaybackResolverRuntimeActivatesWASMLoader(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	artifact := fixedPlaybackResolverWASM()
	artifactPath := filepath.Join(directory, "resolver.wasm")
	if err := os.WriteFile(artifactPath, artifact, 0600); err != nil {
		t.Fatal(err)
	}
	manifest := signedRuntimeManifest(t, privateKey, "2026.11.21.1", "resolver.wasm", artifact)
	embedded := &stubPlaybackResolver{metadata: playbackResolverMetadata{Name: builtInPlaybackResolverName, Version: builtInPlaybackResolverVersion, Protocol: builtInPlaybackResolverProtocol}}
	runtime := newPlaybackResolverRuntime(directory, embedded, publicKey)
	if err := runtime.Activate(context.Background(), manifest, artifactPath, loadWASMPlaybackResolver); err != nil {
		t.Fatal(err)
	}
	options, err := runtime.Current().Resolve(context.Background(), playbackResolverRequest{VID: "fixture", CodecMode: "default", ContentType: "1004"})
	if err != nil || len(options) != 1 || options[0].Quality != "720p" {
		t.Fatalf("active wasm options=%+v err=%v", options, err)
	}
}

func TestPlaybackResolverRuntimeFallsBackToEmbeddedOnModuleError(t *testing.T) {
	embedded := &stubPlaybackResolver{
		metadata: playbackResolverMetadata{Name: builtInPlaybackResolverName, Version: builtInPlaybackResolverVersion, Protocol: builtInPlaybackResolverProtocol},
		options:  []miniReelOption{{URL: "https://embedded.example/video.mp4", Codec: "h264", Quality: "720p"}},
	}
	active := &stubPlaybackResolver{
		metadata: playbackResolverMetadata{Name: playbackResolverWASMName, Version: "2026.11.21.1", Protocol: 1},
		err:      errors.New("module trap"),
	}
	runtime := newPlaybackResolverRuntime(t.TempDir(), embedded, nil)
	runtime.active = active
	options, err := runtime.Current().Resolve(context.Background(), playbackResolverRequest{VID: "1"})
	if err != nil || len(options) != 1 || options[0].URL != embedded.options[0].URL {
		t.Fatalf("fallback options=%+v err=%v", options, err)
	}
}

func TestPlaybackResolverRuntimeRejectsDowngradeAndKeepsPrevious(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	embedded := &stubPlaybackResolver{metadata: playbackResolverMetadata{Name: builtInPlaybackResolverName, Version: builtInPlaybackResolverVersion, Protocol: builtInPlaybackResolverProtocol}}
	current := &stubPlaybackResolver{metadata: playbackResolverMetadata{Name: "remote-v5", Version: "2026.11.20.1", Protocol: 1}}
	runtime := newPlaybackResolverRuntime(directory, embedded, publicKey)
	write := func(name string, contents []byte) string {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, contents, 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	goodBytes := []byte("current")
	goodPath := write("current.wasm", goodBytes)
	good := signedRuntimeManifest(t, privateKey, current.metadata.Version, "current.wasm", goodBytes)
	loader := func(_ context.Context, manifest playbackResolverManifest, _ string) (playbackResolver, error) {
		return &stubPlaybackResolver{metadata: playbackResolverMetadata{Name: "remote-v5", Version: manifest.Version, Protocol: manifest.Protocol}}, nil
	}
	if err := runtime.Activate(context.Background(), good, goodPath, loader); err != nil {
		t.Fatal(err)
	}

	downgradeBytes := []byte("older")
	downgradePath := write("older.wasm", downgradeBytes)
	downgrade := signedRuntimeManifest(t, privateKey, "2026.11.19.9", "older.wasm", downgradeBytes)
	if err := runtime.Activate(context.Background(), downgrade, downgradePath, loader); err == nil {
		t.Fatal("downgrade activated")
	}
	if got := runtime.Current().Metadata().Version; got != current.metadata.Version {
		t.Fatalf("downgrade replaced current version: %s", got)
	}

	nextBytes := []byte("new but unloadable")
	nextPath := write("next.wasm", nextBytes)
	next := signedRuntimeManifest(t, privateKey, "2026.11.21.1", "next.wasm", nextBytes)
	loaderFailure := func(context.Context, playbackResolverManifest, string) (playbackResolver, error) {
		return nil, errors.New("unsupported runtime")
	}
	if err := runtime.Activate(context.Background(), next, nextPath, loaderFailure); err == nil {
		t.Fatal("failed runtime activated")
	}
	if got := runtime.Current().Metadata().Version; got != current.metadata.Version {
		t.Fatalf("failed activation replaced current version: %s", got)
	}
}

func TestPlaybackResolverVersionComparison(t *testing.T) {
	for _, test := range []struct {
		a, b string
		want int
	}{
		{a: "2026.11.20.1", b: "2026.11.19.9", want: 1},
		{a: "2026.11.19.1", b: "2026.11.19.1", want: 0},
		{a: "1.2.3", b: "1.2.3.0", want: 0},
		{a: "1.2.3-beta", b: "1.2.3", want: 0},
	} {
		got, err := comparePlaybackResolverVersions(test.a, test.b)
		if err != nil || got != test.want {
			t.Fatalf("compare(%q,%q)=%d err=%v want=%d", test.a, test.b, got, err, test.want)
		}
	}
	if _, err := comparePlaybackResolverVersions("1.2", "1.2.3"); err == nil {
		t.Fatal("invalid version accepted")
	}
}

func signedRuntimeManifest(t *testing.T, privateKey ed25519.PrivateKey, version, name string, artifact []byte) playbackResolverManifest {
	t.Helper()
	digest := sha256.Sum256(artifact)
	manifest := playbackResolverManifest{
		Schema:   playbackResolverManifestSchema,
		Product:  playbackResolverProduct,
		Version:  version,
		Protocol: builtInPlaybackResolverProtocol,
		Size:     int64(len(artifact)),
		SHA256:   hex.EncodeToString(digest[:]),
		URL:      "https://example.invalid/" + name,
	}
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, playbackResolverSignatureMessage(manifest)))
	return manifest
}
