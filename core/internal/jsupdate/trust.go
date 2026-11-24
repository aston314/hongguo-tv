package jsupdate

import (
	"crypto/ed25519"
	_ "embed"
	"encoding/hex"
	"strings"
)

//go:embed publickey.hex
var trustedKey string

// PublicKey returns the stable channel's trust anchor. Private signing material
// is never included in the application, script, or public release repository.
func PublicKey() ed25519.PublicKey {
	b, _ := hex.DecodeString(strings.TrimSpace(trustedKey))
	return ed25519.PublicKey(b)
}
