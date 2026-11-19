package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Playback resolver updates are deliberately isolated from the production
// source sequence for the first validation phase. The host can later load a
// signed resolver module without changing the playback API.
const (
	playbackResolverManifestSchema = 1
	playbackResolverProduct        = "hongguo-playback-resolver"
	playbackResolverMaxManifest    = 64 * 1024
	playbackResolverMaxArtifact    = 32 * 1024 * 1024
)

// Keep this order aligned with the existing Android, desktop and webOS update
// channels. The direct URL remains the final fallback.
var playbackResolverProxies = []string{
	"https://gh-proxy.com/",
	"https://v4.gh-proxy.org/",
	"https://gh-proxy.org/",
	"https://ghfast.top/",
}

var playbackResolverVersionRE = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){2,}(?:[-+][A-Za-z0-9.-]+)?$`)

type playbackResolverManifest struct {
	Schema    int    `json:"schema"`
	Product   string `json:"product"`
	Version   string `json:"resolver_version"`
	Protocol  int    `json:"protocol"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	URL       string `json:"download_url"`
	Signature string `json:"signature"`
}

func playbackResolverSources(origin string, proxies []string) ([]string, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return nil, errors.New("resolver URL must be HTTPS without credentials")
	}
	if len(proxies) == 0 {
		proxies = playbackResolverProxies
	}
	result := make([]string, 0, len(proxies)+1)
	seen := make(map[string]struct{}, len(proxies)+1)
	for _, proxy := range proxies {
		proxy = strings.TrimSpace(proxy)
		if proxy == "" {
			continue
		}
		if !strings.HasSuffix(proxy, "/") {
			proxy += "/"
		}
		parsed, parseErr := url.Parse(proxy)
		if parseErr != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
			return nil, errors.New("resolver proxy must be HTTPS without credentials")
		}
		candidate := proxy + origin
		if _, ok := seen[candidate]; !ok {
			seen[candidate] = struct{}{}
			result = append(result, candidate)
		}
	}
	if _, ok := seen[origin]; !ok {
		result = append(result, origin)
	}
	return result, nil
}

func validatePlaybackResolverManifest(m playbackResolverManifest) error {
	if m.Schema != playbackResolverManifestSchema || m.Product != playbackResolverProduct ||
		!playbackResolverVersionRE.MatchString(m.Version) || m.Protocol < 1 ||
		m.Size <= 0 || m.Size > playbackResolverMaxArtifact ||
		!regexp.MustCompile(`^[a-fA-F0-9]{64}$`).MatchString(m.SHA256) || m.Signature == "" {
		return errors.New("invalid playback resolver manifest")
	}
	u, err := url.Parse(m.URL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid playback resolver download URL")
	}
	return nil
}

// The signature covers the metadata that controls activation. Signing a
// stable, explicit representation avoids relying on JSON object key order.
func playbackResolverSignatureMessage(m playbackResolverManifest) []byte {
	return []byte(strings.Join([]string{
		m.Product, m.Version, fmt.Sprintf("%d", m.Protocol), fmt.Sprintf("%d", m.Size),
		strings.ToLower(m.SHA256), m.URL,
	}, "\n"))
}

func verifyPlaybackResolverManifest(m playbackResolverManifest, publicKey ed25519.PublicKey) error {
	if err := validatePlaybackResolverManifest(m); err != nil {
		return err
	}
	signature, err := base64.StdEncoding.DecodeString(m.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize || len(publicKey) != ed25519.PublicKeySize ||
		!ed25519.Verify(publicKey, playbackResolverSignatureMessage(m), signature) {
		return errors.New("playback resolver signature mismatch")
	}
	return nil
}

func fetchPlaybackResolverManifest(ctx context.Context, client *http.Client, manifestURL string, publicKey ed25519.PublicKey, proxies []string) (playbackResolverManifest, error) {
	var result playbackResolverManifest
	sources, err := playbackResolverSources(manifestURL, proxies)
	if err != nil {
		return result, err
	}
	var last error
	for _, source := range sources {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if requestErr != nil {
			last = requestErr
			continue
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", "HongguoTV-PlaybackResolver/1")
		response, requestErr := resolverHTTPClient(client).Do(request)
		if requestErr != nil {
			last = requestErr
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, playbackResolverMaxManifest+1))
		response.Body.Close()
		if readErr != nil {
			last = readErr
			continue
		}
		if response.StatusCode != http.StatusOK {
			last = fmt.Errorf("resolver manifest HTTP %d", response.StatusCode)
			continue
		}
		if len(body) > playbackResolverMaxManifest {
			last = errors.New("resolver manifest too large")
			continue
		}
		if err = json.Unmarshal(body, &result); err != nil {
			last = errors.New("resolver manifest is not valid JSON")
			continue
		}
		if err = verifyPlaybackResolverManifest(result, publicKey); err != nil {
			last = err
			continue
		}
		return result, nil
	}
	if last == nil {
		last = errors.New("resolver manifest unavailable")
	}
	return result, last
}

// downloadPlaybackResolver verifies the manifest before writing anything and
// publishes the file with an atomic rename. A failed proxy or corrupt artifact
// cannot replace the previously active resolver.
func downloadPlaybackResolver(ctx context.Context, client *http.Client, m playbackResolverManifest, publicKey ed25519.PublicKey, directory, name string, proxies []string) (string, error) {
	if err := verifyPlaybackResolverManifest(m, publicKey); err != nil {
		return "", err
	}
	sources, err := playbackResolverSources(m.URL, proxies)
	if err != nil {
		return "", err
	}
	if filepath.Base(name) != name || name == "." || name == ".." {
		return "", errors.New("invalid resolver filename")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	var last error
	for _, source := range sources {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if requestErr != nil {
			last = requestErr
			continue
		}
		request.Header.Set("Accept", "application/wasm, application/octet-stream")
		request.Header.Set("User-Agent", "HongguoTV-PlaybackResolver/1")
		response, requestErr := resolverHTTPClient(client).Do(request)
		if requestErr != nil {
			last = requestErr
			continue
		}
		tmp, createErr := os.CreateTemp(directory, ".resolver-*")
		if createErr != nil {
			response.Body.Close()
			return "", createErr
		}
		tmpName := tmp.Name()
		written, copyErr := io.CopyN(tmp, response.Body, m.Size+1)
		response.Body.Close()
		if copyErr != nil && !errors.Is(copyErr, io.EOF) {
			last = copyErr
			_ = tmp.Close()
			_ = os.Remove(tmpName)
			continue
		}
		if response.StatusCode != http.StatusOK || written != m.Size {
			last = fmt.Errorf("resolver artifact HTTP %d or size mismatch", response.StatusCode)
			_ = tmp.Close()
			_ = os.Remove(tmpName)
			continue
		}
		if _, err = tmp.Seek(0, io.SeekStart); err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
			last = err
			continue
		}
		digest := sha256.New()
		if _, err = io.Copy(digest, tmp); err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
			last = err
			continue
		}
		if !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), m.SHA256) {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
			last = errors.New("resolver artifact SHA256 mismatch")
			continue
		}
		if err = tmp.Sync(); err == nil {
			err = tmp.Close()
		} else {
			_ = tmp.Close()
		}
		if err != nil {
			_ = os.Remove(tmpName)
			last = err
			continue
		}
		final := filepath.Join(directory, name)
		if err = os.Rename(tmpName, final); err != nil {
			_ = os.Remove(tmpName)
			last = err
			continue
		}
		return final, nil
	}
	if last == nil {
		last = errors.New("resolver artifact unavailable")
	}
	return "", last
}

func resolverHTTPClient(client *http.Client) *http.Client {
	result := &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 || request.URL.Scheme != "https" || request.URL.User != nil {
			return errors.New("unsafe resolver redirect")
		}
		return nil
	}}
	if client != nil {
		copy := *client
		if copy.Timeout > 0 {
			result.Timeout = copy.Timeout
		}
		result.Transport = copy.Transport
		// Resolver update and WASM requests must never inherit the core's
		// account cookie jar. The only state a resolver receives is the
		// normalized request and the explicitly allow-listed host callback.
		result.Jar = nil
		result.CheckRedirect = func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 || request.URL.Scheme != "https" || request.URL.User != nil {
				return errors.New("unsafe resolver redirect")
			}
			return nil
		}
	}
	return result
}

// updatePlaybackResolver is the complete host-side update transaction. It is
// intentionally separate from startup policy so Android, desktop and webOS
// can choose their own check cadence while sharing the same signed artifact
// and local activation behavior.
func updatePlaybackResolver(ctx context.Context, runtime *playbackResolverRuntime, client *http.Client, manifestURL string, publicKey ed25519.PublicKey, proxies []string) error {
	if runtime == nil {
		return errPlaybackResolverRuntimeUnavailable
	}
	manifest, err := fetchPlaybackResolverManifest(ctx, client, manifestURL, publicKey, proxies)
	if err != nil {
		return err
	}
	if activeVersion, ok := runtime.ActiveVersion(); ok {
		comparison, compareErr := comparePlaybackResolverVersions(manifest.Version, activeVersion)
		if compareErr != nil {
			return compareErr
		}
		if comparison <= 0 {
			return nil
		}
	}
	artifact, err := downloadPlaybackResolver(ctx, client, manifest, publicKey, runtime.dir, playbackResolverArtifactName(manifest.Version), proxies)
	if err != nil {
		return err
	}
	if err := runtime.Activate(ctx, manifest, artifact, newWASMPlaybackResolverLoader(resolverHTTPClient(client))); err != nil {
		_ = os.Remove(artifact)
		return err
	}
	return nil
}

func playbackResolverArtifactName(version string) string {
	// The manifest validator has already restricted this to numeric SemVer-like
	// characters. Keep each version in its own file so a failed activation can
	// never overwrite the last known-good artifact.
	return "resolver-" + version + ".wasm"
}
