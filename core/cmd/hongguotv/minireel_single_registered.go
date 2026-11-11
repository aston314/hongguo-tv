package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const singleRegisteredEndpoint = "https://api5-normal-sinfonlineb.fqnovel.com" + miniReelSinglePath
const singleRegisteredDeviceBase = "https://log.snssdk.com"
const singleRegisteredUA = "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)"

func singleRegisteredQuery(d miniReelDevice) url.Values {
	return url.Values{"aid": {"8662"}, "app_name": {"novelread"}, "version_code": {"73532"}, "version_name": {"7.3.5.32"}, "manifest_version_code": {"73532"}, "update_version_code": {"73532"}, "channel": {"update_64"}, "device_platform": {"android"}, "os": {"android"}, "ssmix": {"a"}, "device_type": {"25053RT47C"}, "device_brand": {"Redmi"}, "language": {"zh"}, "os_api": {"36"}, "os_version": {"16"}, "resolution": {"1280*2772"}, "dpi": {"520"}, "ac": {"wifi"}, "device_id": {d.deviceID}, "iid": {d.installID}}
}
func registerSingleRegisteredDevice(ctx context.Context, base string, client *http.Client) (d miniReelDevice, err error) {
	started := time.Now()
	diag := playbackPreparationDiagnostic{Stage: "device_register", Code: "DEVICE_REGISTER_FAILED"}
	defer func() { err = finishPlaybackPreparation(err, diag, started) }()
	p, err := newPassportDevice()
	if err != nil {
		return d, err
	}
	h := map[string]any{"display_name": "红果免费短剧", "aid": 8662, "app_version": "7.3.5.32", "version_code": 73532, "manifest_version_code": 73532, "update_version_code": 73532, "channel": "update_64", "package": "com.phoenix.read", "app_language": "zh", "os": "Android", "os_version": "16", "os_api": 36, "device_model": "25053RT47C", "device_brand": "Redmi", "device_manufacturer": "Xiaomi", "cpu_abi": "arm64-v8a", "density_dpi": 520, "display_density": "xxhdpi", "resolution": "2772x1280", "language": "zh", "timezone": 8, "access": "wifi", "openudid": p.OpenUDID, "clientudid": p.ClientUDID, "cdid": p.CDID, "region": "CN", "tz_name": "Asia/Shanghai", "tz_offset": 28800, "sim_region": "cn", "device_platform": "android", "not_request_sender": 0, "is_system_app": 0, "sdk_flavor": "china", "rom": "OS2.0", "rom_version": "BP2A.250605.031.A3"}
	stamp := time.Now().UnixMilli()
	body, _ := json.Marshal(map[string]any{"magic_tag": "ss_app_log", "header": h, "_gen_time": stamp})
	q := singleRegisteredQuery(d)
	q.Del("device_id")
	q.Del("iid")
	reqID, e := passportUUID()
	if e != nil {
		return d, e
	}
	q.Set("req_id", reqID)
	q.Set("_rticket", strconv.FormatInt(stamp, 10))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/service/2/device_register/?"+q.Encode(), bytes.NewReader(body))
	if err != nil {
		return d, err
	}
	req.Header.Set("User-Agent", singleRegisteredUA)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Accept", "application/json")
	res, err := miniReelNoRedirectClient(client, miniReelDeviceTimeout).Do(req)
	if err != nil {
		return d, err // The diagnostic wrapper exposes only the classified network reason.
	}
	defer res.Body.Close()
	diag.HTTPStatus = &res.StatusCode
	if res.StatusCode != 200 {
		return d, fmt.Errorf("single playback registration HTTP %d", res.StatusCode)
	}
	data, err := miniReelReadLimited(res.Body, 64<<10)
	if err != nil {
		return d, err
	}
	var envelope map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if dec.Decode(&envelope) != nil {
		return d, errors.New("single playback registration invalid JSON")
	}
	d.deviceID = firstNonEmpty(miniReelToString(envelope["device_id_str"]), miniReelToString(envelope["device_id"]))
	d.installID = firstNonEmpty(miniReelToString(envelope["install_id_str"]), miniReelToString(envelope["install_id"]))
	if !miniReelIDRE.MatchString(d.deviceID) || !miniReelIDRE.MatchString(d.installID) || strings.Trim(d.deviceID, "0") == "" || strings.Trim(d.installID, "0") == "" {
		return miniReelDevice{}, errors.New("single playback registration missing identity")
	}
	return d, nil
}

type miniReelSingleRegisteredSource struct {
	endpoint string
	identity *miniReelPlaybackDeviceCache
	client   *http.Client
}

var productionSingleRegistered = &miniReelSingleRegisteredSource{endpoint: singleRegisteredEndpoint, identity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
	ctx, cancel := context.WithTimeout(context.Background(), miniReelDeviceTimeout)
	defer cancel()
	return registerSingleRegisteredDevice(ctx, singleRegisteredDeviceBase, nil)
})}

func (s *miniReelSingleRegisteredSource) options(ctx context.Context, vid, codecMode string) ([]miniReelOption, error) {
	d, err := s.identity.get(ctx)
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		options, e := s.request(ctx, vid, codecMode, d)
		if e == nil && len(options) > 0 {
			return options, nil
		}
		err = e
		// Refresh only a confirmed HTTP 200 empty body, never codec/quality errors.
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
func (s *miniReelSingleRegisteredSource) request(ctx context.Context, vid, codecMode string, d miniReelDevice) (options []miniReelOption, err error) {
	start := time.Now()
	diag := playbackPreparationDiagnostic{Stage: "video_model", Code: "VIDEO_MODEL_SIGN"}
	defer func() { err = finishPlaybackPreparation(err, diag, start) }()
	body, _ := json.Marshal(map[string]any{"video_id": vid, "content_type": 1, "biz_param": map[string]any{"need_all_video_definition": true, "video_platform": 3}})
	query, headers, err := signSingleRegistered(singleRegisteredQuery(d), body, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint+"?"+query, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = headers
	req.Header.Set("User-Agent", singleRegisteredUA)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-XS-From-Web", "0")
	req.Header.Set("Sdk-Version", "2")
	diag.Code = "VIDEO_MODEL_TRANSPORT"
	res, err := miniReelNoRedirectClient(s.client, 4*time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	diag.HTTPStatus = &res.StatusCode
	diag.Code = "VIDEO_MODEL_HTTP"
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("single playback HTTP %d", res.StatusCode)
	}
	diag.Code = "VIDEO_MODEL_READ"
	data, err := miniReelReadLimited(res.Body, miniReelMaxJSONBytes)
	if err != nil {
		return nil, err
	}
	n := len(data)
	diag.ResponseBytes = &n
	diag.Code = "VIDEO_MODEL_EMPTY"
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, errMiniReelVideoModelEmpty
	}
	diag.Code = "VIDEO_MODEL_JSON"
	var envelope map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if dec.Decode(&envelope) != nil || envelope == nil {
		return nil, errors.New("single playback invalid JSON")
	}
	// This profile also returns a direct data.video_list or base64 JSON model.
	if data, ok := envelope["data"].(map[string]any); ok {
		if v, ok := data["video_model"].(string); ok {
			if b, e := base64.StdEncoding.DecodeString(v); e == nil && json.Valid(b) {
				data["video_model"] = string(b)
			}
		}
		if data["video_model"] == nil && (data["video_list"] != nil || data["fallback_api"] != nil) {
			envelope["data"] = map[string]any{"video_model": data}
		}
	}
	options, err = miniReelOptionsFromEnvelope(ctx, vid, envelope, s.client, codecMode, &diag)
	if err == nil && len(options) == 0 {
		diag.Code = "VIDEO_MODEL_NO_QUALITY"
		err = miniReelNoCompatibleOptionsError(codecMode)
	}
	return options, err
}
