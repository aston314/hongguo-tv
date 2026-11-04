package main

import (
	"encoding/base64"
	"encoding/binary"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
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
	query, headers, err := signPassportRequestVersionWithEncoder(params, body, stamp, deviceID, params.Get("version_name"), miniReelPlaybackQueryEncode)
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

// The app signer preserves the device profile's insertion order and applies
// Python/urllib-style quoting. Query byte order is part of the signature input.
func miniReelPlaybackQueryEncode(values url.Values) string {
	ordered := []string{
		"ac", "channel", "aid", "app_name", "version_code", "version_name", "device_platform", "os", "ssmix",
		"device_type", "device_brand", "language", "os_api", "os_version", "manifest_version_code", "resolution", "dpi",
		"update_version_code", "host_abi", "dragon_device_type", "pv_player", "compliance_status", "need_personal_recommend",
		"player_so_load", "is_android_pad_screen", "iid", "device_id", "cdid", "ts", "_rticket",
	}
	seen := make(map[string]bool, len(ordered))
	parts := make([]string, 0, len(values))
	add := func(key string) {
		if seen[key] {
			return
		}
		seen[key] = true
		for _, value := range values[key] {
			parts = append(parts, miniReelQuote(key)+"="+miniReelQuote(value))
		}
	}
	for _, key := range ordered {
		add(key)
	}
	// Preserve future optional fields without making the signed request drop
	// them; url.Values ordering is deterministic for these uncommon additions.
	remaining := make([]string, 0, len(values))
	for key := range values {
		if !seen[key] {
			remaining = append(remaining, key)
		}
	}
	sort.Strings(remaining)
	for _, key := range remaining {
		add(key)
	}
	return strings.Join(parts, "&")
}

func miniReelQuote(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}
