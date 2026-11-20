package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const miniReelMobileV5PrimaryEndpoint = "https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/player/v1"
const miniReelMobileV5AlternateEndpoint = "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/player/v1"

const miniReelMobileV5UA = "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)"
const miniReelMobileV5RecoveryUA = "com.phoenix.read/73932 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)"
const miniReelMobileV5MaxJSON = 2 << 20

type miniReelV5EmptyResponseError struct {
	retryAfter bool
}

func (e *miniReelV5EmptyResponseError) Error() string { return errMiniReelVideoModelEmpty.Error() }
func (e *miniReelV5EmptyResponseError) Unwrap() error { return errMiniReelVideoModelEmpty }

func miniReelV5EmptyBackoff(err error) bool {
	var empty *miniReelV5EmptyResponseError
	return errors.As(err, &empty) && empty.retryAfter
}

type miniReelMobileV5Source struct {
	endpoint          string
	alternateEndpoint string
	identity          *miniReelPlaybackDeviceCache
	client            *http.Client
}

// Independent anonymous session, never an account or legacy one-shot identity.
var productionMobileV5 = &miniReelMobileV5Source{endpoint: miniReelMobileV5PrimaryEndpoint, alternateEndpoint: miniReelMobileV5AlternateEndpoint, identity: newMiniReelPlaybackDeviceCache(registerMiniReelPlaybackDevice)}

func miniReelMobileV5Query(d miniReelDevice) url.Values {
	return url.Values{"aid": {"8662"}, "app_name": {"novelread"}, "version_code": {"74332"}, "version_name": {"7.4.3.32"}, "channel": {"vivo_8662_64"}, "device_platform": {"android"}, "device_type": {"PGT-AN10"}, "os_version": {"12"}, "update_version_code": {"74332"}, "iid": {d.installID}, "cdid": {d.cdid}, "device_id": {d.deviceID}}
}

func (s *miniReelMobileV5Source) options(ctx context.Context, vid, codecMode, contentType string) ([]miniReelOption, error) {
	if !miniReelIDRE.MatchString(vid) {
		return nil, errors.New("invalid playback episode")
	}
	if _, err := normalizeMiniReelCodecMode(codecMode); err != nil {
		return nil, err
	}
	contentType, err := normalizeMiniReelContentType(contentType)
	if err != nil {
		return nil, err
	}
	d, err := s.identity.get(ctx)
	if err != nil {
		return nil, wrapPlaybackPreparation(err, "device_register", "DEVICE_REGISTER_FAILED")
	}
	options, e := s.request(ctx, s.endpoint, vid, codecMode, contentType, d)
	if e == nil {
		return options, nil
	}
	// v7.7 treats an HTTP 200 empty body as a domain-specific failure. Retry
	// the same signed request on the alternate host, keeping the same
	// registered identity. Only after both V5 hosts return an empty body do we
	// try the signed bodyless video_tab recovery with that same identity.
	if errors.Is(e, errMiniReelVideoModelEmpty) && !miniReelV5EmptyBackoff(e) && s.alternateEndpoint != "" {
		alternate, alternateErr := s.request(ctx, s.alternateEndpoint, vid, codecMode, contentType, d)
		if alternateErr == nil {
			return alternate, nil
		}
		if errors.Is(alternateErr, errMiniReelVideoModelEmpty) && !miniReelV5EmptyBackoff(alternateErr) {
			if recovered, recoveryErr := s.recoverVideoTab(ctx, vid, codecMode, d); recoveryErr == nil && len(recovered) > 0 {
				return recovered, nil
			} else if ctx.Err() != nil {
				return nil, ctx.Err()
			}
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, e
}

func (s *miniReelMobileV5Source) request(ctx context.Context, endpoint, vid, codecMode, contentType string, d miniReelDevice) (options []miniReelOption, err error) {
	started := time.Now()
	diag := playbackPreparationDiagnostic{Stage: "multi_video_model", Code: "VIDEO_MODEL_SIGN"}
	defer func() { err = finishPlaybackPreparation(err, diag, started) }()
	// Content type belongs to the selected episode, including the existing 1003
	// route. The normal short-drama request is exactly the verified 1004 shape.
	raw, err := json.Marshal(map[string]any{"biz_param": map[string]any{"detail_page_version": 0, "device_level": 1, "disable_digg_stat": false, "disable_video_relate_book": false, "need_all_video_definition": true, "need_mp4_align": false, "use_os_player": false, "use_server_dns": false, "video_platform": 1024}, "mixed_video_id_map": map[string][]string{contentType: {vid}}, "dr_scene": "player"})
	if err != nil {
		return nil, errors.New("playback payload failed")
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err = zw.Write(raw); err != nil {
		return nil, err
	}
	if err = zw.Close(); err != nil {
		return nil, err
	}
	body := buf.Bytes()
	query, headers, err := signPlaybackV5(miniReelMobileV5Query(d), body, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"?"+query, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = headers
	req.Header.Set("User-Agent", miniReelMobileV5UA)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Accept", "application/json")
	diag.Code = "VIDEO_MODEL_TRANSPORT"
	res, err := miniReelNoRedirectClient(s.client, 8*time.Second).Do(req)
	if err != nil {
		var u *url.Error
		if errors.As(err, &u) {
			return nil, fmt.Errorf("mobile playback transport failed: %w", u.Err)
		}
		return nil, err
	}
	defer res.Body.Close()
	diag.HTTPStatus = &res.StatusCode
	diag.Code = "VIDEO_MODEL_HTTP"
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("mobile playback HTTP %d", res.StatusCode)
	}
	diag.Code = "VIDEO_MODEL_READ"
	data, err := miniReelReadLimited(res.Body, miniReelMobileV5MaxJSON)
	if err != nil {
		return nil, err
	}
	n := len(data)
	diag.ResponseBytes = &n
	if len(bytes.TrimSpace(data)) == 0 {
		diag.Code = "VIDEO_MODEL_EMPTY"
		return nil, &miniReelV5EmptyResponseError{retryAfter: strings.TrimSpace(res.Header.Get("Retry-After")) != ""}
	}
	diag.Code = "VIDEO_MODEL_JSON"
	var envelope map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if dec.Decode(&envelope) != nil || envelope == nil || !json.Valid(data) {
		return nil, errors.New("mobile playback invalid JSON")
	}
	if code := miniReelBusinessCodeFromEnvelope(envelope); code != "" && code != "0" {
		return miniReelOptionsFromEnvelope(ctx, vid, envelope, s.client, codecMode, &diag)
	}
	// Reject wrong/missing episodes before the common parser's direct-model
	// legacy convenience path. Both observed v5 map shapes are supported.
	entries, _ := envelope["data"].(map[string]any)
	if nested, ok := entries[contentType].(map[string]any); ok {
		entries = nested
	}
	entry, ok := entries[vid].(map[string]any)
	if !ok || entry["video_model"] == nil {
		diag.Code = "VIDEO_MODEL_MISSING"
		return nil, errMiniReelVideoModelMissing
	}
	envelope["data"] = map[string]any{vid: entry}
	return miniReelOptionsFromEnvelope(ctx, vid, envelope, s.client, codecMode, &diag)
}

// recoverVideoTab mirrors the upstream v7.7 recovery: the V5 POSTs and this
// GET share one registered identity, while the GET uses the 7.4.3.32 query
// profile and the v5 Medusa/Helios/Khronos signer. A missing/wrong VID keeps
// the original empty error so another provider can make the next decision.
func (s *miniReelMobileV5Source) recoverVideoTab(ctx context.Context, vid, codecMode string, d miniReelDevice) ([]miniReelOption, error) {
	stamp := time.Now().UnixMilli()
	params := miniReelMobileV5VideoTabParams(vid, d)
	keys := miniReelMobileV5VideoTabKeys()
	query, headers, err := signPlaybackV5Keys(params, nil, stamp, keys)
	if err != nil {
		return nil, err
	}
	// A body-less GET has no Content-Type or SS-STUB. The signer returns the
	// latter for the generic profile, so remove it explicitly here.
	headers.Del("X-SS-STUB")
	headers.Set("User-Agent", miniReelMobileV5RecoveryUA)
	headers.Set("Accept", "application/json; charset=utf-8")
	headers.Set("Accept-Language", "zh-CN,zh;q=0.9")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, miniReelVideoTabBase+miniReelVideoTabPath+"?"+query, nil)
	if err != nil {
		return nil, err
	}
	request.Header = headers
	response, err := miniReelNoRedirectClient(s.client, 15*time.Second).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("MiniReel video_tab recovery HTTP %d", response.StatusCode)
	}
	data, err := miniReelReadLimited(response.Body, miniReelMaxJSONBytes)
	if err != nil || len(bytes.TrimSpace(data)) == 0 {
		return nil, errMiniReelVideoModelEmpty
	}
	var root map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil || root == nil {
		return nil, errors.New("MiniReel video_tab recovery response is invalid JSON")
	}
	if code := miniReelBusinessCodeFromEnvelope(root); code != "" && code != "0" {
		return nil, fmt.Errorf("MiniReel video_tab recovery rejected request (code %s)", code)
	}
	envelope, ok := miniReelVideoTabEnvelopeExact(vid, root)
	if !ok {
		return nil, errMiniReelVideoModelEmpty
	}
	return miniReelOptionsFromEnvelope(ctx, vid, envelope, s.client, codecMode, &playbackPreparationDiagnostic{Stage: "video_tab", Code: "VIDEO_TAB_JSON"})
}

func miniReelMobileV5VideoTabKeys() []string {
	return []string{"aid", "app_name", "version_code", "version_name", "channel", "device_platform", "device_type", "os_version", "update_version_code", "iid", "cdid", "device_id", "video_id", "video_id_type", "device_level", "need_all_video_definition", "need_mp4_align", "use_os_player", "video_platform", "source", "from_video_id", "_rticket"}
}

func miniReelMobileV5VideoTabParams(vid string, d miniReelDevice) url.Values {
	params := miniReelMobileV5Query(d)
	for key, value := range map[string]string{
		"video_id": vid, "video_id_type": "0", "device_level": "1",
		"need_all_video_definition": "1", "need_mp4_align": "0", "use_os_player": "0",
		"video_platform": "1024", "source": "0", "from_video_id": "",
	} {
		params.Set(key, value)
	}
	return params
}

func miniReelVideoTabEnvelopeExact(vid string, root map[string]any) (map[string]any, bool) {
	data, ok := asMap(root["data"])
	if !ok {
		return nil, false
	}
	rows, ok := asMap(data["video_model_data"])
	if !ok {
		rows = data
	}
	row, ok := asMap(rows[vid])
	if !ok {
		return nil, false
	}
	model := row["video_model"]
	if text := miniReelToString(model); strings.HasPrefix(strings.TrimSpace(text), "{") {
		var decoded any
		if json.Unmarshal([]byte(text), &decoded) == nil {
			model = decoded
		}
	}
	if _, ok := asMap(model); !ok {
		return nil, false
	}
	return map[string]any{"code": 0, "data": map[string]any{vid: map[string]any{"video_model": model}}}, true
}
