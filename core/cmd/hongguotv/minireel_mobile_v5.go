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
	"time"
)

const miniReelMobileV5Endpoint = "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/multi_video_model/player/v1"
const miniReelMobileV5UA = "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)"
const miniReelMobileV5MaxJSON = 2 << 20

type miniReelMobileV5Source struct {
	endpoint string
	identity *miniReelPlaybackDeviceCache
	client   *http.Client
}

// Independent anonymous session, never an account or legacy one-shot identity.
var productionMobileV5 = &miniReelMobileV5Source{endpoint: miniReelMobileV5Endpoint, identity: newMiniReelPlaybackDeviceCache(registerMiniReelPlaybackDevice)}

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
	for attempt := 0; attempt < 2; attempt++ {
		options, e := s.request(ctx, vid, codecMode, contentType, d)
		if e == nil {
			return options, nil
		}
		err = e
		// Only one confirmed empty response can rotate this reusable session.
		if attempt > 0 || !errors.Is(err, errMiniReelVideoModelEmpty) || ctx.Err() != nil {
			break
		}
		d, e = s.identity.refreshAfterEmpty(ctx, d)
		if e != nil {
			return nil, err
		}
	}
	return nil, err
}

func (s *miniReelMobileV5Source) request(ctx context.Context, vid, codecMode, contentType string, d miniReelDevice) (options []miniReelOption, err error) {
	started := time.Now()
	diag := playbackPreparationDiagnostic{Stage: "multi_video_model", Code: "VIDEO_MODEL_SIGN"}
	defer func() { err = finishPlaybackPreparation(err, diag, started) }()
	// Content type belongs to the selected episode, including the existing 1003
	// route. The normal short-drama request is exactly the verified 1004 shape.
	raw, err := json.Marshal(map[string]any{"biz_param": map[string]any{"detail_page_version": 0, "device_level": 3, "disable_digg_stat": false, "disable_video_relate_book": false, "need_all_video_definition": true, "need_mp4_align": false, "use_os_player": false, "use_server_dns": false, "video_platform": 1024}, "mixed_video_id_map": map[string][]string{contentType: {vid}}, "dr_scene": "player"})
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
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint+"?"+query, bytes.NewReader(body))
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
		return nil, errMiniReelVideoModelEmpty
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
