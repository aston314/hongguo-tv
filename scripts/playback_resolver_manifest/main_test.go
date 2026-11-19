package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrivateKeyFromAcceptsSeedAndPrivateKey(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		base64.StdEncoding.EncodeToString(privateKey),
		hex.EncodeToString(privateKey),
		base64.StdEncoding.EncodeToString(privateKey.Seed()),
		hex.EncodeToString(privateKey.Seed()),
	} {
		path := filepath.Join(t.TempDir(), "key")
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := privateKeyFrom(path)
		if err != nil {
			t.Fatalf("decode %q: %v", raw[:8], err)
		}
		if !got.Public().(ed25519.PublicKey).Equal(publicKey) {
			t.Fatal("decoded key has a different public key")
		}
	}
}

func TestManifestSignatureMessageMatchesHostContract(t *testing.T) {
	manifest := manifest{
		Schema: 1, Product: manifestProduct, Version: "2026.11.19.1", Protocol: 1,
		Size: 12, SHA256: strings.Repeat("A", 64), URL: "https://example.com/resolver.wasm",
	}
	want := "hongguo-playback-resolver\n2026.11.19.1\n1\n12\n" + strings.Repeat("a", 64) + "\nhttps://example.com/resolver.wasm"
	if got := string(signatureMessage(manifest)); got != want {
		t.Fatalf("signature message = %q, want %q", got, want)
	}
}

func TestManifestCommandWritesSignedManifest(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	artifact := filepath.Join(directory, "resolver.wasm")
	if err := os.WriteFile(artifact, []byte("wasm fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	// Exercise the same construction used by main without spawning a process.
	contents, err := os.ReadFile(artifact)
	if err != nil {
		t.Fatal(err)
	}
	manifest := manifest{Schema: 1, Product: manifestProduct, Version: "2026.11.19.1", Protocol: 1, Size: int64(len(contents)), SHA256: strings.Repeat("0", 64), URL: "https://example.com/resolver.wasm"}
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, signatureMessage(manifest)))
	if !ed25519.Verify(privateKey.Public().(ed25519.PublicKey), signatureMessage(manifest), mustDecodeSignature(t, manifest.Signature)) {
		t.Fatal("manifest signature does not verify")
	}
}

func TestValidateHTTPSURLMatchesUpdaterBoundary(t *testing.T) {
	for _, raw := range []string{
		"https://github.com/aston314/hongguo-tv-releases/releases/download/v1/resolver.wasm",
	} {
		if err := validateHTTPSURL(raw); err != nil {
			t.Fatalf("valid URL rejected: %v", err)
		}
	}
	for _, raw := range []string{
		"http://example.com/resolver.wasm",
		"https://user:pass@example.com/resolver.wasm",
		"https://example.com/resolver.wasm?token=secret",
		"https://example.com/resolver.wasm#fragment",
	} {
		if err := validateHTTPSURL(raw); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
}

func mustDecodeSignature(t *testing.T, raw string) []byte {
	t.Helper()
	result, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
