// Command playback_resolver_manifest creates the signed manifest consumed by
// the embedded playback resolver updater. It deliberately accepts the
// signing key through an environment variable or a file, never a command-line
// argument, so CI logs and process listings cannot expose it.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	manifestSchema   = 1
	manifestProduct  = "hongguo-playback-resolver"
	manifestProtocol = 1
	maxArtifactSize  = 32 * 1024 * 1024
)

var versionPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){2,}(?:[-+][A-Za-z0-9.-]+)?$`)

type manifest struct {
	Schema    int    `json:"schema"`
	Product   string `json:"product"`
	Version   string `json:"resolver_version"`
	Protocol  int    `json:"protocol"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	URL       string `json:"download_url"`
	Signature string `json:"signature"`
}

func main() {
	artifactPath := flag.String("artifact", "", "path to resolver.wasm")
	version := flag.String("version", "", "resolver version")
	artifactURL := flag.String("artifact-url", "", "HTTPS URL from which the artifact is downloaded")
	outPath := flag.String("out", "", "manifest output path")
	keyFile := flag.String("private-key-file", "", "file containing a base64 or hexadecimal Ed25519 private key")
	publicKeyOut := flag.String("public-key-out", "", "optional file for the derived base64 public key")
	printPublicKey := flag.Bool("print-public-key", false, "print the derived base64 public key and exit")
	flag.Parse()

	privateKey, err := privateKeyFrom(*keyFile)
	if err != nil {
		fatal(err)
	}
	if *printPublicKey {
		fmt.Println(base64.StdEncoding.EncodeToString(privateKey.Public().(ed25519.PublicKey)))
		return
	}
	if *artifactPath == "" || *version == "" || *artifactURL == "" || *outPath == "" {
		fatal(errors.New("-artifact, -version, -artifact-url and -out are required"))
	}
	if !versionPattern.MatchString(*version) {
		fatal(errors.New("resolver version must contain at least three numeric components"))
	}
	if err := validateHTTPSURL(*artifactURL); err != nil {
		fatal(err)
	}
	contents, err := os.ReadFile(*artifactPath)
	if err != nil {
		fatal(fmt.Errorf("read artifact: %w", err))
	}
	if len(contents) == 0 || len(contents) > maxArtifactSize {
		fatal(errors.New("resolver artifact is empty or too large"))
	}
	digest := sha256.Sum256(contents)
	result := manifest{
		Schema:   manifestSchema,
		Product:  manifestProduct,
		Version:  *version,
		Protocol: manifestProtocol,
		Size:     int64(len(contents)),
		SHA256:   hex.EncodeToString(digest[:]),
		URL:      *artifactURL,
	}
	result.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, signatureMessage(result)))
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fatal(fmt.Errorf("encode manifest: %w", err))
	}
	if err := writeAtomic(*outPath, append(encoded, '\n'), 0600); err != nil {
		fatal(fmt.Errorf("write manifest: %w", err))
	}
	if *publicKeyOut != "" {
		publicKey := base64.StdEncoding.EncodeToString(privateKey.Public().(ed25519.PublicKey)) + "\n"
		if err := writeAtomic(*publicKeyOut, []byte(publicKey), 0600); err != nil {
			fatal(fmt.Errorf("write public key: %w", err))
		}
	}
}

func privateKeyFrom(path string) (ed25519.PrivateKey, error) {
	var raw string
	if path != "" {
		contents, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read private key: %w", err)
		}
		raw = string(contents)
	} else {
		raw = os.Getenv("PLAYBACK_RESOLVER_PRIVATE_KEY")
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("set PLAYBACK_RESOLVER_PRIVATE_KEY or -private-key-file")
	}
	var decoded []byte
	if value, err := base64.StdEncoding.DecodeString(raw); err == nil && (len(value) == ed25519.SeedSize || len(value) == ed25519.PrivateKeySize) {
		decoded = value
	} else if value, err := hex.DecodeString(raw); err == nil {
		decoded = value
	}
	switch len(decoded) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(decoded), nil
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(decoded), nil
	default:
		return nil, errors.New("private key must be a 32-byte seed or 64-byte Ed25519 key in base64 or hex")
	}
}

func validateHTTPSURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.ContainsAny(raw, "\r\n") {
		return errors.New("artifact URL must be HTTPS without credentials, query or fragment")
	}
	return nil
}

func signatureMessage(m manifest) []byte {
	return []byte(strings.Join([]string{
		m.Product,
		m.Version,
		fmt.Sprintf("%d", m.Protocol),
		fmt.Sprintf("%d", m.Size),
		strings.ToLower(m.SHA256),
		m.URL,
	}, "\n"))
}

func writeAtomic(path string, contents []byte, mode os.FileMode) error {
	if path == "" || filepath.Base(path) == "." || filepath.Base(path) == ".." {
		return errors.New("invalid output path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".playback-resolver-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(contents); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "playback_resolver_manifest:", err)
	os.Exit(2)
}
