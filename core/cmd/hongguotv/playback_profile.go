package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/jsupdate"
	"github.com/aston314/hongguo-tv/core/internal/playbackprofile"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

// One immutable profile per runtime. Updates cannot mix fields into an in-flight request.
type nativeProfileRuntime struct {
	profile  *playbackprofile.Profile
	identity *miniReelPlaybackDeviceCache
	process  playbackprofile.Process
	client   *http.Client
	cancel   context.CancelFunc
}

func loadNativeProfile(ctx context.Context, b []byte, _ string) (jsupdate.Runtime, error) {
	p, e := playbackprofile.ParseContext(ctx, b)
	if e != nil {
		return nil, e
	}
	process, e := playbackprofile.NewProcess()
	if e != nil {
		return nil, e
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	life, cancel := context.WithCancel(context.Background())
	return &nativeProfileRuntime{profile: p, identity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return registerMiniReelPlaybackDeviceContext(life) }), process: process, cancel: cancel}, nil
}
func (r *nativeProfileRuntime) Close(context.Context) error {
	if r.cancel != nil {
		r.cancel()
	}
	return nil
}
func (r *nativeProfileRuntime) request(ctx context.Context, in resolverwire.Request, d miniReelDevice, tab bool, host string) ([]resolverwire.Option, error) {
	stage := "multi_video_model"
	gate := r.profile.V5.Gates.Model
	if tab {
		stage = "video_tab"
		gate = r.profile.V5.Gates.Tab
	}
	fail := func(code string) error { return &jsresolver.Error{Code: code, Stage: stage} }
	identity := map[string]string{"device_id": d.deviceID, "iid": d.installID, "cdid": d.cdid, "klink_egdi": ""}
	pairs := r.profile.Query(identity, in.VID, tab)
	var body []byte
	if !tab {
		raw, e := r.profile.Body(in.VID, in.ContentType)
		if e != nil {
			return nil, e
		}
		var buf bytes.Buffer
		z := gzip.NewWriter(&buf)
		if _, e = z.Write(raw); e != nil {
			return nil, e
		}
		if e = z.Close(); e != nil {
			return nil, e
		}
		body = buf.Bytes()
	}
	n, e := playbackprofile.Random()
	if e != nil {
		return nil, e
	}
	stamp := time.Now().UnixMilli()
	process := r.process
	process.Now = stamp
	process.Launch = 100 + n[0]%21
	process.PID = 10001 + n[1]%2000
	signed, e := r.profile.Sign(ctx, pairs, body, stamp, n, process)
	if e != nil {
		return nil, e
	}
	if host == "" {
		host = gate.Host
	}
	method := http.MethodPost
	if tab {
		method = http.MethodGet
	}
	req, e := http.NewRequestWithContext(ctx, method, "https://"+host+gate.Path+"?"+signed.Query, bytes.NewReader(body))
	if e != nil {
		return nil, e
	}
	for k, v := range signed.Headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("User-Agent", gate.UserAgent)
	req.Header.Set("Accept", "application/json")
	if !tab {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
		req.Header.Set("Content-Encoding", "gzip")
		hash := md5.Sum(body)
		req.Header.Set("X-SS-STUB", strings.ToUpper(hex.EncodeToString(hash[:])))
	}
	response, e := miniReelNoRedirectClient(r.client, 8*time.Second).Do(req)
	if e != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fail("VIDEO_MODEL_TRANSPORT")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, fail("VIDEO_MODEL_HTTP")
	}
	b, e := miniReelReadLimited(response.Body, miniReelMobileV5MaxJSON)
	if e != nil {
		return nil, fail("VIDEO_MODEL_READ")
	}
	if len(bytes.TrimSpace(b)) == 0 {
		code := "VIDEO_MODEL_EMPTY"
		if response.Header.Get("Retry-After") != "" {
			code = "VIDEO_MODEL_THROTTLED"
		}
		return nil, fail(code)
	}
	var root map[string]any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if dec.Decode(&root) != nil || !json.Valid(b) {
		return nil, fail("VIDEO_MODEL_JSON")
	}
	if code := miniReelBusinessCodeFromEnvelope(root); code != "" && code != "0" {
		return nil, fail("VIDEO_MODEL_BUSINESS")
	}
	var envelope map[string]any
	if tab {
		var ok bool
		envelope, ok = miniReelVideoTabEnvelopeExact(in.VID, root)
		if !ok {
			return nil, fail("VIDEO_MODEL_MISSING")
		}
	} else {
		data, _ := root["data"].(map[string]any)
		if nested, ok := data[in.ContentType].(map[string]any); ok {
			data = nested
		}
		entry, _ := data[in.VID].(map[string]any)
		if entry == nil || entry["video_model"] == nil {
			return nil, fail("VIDEO_MODEL_MISSING")
		}
		envelope = map[string]any{"data": map[string]any{in.VID: entry}}
	}
	diagnostic := playbackPreparationDiagnostic{Stage: stage}
	out, e := miniReelOptionsFromEnvelope(ctx, in.VID, envelope, r.client, in.CodecMode, &diagnostic)
	if e != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fail("VIDEO_MODEL_LIST_EMPTY")
	}
	result := []resolverwire.Option{}
	for _, o := range out {
		if miniReelIsByteVC2(o.Codec) {
			continue
		}
		result = append(result, resolverwire.Option(o))
	}
	if len(result) == 0 {
		return nil, fail("VIDEO_MODEL_LIST_EMPTY")
	}
	return result, nil
}
func (r *nativeProfileRuntime) Resolve(ctx context.Context, in resolverwire.Request) ([]resolverwire.Option, error) {
	if !miniReelIDRE.MatchString(in.VID) {
		return nil, jsresolver.ErrRequest
	}
	mode, e := normalizeMiniReelCodecMode(in.CodecMode)
	if e != nil {
		return nil, jsresolver.ErrRequest
	}
	in.CodecMode = mode
	in.ContentType, e = normalizeMiniReelContentType(in.ContentType)
	if e != nil {
		return nil, jsresolver.ErrRequest
	}
	d, e := r.identity.get(ctx)
	if e != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &jsresolver.Error{Code: "DEVICE_REGISTER_FAILED", Stage: "device_register"}
	}
	// Keep video_tab first. The JSON chooses existing hosts, not executable control flow.
	for _, h := range r.profile.V5.Gates.Tab.Hosts {
		out, e := r.request(ctx, in, d, true, h)
		if e == nil {
			return out, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var up *jsresolver.Error
		if errors.As(e, &up) && (up.Code == "VIDEO_MODEL_BUSINESS" || up.Code == "VIDEO_MODEL_THROTTLED") {
			return nil, e
		}
	}
	out, e := r.request(ctx, in, d, false, "")
	if e == nil {
		return out, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, e
}

// Automatic native profile updates are independent of the optional JS preference.
type nativeProfileService struct {
	mu                       sync.Mutex
	checking                 bool
	manager                  repairRuntime
	lastChecked, lastUpdated int64
	change                   uint64
	event                    string
	life                     context.Context
	cancel                   context.CancelFunc
}

// Reporting stays separate from the JS service's preference and check state.
type nativeProfileStatus struct {
	jsupdate.Status
	Checking    bool   `json:"checking"`
	LastChecked int64  `json:"last_checked,omitempty"`
	LastUpdated int64  `json:"last_updated,omitempty"`
	Change      uint64 `json:"change"`
}

func (s *nativeProfileService) status() nativeProfileStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	status := s.manager.Status()
	if status.Event != "rolled_back" && s.event != "" {
		status.Event = s.event
	}
	if s.checking {
		status.Event = "checking"
	}
	return nativeProfileStatus{Status: status, Checking: s.checking, LastChecked: s.lastChecked, LastUpdated: s.lastUpdated, Change: s.change}
}

var defaultNativeProfile atomic.Pointer[nativeProfileService]

func newNativeProfileService(dir string) (*nativeProfileService, error) {
	life, cancel := context.WithCancel(context.Background())
	cfg := jsupdate.Config{Dir: filepath.Join(dir, "playback-profile"), ManifestURL: jsupdate.ProfileManifestURL, PublicKey: jsupdate.PublicKey(), Embedded: playbackprofile.Builtin(), EmbeddedVersion: playbackprofile.Version, AllowedURL: jsupdate.ProfileURL, Product: jsupdate.ProfileProduct, Extension: ".json", MaxArtifact: playbackprofile.MaxBytes, Loader: loadNativeProfile}
	manager, e := jsupdate.New(life, cfg)
	if e != nil {
		cancel()
		return nil, e
	}
	return &nativeProfileService{manager: manager, life: life, cancel: cancel}, nil
}
func (s *nativeProfileService) check() {
	s.mu.Lock()
	if s.checking || s.life.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.checking = true
	s.change++
	s.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(s.life, 60*time.Second)
		defer cancel()
		before := s.manager.Status()
		err := s.manager.Check(ctx)
		after := s.manager.Status()
		s.mu.Lock()
		defer s.mu.Unlock()
		s.checking = false
		s.lastChecked = time.Now().UnixMilli()
		s.change++
		switch {
		case err != nil:
			s.event = "check_failed"
		case after.Revision > 0 && !after.Enabled:
			s.event = "remote_disabled"
		case after.Source == "downloaded" && (before.Source != after.Source || before.SHA256 != after.SHA256):
			s.event = "updated"
			s.lastUpdated = s.lastChecked
		default:
			s.event = "up_to_date"
		}
	}()
}
func (s *nativeProfileService) resolve(ctx context.Context, vid, mode, contentType string) ([]miniReelOption, error) {
	out, e := s.manager.Resolve(ctx, resolverwire.Request{VID: vid, CodecMode: mode, ContentType: contentType})
	if e != nil {
		return nil, e
	}
	options := make([]miniReelOption, 0, len(out))
	for _, o := range out {
		options = append(options, miniReelOption(o))
	}
	return options, nil
}
func (s *nativeProfileService) close(ctx context.Context) error {
	s.cancel()
	return s.manager.Close(ctx)
}
