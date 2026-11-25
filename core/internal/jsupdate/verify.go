package jsupdate

import (
	"crypto/ed25519"
	"time"
)

// VerifyStoredControl is used by the publisher to validate the preceding signed
// control even after expiry. All signature, product and artifact restrictions
// still apply; only incoming freshness is omitted for a stored high-water mark.
func VerifyStoredControl(env Envelope, key ed25519.PublicKey) (Manifest, error) {
	return verify(env, key, time.Now(), false, OfficialURL)
}
func VerifyStoredProfileControl(env Envelope, key ed25519.PublicKey) (Manifest, error) {
	return verifyPolicy(env, key, time.Now(), false, ProfileURL, ProfileProduct, MaxProfile)
}
