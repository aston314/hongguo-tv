// Package playbackresolver contains only anonymous playback resolution. It has
// no HTTP client, socket, filesystem, account store, player or WASM runtime.
package playbackresolver

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

type miniReelOption = resolverwire.Option
type miniReelDevice struct{ deviceID, installID, cdid string }
type registrationSession struct {
	DeviceID, InstallID string
	Device              *passportDevice
}
type Transport func(context.Context, resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error)
type Error struct{ Code, Stage string }

func (e *Error) Error() string         { return e.Code + " at " + e.Stage }
func failure(stage, code string) error { return &Error{Code: code, Stage: stage} }

// The host serializes module calls. One guest owns one anonymous identity.
type Resolver struct {
	do           Transport
	device       miniReelDevice
	ready        bool
	refreshAfter time.Time
}

func New(do Transport) *Resolver { return &Resolver{do: do} }

func validID(value string) bool {
	if len(value) < 1 || len(value) > 32 {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func decode(data []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if !json.Valid(data) {
		return errors.New("invalid JSON")
	}
	return dec.Decode(out)
}
func firstNonEmpty(values ...string) string {
	for _, s := range values {
		if s != "" {
			return s
		}
	}
	return ""
}

func (r *Resolver) register(ctx context.Context) (miniReelDevice, error) {
	const stage = "device_register"
	d, err := newPassportDevice()
	if err != nil {
		return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_FAILED")
	}
	now := time.Now()
	stamp := now.UnixMilli()
	var seed [32]byte
	if _, err = rand.Read(seed[:]); err != nil {
		return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_FAILED")
	}
	body, err := passportTTEncrypt(d.payload(stamp), seed[:])
	if err != nil {
		return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_FAILED")
	}
	q := passportQuery(registrationSession{Device: d})
	q.Del("device_id")
	q.Del("iid")
	q.Set("tt_data", "a")
	q.Set("ts", strconv.FormatInt(now.Unix(), 10))
	q.Set("_rticket", strconv.FormatInt(stamp, 10))
	q.Set("package", "com.phoenix.read")
	h := map[string]string{
		"User-Agent": defaultHongguoUA, "Content-Type": "application/octet-stream;tt-data=a", "Accept": "application/json; charset=utf-8,application/x-protobuf",
		"Content-Encoding": "gzip", "X-Tt-Request-Tag": "t=0;n=1", "Log-Encode-Type": "gzip", "Lc": "102", "Sdk-Version": "2",
		"Passport-Sdk-Version": "60755", "Passport-Sdk-Settings": "device_transfer_s_0,device_transfer_ab_1", "X-SS-DP": "8662", "X-Vc-Bdturing-Sdk-Version": "4.0.3.cn",
		"X-Tt-Store-Region": "cn", "X-Tt-Store-Region-Src": "did", "X-Khronos": strconv.FormatInt(now.Unix(), 10),
		"X-Argus": base64.StdEncoding.EncodeToString(protocolLE(uint32(now.Unix()))), "X-SS-Req-Ticket": q.Get("_rticket"),
	}
	m := md5.Sum(body)
	h["X-SS-STUB"] = hex.EncodeToString(m[:])
	nonce, err := protocolRandom()
	if err != nil {
		return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_FAILED")
	}
	h["X-Gorgon"] = passportGorgon(q.Encode(), body, uint32(now.Unix()), uint16(nonce))
	response, err := r.do(ctx, resolverwire.HTTPRequest{Method: "POST", URL: passportDeviceAPI + "/service/2/device_register/?" + q.Encode(), Headers: h, Body: body})
	if err != nil {
		return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_FAILED")
	}
	if response.Status != 200 {
		return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_HTTP")
	}
	data := response.Body
	if bytes.HasPrefix(data, []byte{0x74, 0x63, 5, 0x10, 0, 0}) {
		data, err = passportTTDecrypt(data)
		if err != nil {
			return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_INVALID")
		}
	}
	var root map[string]any
	if decode(data, &root) != nil {
		return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_INVALID")
	}
	did := firstNonEmpty(miniReelToString(root["device_id_str"]), miniReelToString(root["device_id"]))
	iid := firstNonEmpty(miniReelToString(root["install_id_str"]), miniReelToString(root["install_id"]))
	if !validID(did) || !validID(iid) || did == "0" || iid == "0" {
		return miniReelDevice{}, failure(stage, "DEVICE_REGISTER_INVALID")
	}
	return miniReelDevice{deviceID: did, installID: iid, cdid: d.CDID}, nil
}

func (r *Resolver) Resolve(ctx context.Context, request resolverwire.Request) ([]resolverwire.Option, error) {
	if !validID(request.VID) {
		return nil, failure("multi_video_model", "INVALID_VIDEO_ID")
	}
	if _, err := normalizeMiniReelCodecMode(request.CodecMode); err != nil {
		return nil, failure("multi_video_model", "INVALID_CODEC_MODE")
	}
	contentType, err := normalizeMiniReelContentType(request.ContentType)
	if err != nil {
		return nil, failure("multi_video_model", "INVALID_CONTENT_TYPE")
	}
	request.ContentType = contentType
	if !r.ready {
		r.device, err = r.register(ctx)
		if err != nil {
			return nil, err
		}
		r.ready = true
	}
	for attempt := 0; attempt < 2; attempt++ {
		options, err := r.model(ctx, request)
		if err == nil {
			return options, nil
		}
		var e *Error
		if attempt > 0 || !errors.As(err, &e) || e.Code != "VIDEO_MODEL_EMPTY" || time.Now().Before(r.refreshAfter) {
			return nil, err
		}
		r.refreshAfter = time.Now().Add(10 * time.Minute)
		device, registrationError := r.register(ctx)
		if registrationError != nil {
			return nil, err
		}
		r.device = device
	}
	return nil, failure("multi_video_model", "VIDEO_MODEL_EMPTY")
}

func (r *Resolver) model(ctx context.Context, request resolverwire.Request) ([]resolverwire.Option, error) {
	const stage = "multi_video_model"
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(map[string]any{"biz_param": map[string]any{"detail_page_version": 0, "device_level": 3, "disable_digg_stat": false, "disable_video_relate_book": false, "need_all_video_definition": true, "need_mp4_align": false, "use_os_player": false, "use_server_dns": false, "video_platform": 1024}, "mixed_video_id_map": map[string][]string{request.ContentType: {request.VID}}, "dr_scene": "player"})
	if err != nil {
		return nil, failure(stage, "VIDEO_MODEL_SIGN")
	}
	var buffer bytes.Buffer
	zw := gzip.NewWriter(&buffer)
	if _, err = zw.Write(raw); err != nil {
		return nil, failure(stage, "VIDEO_MODEL_SIGN")
	}
	if zw.Close() != nil {
		return nil, failure(stage, "VIDEO_MODEL_SIGN")
	}
	body := buffer.Bytes()
	query, headers, err := signPlaybackV5(miniReelMobileV5Query(r.device), body, time.Now().UnixMilli())
	if err != nil {
		return nil, failure(stage, "VIDEO_MODEL_SIGN")
	}
	h := map[string]string{"User-Agent": miniReelMobileV5UA, "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", "Accept": "application/json"}
	for key := range headers {
		h[key] = headers.Get(key)
	}
	response, err := r.do(ctx, resolverwire.HTTPRequest{Method: "POST", URL: miniReelMobileV5Endpoint + "?" + query, Headers: h, Body: body})
	if err != nil {
		return nil, failure(stage, "VIDEO_MODEL_TRANSPORT")
	}
	if response.Status != 200 {
		return nil, failure(stage, "VIDEO_MODEL_HTTP")
	}
	if len(bytes.TrimSpace(response.Body)) == 0 {
		return nil, failure(stage, "VIDEO_MODEL_EMPTY")
	}
	var envelope map[string]any
	if decode(response.Body, &envelope) != nil {
		return nil, failure(stage, "VIDEO_MODEL_JSON")
	}
	if code := miniReelBusinessCodeFromEnvelope(envelope); code != "" && code != "0" {
		return nil, failure(stage, "VIDEO_MODEL_BUSINESS")
	}
	entries, _ := envelope["data"].(map[string]any)
	if nested, ok := entries[request.ContentType].(map[string]any); ok {
		entries = nested
	}
	entry, ok := entries[request.VID].(map[string]any)
	if !ok || entry["video_model"] == nil {
		return nil, failure(stage, "VIDEO_MODEL_MISSING")
	}
	var model map[string]any
	switch value := entry["video_model"].(type) {
	case map[string]any:
		model = value
	case string:
		if json.Unmarshal([]byte(value), &model) != nil {
			return nil, failure(stage, "VIDEO_MODEL_JSON")
		}
	}
	if model == nil {
		return nil, failure(stage, "VIDEO_MODEL_MISSING")
	}
	compatible, err := r.compatible(ctx, model)
	if err != nil {
		return nil, err
	}
	options := miniReelOptionsFromModel(compatible)
	if len(options) == 0 {
		return nil, failure(stage, "VIDEO_MODEL_LIST_EMPTY")
	}
	return options, nil
}

func (r *Resolver) fallback(ctx context.Context, raw string) (map[string]any, error) {
	const stage = "fallback_api"
	if _, err := miniReelValidateFallbackURL(raw); err != nil {
		return nil, failure(stage, "FALLBACK_API_FAILED")
	}
	response, err := r.do(ctx, resolverwire.HTTPRequest{Method: "GET", URL: raw, Headers: map[string]string{"User-Agent": miniReelFallbackUA, "Accept": "application/json; charset=utf-8,application/x-protobuf"}})
	if err != nil {
		return nil, failure(stage, "FALLBACK_API_FAILED")
	}
	if response.Status != 200 {
		return nil, failure(stage, "FALLBACK_API_HTTP")
	}
	var root map[string]any
	if decode(response.Body, &root) != nil {
		return nil, failure(stage, "FALLBACK_API_INVALID")
	}
	for _, key := range []string{"Code", "code"} {
		if code := miniReelToString(root[key]); code != "" && code != "0" {
			return nil, failure(stage, "FALLBACK_API_BUSINESS")
		}
	}
	info, ok := root["video_info"].(map[string]any)
	if !ok {
		return nil, failure(stage, "FALLBACK_API_INVALID")
	}
	for _, key := range []string{"Code", "code"} {
		if code := miniReelToString(info[key]); code != "" && code != "0" {
			return nil, failure(stage, "FALLBACK_API_BUSINESS")
		}
	}
	model, ok := info["data"].(map[string]any)
	if !ok {
		return nil, failure(stage, "FALLBACK_API_INVALID")
	}
	return model, nil
}

func (r *Resolver) compatible(ctx context.Context, model map[string]any) (map[string]any, error) {
	if len(miniReelMapsFromAny(model["video_list"])) > 0 && !miniReelOnlyByteVC2(model) {
		return model, nil
	}
	raw := miniReelFallbackAPI(model["fallback_api"])
	if raw == "" {
		return model, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	original, err := r.fallback(ctx, raw)
	if err != nil {
		var e *Error
		if miniReelOnlyByteVC2(model) && errors.As(err, &e) && e.Code != "FALLBACK_API_BUSINESS" {
			return model, nil
		}
		return nil, err
	}
	if !miniReelSameFallbackVideo(model, original) {
		if miniReelOnlyByteVC2(model) {
			return model, nil
		}
		return nil, failure("fallback_api", "FALLBACK_API_MISMATCH")
	}
	if !miniReelOnlyByteVC2(original) {
		return original, nil
	}
	for _, codec := range []string{"codec_type=1", "codec_type=0&force_codec=h264", "codec_type=3"} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		candidate, err := r.fallback(ctx, miniReelFallbackCodecURL(raw, codec))
		if err != nil {
			var e *Error
			if errors.As(err, &e) && e.Code == "FALLBACK_API_BUSINESS" {
				return nil, err
			}
			continue
		}
		if miniReelSameFallbackVideo(model, candidate) && miniReelSameFallbackVideo(original, candidate) && len(miniReelOptionsFromModel(candidate)) > 0 {
			return candidate, nil
		}
	}
	return original, nil
}
