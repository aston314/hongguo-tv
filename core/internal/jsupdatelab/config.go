// Package jsupdatelab is only imported by the isolated resolverjsprobe executable.
// It trusts a disposable lab public key and a fixed ADB-reverse loopback fixture.
// No private key, user-entered URL, production channel or resolver server exists.
package jsupdatelab

import (
	"context"
	_ "embed"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/jsupdate"
)

//go:embed publickey.txt
var publicKey string

const Origin = "http://127.0.0.1:18872"

func New(ctx context.Context, dir string, source []byte, transport jsresolver.Transport) (*jsupdate.Manager, error) {
	key, _ := hex.DecodeString(strings.TrimSpace(publicKey))
	return jsupdate.New(ctx, jsupdate.Config{Dir: dir, ManifestURL: Origin + "/manifest.json", PublicKey: key, Embedded: source, EmbeddedVersion: jsresolver.Version, Vectors: jsresolver.SigningVectors(), VectorCount: jsresolver.SigningVectorCount, Transport: transport, Client: &http.Client{}, AllowedURL: func(raw string) bool { return raw == Origin+"/manifest.json" || raw == Origin+"/resolver.js" }, Routes: func(raw string) []string { return []string{raw} }})
}
func Stale(source []byte) []byte {
	// Deliberate test-only algorithm failure. There is no native escape route.
	return []byte(strings.Replace(string(source), "resolve:resolve,", `resolve:function(){return JSON.stringify({error_code:'SIMULATED_OLD_ALGORITHM',error_stage:'resolver_js'})},`, 1))
}
