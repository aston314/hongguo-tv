package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPlaybackResolverSourcesKeepProxyOrderAndDirectFallback(t *testing.T) {
	sources, err := playbackResolverSources("https://example.com/resolver.json", []string{"https://proxy-a/", "https://proxy-a", "https://proxy-b/path"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"https://proxy-a/https://example.com/resolver.json",
		"https://proxy-b/path/https://example.com/resolver.json",
		"https://example.com/resolver.json",
	}
	if strings.Join(sources, "\n") != strings.Join(want, "\n") {
		t.Fatalf("sources = %#v, want %#v", sources, want)
	}
}

func TestResolverHTTPClientDoesNotInheritAccountCookies(t *testing.T) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	resolverURL, err := url.Parse("https://example.com/resolver.wasm")
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(resolverURL, []*http.Cookie{{Name: "sessionid", Value: "account-secret"}})
	var received *http.Request
	client := resolverHTTPClient(&http.Client{
		Jar: jar,
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			received = request.Clone(request.Context())
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("ok")), Header: make(http.Header), Request: request}, nil
		}),
	})
	request, err := http.NewRequest(http.MethodGet, resolverURL.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if received == nil || received.Header.Get("Cookie") != "" {
		t.Fatalf("resolver request inherited account cookie: %v", received.Header.Get("Cookie"))
	}
}

func TestUpdatePlaybackResolverSkipsSameVersionArtifactDownload(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	artifact := []byte("resolver wasm fixture")
	sum := sha256.Sum256(artifact)
	manifest := playbackResolverManifest{Schema: 1, Product: playbackResolverProduct, Version: "2026.11.20.1", Protocol: 1, Size: int64(len(artifact)), SHA256: hex.EncodeToString(sum[:]), URL: "https://example.invalid/resolver.wasm"}
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, playbackResolverSignatureMessage(manifest)))
	active := &stubPlaybackResolver{metadata: playbackResolverMetadata{Name: playbackResolverWASMName, Version: manifest.Version, Protocol: manifest.Protocol}}
	runtime := newPlaybackResolverRuntime(t.TempDir(), &stubPlaybackResolver{metadata: playbackResolverMetadata{Name: builtInPlaybackResolverName, Version: builtInPlaybackResolverVersion, Protocol: 1}}, publicKey)
	runtime.active = active
	runtime.manifest = &manifest
	var calls atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(mustJSON(manifest)))), Header: make(http.Header), Request: request}, nil
	})}
	if err := updatePlaybackResolver(context.Background(), runtime, client, manifest.URL, publicKey, []string{"https://proxy.invalid/"}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("same-version update downloaded an artifact: HTTP calls=%d", calls.Load())
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func TestPlaybackResolverManifestAndArtifactUseProxyThenAtomicDownload(t *testing.T) {
	artifact := []byte("resolver wasm fixture")
	sum := sha256.Sum256(artifact)
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := playbackResolverManifest{Schema: 1, Product: playbackResolverProduct, Version: "2026.11.19.1", Protocol: 1, Size: int64(len(artifact)), SHA256: hex.EncodeToString(sum[:]), URL: "https://origin.invalid/resolver.wasm"}
	manifest.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, playbackResolverSignatureMessage(manifest)))
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var proxyOneCalls, proxyTwoCalls atomic.Int32
	proxyOne := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyOneCalls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxyOne.Close()
	proxyTwo := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyTwoCalls.Add(1)
		if strings.Contains(r.URL.Path, "resolver.json") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(manifestBytes)
			return
		}
		_, _ = w.Write(artifact)
	}))
	defer proxyTwo.Close()
	client := proxyTwo.Client()
	transport := client.Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // test certificates only
	client.Transport = transport
	directory := t.TempDir()
	fetched, err := fetchPlaybackResolverManifest(context.Background(), client, "https://origin.invalid/resolver.json", publicKey, []string{proxyOne.URL + "/", proxyTwo.URL + "/"})
	if err != nil {
		t.Fatal(err)
	}
	if fetched.Version != manifest.Version || proxyOneCalls.Load() != 1 || proxyTwoCalls.Load() != 1 {
		t.Fatalf("manifest=%+v proxy calls=%d/%d", fetched, proxyOneCalls.Load(), proxyTwoCalls.Load())
	}
	path, err := downloadPlaybackResolver(context.Background(), client, fetched, publicKey, directory, "resolver.wasm", []string{proxyOne.URL + "/", proxyTwo.URL + "/"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(artifact) {
		t.Fatalf("downloaded artifact = %q, err=%v", got, err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".resolver-") {
			t.Fatal("temporary resolver file was not cleaned")
		}
	}
}

func TestPlaybackResolverRejectsBadSignatureAndDigest(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, otherPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "x") }))
	defer server.Close()
	m := playbackResolverManifest{Schema: 1, Product: playbackResolverProduct, Version: "2026.11.19.1", Protocol: 1, Size: 1, SHA256: strings.Repeat("0", 64), URL: server.URL + "/resolver.wasm", Signature: base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))}
	if err := verifyPlaybackResolverManifest(m, publicKey); err == nil {
		t.Fatal("bad signature accepted")
	}
	client := server.Client()
	transport := client.Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // test certificates only
	client.Transport = transport
	m.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(otherPrivateKey, playbackResolverSignatureMessage(m)))
	_, err = downloadPlaybackResolver(context.Background(), client, m, publicKey, t.TempDir(), "resolver.wasm", []string{server.URL + "/"})
	if err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("bad signature error = %v", err)
	}
	m.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, playbackResolverSignatureMessage(m)))
	_, err = downloadPlaybackResolver(context.Background(), client, m, publicKey, t.TempDir(), "resolver.wasm", []string{server.URL + "/"})
	if err == nil || !strings.Contains(err.Error(), "SHA256") {
		t.Fatalf("bad digest error = %v", err)
	}
}
