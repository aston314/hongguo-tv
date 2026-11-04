package main

import (
	"encoding/base64"
	"encoding/binary"
	"net/http"
	"net/url"
	"strconv"
)

// Use the existing three-request budget: signed primary, signed alternate,
// then the original unsigned request for compatibility. Only an HTTP 200
// empty response advances the caller to another policy. Fixture endpoints
// must never escape to the public upstream.
func miniReelPlaybackAttemptPolicy(endpoint string, attempt int) (string, bool) {
	if attempt == 2 {
		return endpoint, false
	}
	if attempt == 1 && endpoint == miniReelAPIBase+miniReelAPIPath {
		return "https://api5-normal-hl.fqnovel.com" + miniReelAPIPath, true
	}
	return endpoint, true
}

// Sign the exact playback query and POST bytes, independently of account state.
// Keep the existing verified F13 branch 2 and playback profile; the account
// signer's default profile and its fixed vectors must remain unchanged.
func miniReelSignPlaybackRequest(params url.Values, body []byte, stamp int64, deviceID string) (string, http.Header, error) {
	params.Set("ts", strconv.FormatInt(stamp/1000, 10))
	query, headers, err := signPassportRequestVersion(params, body, stamp, deviceID, params.Get("version_name"))
	if err != nil {
		return "", nil, err
	}
	ts := uint32(stamp / 1000)
	var be [4]byte
	binary.BigEndian.PutUint32(be[:], ts)
	// These two fields are this profile's timestamp envelopes, not general
	// implementations of the platform's Argus/Ladon algorithms.
	headers.Set("X-Argus", base64.StdEncoding.EncodeToString(protocolLE(ts)))
	headers.Set("X-Ladon", base64.StdEncoding.EncodeToString(be[:]))
	headers.Set("Sdk-Version", "2")
	headers.Set("X-Xs-From-Web", "0")
	headers.Set("X-Tt-Dt", "")
	headers.Set("X-Tt-Store-Region", "cn")
	headers.Set("X-Tt-Store-Region-Src", "did")
	return query, headers, nil
}
