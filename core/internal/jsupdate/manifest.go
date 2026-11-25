// Package jsupdate verifies and atomically activates signed local playback rules.
package jsupdate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
)

const Product = "hongguo-playback-resolver"
const MaxManifest = 8192
const HostAPI = 1
const ProfileProduct = "hongguo-playback-profile"
const MaxProfile = 256 * 1024

type Artifact struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	HostAPI  int    `json:"host_api"`
	URL      string `json:"url"`
	Size     int    `json:"size"`
	SHA256   string `json:"sha256"`
}
type Manifest struct {
	Schema    int       `json:"schema"`
	Product   string    `json:"product"`
	Revision  uint64    `json:"revision"`
	Enabled   bool      `json:"enabled"`
	IssuedAt  int64     `json:"issued_at"`
	ExpiresAt int64     `json:"expires_at"`
	Module    *Artifact `json:"module"`
}
type Envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

var digestRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
var versionRE = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

// Sign signs exact canonical payload bytes, including disable and revision.
// Publishing keys never belong in an APK or this package.
func Sign(m Manifest, key ed25519.PrivateKey) (Envelope, error) {
	b, e := json.Marshal(m)
	if e != nil || len(key) != ed25519.PrivateKeySize {
		return Envelope{}, errors.New("invalid signing input")
	}
	return Envelope{base64.StdEncoding.EncodeToString(b), base64.StdEncoding.EncodeToString(ed25519.Sign(key, b))}, nil
}
func strictJSON(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func verify(env Envelope, key ed25519.PublicKey, now time.Time, incoming bool, allowed func(string) bool) (Manifest, error) {
	return verifyPolicy(env, key, now, incoming, allowed, Product, jsresolver.MaxScript)
}
func verifyPolicy(env Envelope, key ed25519.PublicKey, now time.Time, incoming bool, allowed func(string) bool, product string, maxArtifact int) (Manifest, error) {
	var m Manifest
	b, e := base64.StdEncoding.DecodeString(env.Payload)
	sig, se := base64.StdEncoding.DecodeString(env.Signature)
	if e != nil || se != nil || len(b) > MaxManifest || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, b, sig) {
		return m, errors.New("signature_rejected")
	}
	if strictJSON(b, &m) != nil {
		return m, errors.New("manifest_rejected")
	}
	canonical, _ := json.Marshal(m)
	if !bytes.Equal(b, canonical) || m.Schema != 1 || m.Product != product || m.Revision == 0 || m.Revision > 9007199254740991 || m.IssuedAt <= 0 || m.ExpiresAt <= m.IssuedAt || m.ExpiresAt-m.IssuedAt > int64((30*24*time.Hour)/time.Second) {
		return m, errors.New("manifest_rejected")
	}
	if incoming && (m.IssuedAt > now.Add(5*time.Minute).Unix() || m.ExpiresAt <= now.Unix()) {
		return m, errors.New("manifest_expired_or_future")
	}
	if !m.Enabled {
		if m.Module != nil {
			return m, errors.New("disable_has_module")
		}
		return m, nil
	}
	a := m.Module
	if a == nil || !versionRE.MatchString(a.Version) || a.Protocol != 1 || a.HostAPI != HostAPI || a.Size < 1 || a.Size > maxArtifact || !digestRE.MatchString(a.SHA256) || !allowed(a.URL) {
		return m, errors.New("module_rejected")
	}
	return m, nil
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
