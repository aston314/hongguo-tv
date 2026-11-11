package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// fallback_api can encrypt the URL separately from the media content. The
// model's key_seed derives the URL key; spade_a remains the CENC content key.
func miniReelModelURL(raw string, model map[string]any) string {
	seedText := miniReelToString(model["key_seed"])
	if seedText == "" {
		if strings.HasPrefix(raw, "https://") {
			return raw
		}
		data, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			data, err = base64.RawStdEncoding.DecodeString(raw)
		}
		if err != nil {
			return ""
		}
		return string(data)
	}
	seed, err := base64.StdEncoding.DecodeString(seedText)
	if err != nil || len(seed) == 0 {
		return ""
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(data) < 20 || data[0] != 0xa8 || data[2] != 1 || data[3] != 0 || (len(data)-4)%aes.BlockSize != 0 {
		return ""
	}
	key := passportDeviceKey(seed)
	block, _ := aes.NewCipher(key[:16])
	plain := make([]byte, len(data)-4)
	cipher.NewCBCDecrypter(block, key[16:32]).CryptBlocks(plain, data[4:])
	pad := int(plain[len(plain)-1])
	if pad >= 1 && pad <= aes.BlockSize && pad <= len(plain) {
		for _, b := range plain[len(plain)-pad:] {
			if int(b) != pad {
				return ""
			}
		}
		plain = plain[:len(plain)-pad]
	}
	return strings.TrimRight(string(plain), "\x00")
}

func miniReelIsByteVC2(codec string) bool {
	return strings.EqualFold(codec, "bytevc2") || strings.EqualFold(codec, "bvc2")
}

func miniReelOnlyByteVC2(model map[string]any) bool {
	rows := miniReelMapsFromAny(model["video_list"])
	if len(rows) == 0 {
		return false
	}
	for _, row := range rows {
		meta, _ := row["video_meta"].(map[string]any)
		if !miniReelIsByteVC2(firstNonEmpty(miniReelToString(row["codec_type"]), miniReelToString(meta["codec_type"]))) {
			return false
		}
	}
	return true
}

// Do not parse/re-encode the signed query: preserve every other raw byte,
// including escaping, duplicate keys and parameter order.
func miniReelFallbackCodecURL(raw, codec string) string {
	base, query, _ := strings.Cut(raw, "?")
	kept := make([]string, 0)
	for _, part := range strings.Split(query, "&") {
		name, _, _ := strings.Cut(part, "=")
		decoded, _ := url.QueryUnescape(name)
		if decoded != "codec_type" && decoded != "force_codec" {
			kept = append(kept, part)
		}
	}
	if query == "" {
		kept = nil
	}
	return base + "?" + strings.Join(append(kept, codec), "&")
}

func miniReelSameFallbackVideo(reference, candidate map[string]any) bool {
	a, b := miniReelToString(reference["video_id"]), miniReelToString(candidate["video_id"])
	if a != "" && b != "" && a != b {
		return false
	}
	x, _ := strconv.ParseFloat(miniReelToString(reference["video_duration"]), 64)
	y, _ := strconv.ParseFloat(miniReelToString(candidate["video_duration"]), 64)
	return !(x > 0 && y > 0 && math.Abs(x-y) > 0.5)
}

// A healthy inline model never makes an extra request. Only an empty list or
// ByteVC2-only model follows fallback_api; codec variants are bounded to three
// and share the caller's existing provider deadline and cancellation.
func miniReelCompatibleModel(ctx context.Context, model map[string]any, client *http.Client) (map[string]any, error) {
	if len(miniReelMapsFromAny(model["video_list"])) > 0 && !miniReelOnlyByteVC2(model) {
		return model, nil
	}
	fallback := miniReelFallbackAPI(model["fallback_api"])
	if fallback == "" {
		return model, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	original, err := miniReelFetchFallbackModelWithClient(ctx, fallback, client)
	if err != nil {
		// This is an extra opportunity for a ByteVC2-only inline model.
		// A failed opportunity must not block the remaining original providers.
		if ctx.Err() == nil && miniReelOnlyByteVC2(model) && playbackPreparationDetails(err).BusinessCode == "" {
			return model, nil
		}
		return nil, err
	}
	if !miniReelSameFallbackVideo(model, original) {
		if miniReelOnlyByteVC2(model) {
			return model, nil
		}
		return nil, errors.New("fallback_api video identity or duration mismatch")
	}
	if !miniReelOnlyByteVC2(original) {
		return original, nil
	}
	for _, codec := range []string{"codec_type=1", "codec_type=0&force_codec=h264", "codec_type=3"} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		candidate, err := miniReelFetchFallbackModelWithClient(ctx, miniReelFallbackCodecURL(fallback, codec), client)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err != nil && playbackPreparationDetails(err).BusinessCode != "" {
			return nil, err
		}
		if err != nil || !miniReelSameFallbackVideo(model, candidate) || !miniReelSameFallbackVideo(original, candidate) {
			continue
		}
		if len(miniReelOptionsFromModel(candidate)) > 0 {
			return candidate, nil
		}
	}
	return original, nil
}
