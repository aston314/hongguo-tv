package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestPlaybackPreparationActualModelResponses(t *testing.T) {
	for _, tc := range []struct {
		name, body, code, business string
		status                     int
	}{
		{"empty", "", "VIDEO_MODEL_EMPTY", "", 200},
		{"whitespace", " \n ", "VIDEO_MODEL_EMPTY", "", 200},
		{"not OK empty", "", "VIDEO_MODEL_EMPTY", "", 204},
		{"upstream forbidden", "private response", "VIDEO_MODEL_HTTP", "", 403},
		{"upstream gateway", "private response", "VIDEO_MODEL_HTTP", "", 502},
		{"JSON", "<html>private response</html>", "VIDEO_MODEL_JSON", "", 200},
		{"business", `{"code":101000,"message":"private response"}`, "VIDEO_MODEL_BUSINESS", "101000", 200},
		{"untrusted business", `{"code":"private response"}`, "VIDEO_MODEL_BUSINESS", "", 200},
		{"missing model", `{}`, "VIDEO_MODEL_MISSING", "", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer remote.Close()
			_, err := miniReelNativeOptionsAttemptWithClient(context.Background(), "123", remote.URL+"?token=private", miniReelRecoveryDevice("private"), nil)
			if err == nil {
				t.Fatal("expected preparation failure")
			}
			d := playbackPreparationDetails(err)
			if d.Code != tc.code || d.Stage != "multi_video_model" || d.HTTPStatus == nil || *d.HTTPStatus != tc.status || d.BusinessCode != tc.business || d.Attempt != 1 || d.ElapsedMS == nil {
				t.Fatalf("diagnostic = %+v", d)
			}
			if tc.status == 200 && (d.ResponseBytes == nil || *d.ResponseBytes != len(tc.body)) {
				t.Fatalf("bytes = %+v", d)
			}
			if errors.Is(err, errMiniReelVideoModelEmpty) != (tc.status == 200 && strings.TrimSpace(tc.body) == "") {
				t.Fatalf("empty sentinel changed: %v", err)
			}
			if calls.Load() != 1 {
				t.Fatal("diagnostics added a request")
			}
			assertPlaybackPreparationPublic(t, err, d.Code, d.Stage, tc.status)
		})
	}
}

func TestPlaybackPreparationTransportHasNoInventedHTTPStatus(t *testing.T) {
	client := &http.Client{Transport: miniReelTestRoundTripper(func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded })}
	_, err := miniReelNativeOptionsAttemptWithClient(context.Background(), "123", "https://private.example/?token=private", miniReelRecoveryDevice("private"), client)
	d := playbackPreparationDetails(err)
	if d.Code != "VIDEO_MODEL_TRANSPORT_TIMEOUT" || d.HTTPStatus != nil || d.ResponseBytes != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("transport diagnostic = %+v, %v", d, err)
	}
	assertPlaybackPreparationPublic(t, err, d.Code, d.Stage, 0)
}

func TestPlaybackPreparationRegistrationUsesActualResponse(t *testing.T) {
	for _, tc := range []struct {
		status     int
		body, code string
	}{
		{403, "private response", "DEVICE_REGISTER_HTTP"},
		{200, "private response", "DEVICE_REGISTER_INVALID"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer remote.Close()
			cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return registerMiniReelPlaybackDeviceAt(remote.URL) })
			_, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", "https://must-not-resolve.invalid", "default", cache)
			d := playbackPreparationDetails(err)
			if d.Code != tc.code || d.Stage != "device_register" || d.HTTPStatus == nil || *d.HTTPStatus != tc.status {
				t.Fatalf("registration = %+v, %v", d, err)
			}
			assertPlaybackPreparationPublic(t, err, tc.code, "device_register", tc.status)
		})
	}
}

func TestPlaybackPreparationIdentityReplacementPreservesBoundedEmptyAndCounts(t *testing.T) {
	var registrations, calls atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice(fmt.Sprint(registrations.Add(1))), nil })
	remote := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer remote.Close()
	_, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", remote.URL, "default", cache)
	d := playbackPreparationDetails(err)
	if !errors.Is(err, errMiniReelVideoModelEmpty) || d.Attempt != 6 || calls.Load() != 6 || registrations.Load() != 2 {
		t.Fatalf("empty = %+v, %v; calls=%d regs=%d", d, err, calls.Load(), registrations.Load())
	}
	assertPlaybackPreparationPublic(t, err, "VIDEO_MODEL_EMPTY", "multi_video_model", 200)
}

func TestPlaybackPreparationRangeAndFullFailureRetainBothStages(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			w.WriteHeader(403)
		} else {
			w.WriteHeader(503)
		}
	}))
	defer remote.Close()
	_, rangeErr := openMiniReelRangeSource(context.Background(), miniReelOption{URL: remote.URL}, "123")
	fullErr := downloadMiniReelMedia(context.Background(), remote.URL, filepath.Join(t.TempDir(), "private.mp4"))
	combined := playbackPreparationFallback(rangeErr, fullErr)
	d := playbackPreparationDetails(combined)
	if d.Stage != "media_download" || d.HTTPStatus == nil || *d.HTTPStatus != 503 || d.RangeFailure == nil || d.RangeFailure.Code != "RANGE_INIT_HTTP" || *d.RangeFailure.HTTPStatus != 403 {
		t.Fatalf("combined = %+v", d)
	}
	if playbackPreparationDetails(fullErr).RangeFailure != nil {
		t.Fatal("fallback modified a shared job failure")
	}
	assertPlaybackPreparationPublic(t, combined, "MEDIA_DOWNLOAD_HTTP", "media_download", 503)
}

func TestPlaybackPreparationRangeInvalidLayoutDoesNotInventHTTPFailure(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(206)
		_, _ = io.WriteString(w, "private invalid MP4")
	}))
	defer remote.Close()
	_, err := openMiniReelRangeSource(context.Background(), miniReelOption{URL: remote.URL}, "123")
	d := playbackPreparationDetails(err)
	if d.Code != "RANGE_INIT_INVALID" || *d.HTTPStatus != 206 {
		t.Fatalf("range = %+v", d)
	}
	assertPlaybackPreparationPublic(t, err, "RANGE_INIT_INVALID", "range_init", 206)
}

func TestPlaybackPreparationDownloadStorageAndDecryptAreDistinct(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "01234567890123456789") }))
	defer remote.Close()
	dir := t.TempDir()
	err := downloadMiniReelMedia(context.Background(), remote.URL, filepath.Join(dir, "private-missing", "video.mp4"))
	d := playbackPreparationDetails(err)
	if d.Stage != "cache_write" || d.Code != "MEDIA_CACHE_WRITE_FAILED" {
		t.Fatalf("storage = %+v %v", d, err)
	}
	assertPlaybackPreparationPublic(t, err, d.Code, d.Stage, 0)
	path := filepath.Join(dir, "private.mp4")
	if err := os.WriteFile(path, []byte("invalid private MP4"), 0600); err != nil {
		t.Fatal(err)
	}
	decryptErr := decryptMiniReelMP4(path, []byte("0123456789012345"))
	if decryptErr == nil {
		t.Fatal("invalid encrypted file accepted")
	}
	err = wrapPlaybackPreparation(decryptErr, "media_decrypt", "MEDIA_DECRYPT_FAILED")
	assertPlaybackPreparationPublic(t, err, "MEDIA_DECRYPT_FAILED", "media_decrypt", 0)
}

func TestPlaybackPreparationPublicResponsesStayRequestOwned(t *testing.T) {
	base := wrapPlaybackPreparation(errors.New("private shared error"), "multi_video_model", "VIDEO_MODEL_EMPTY")
	var wg sync.WaitGroup
	for i := 1; i <= 8; i++ {
		wg.Add(1)
		go func(attempt int) {
			defer wg.Done()
			err := playbackPreparationAttempt(base, attempt, false)
			d := playbackPreparationDetails(err)
			if d.Attempt != attempt {
				t.Errorf("attempt=%d want%d", d.Attempt, attempt)
			}
			assertPlaybackPreparationPublic(t, err, d.Code, d.Stage, 0)
		}(i)
	}
	wg.Wait()
	if playbackPreparationDetails(base).Attempt != 0 {
		t.Fatal("shared error mutated")
	}
	assertPlaybackPreparationPublic(t, errors.New("private unknown error"), "PLAYBACK_PREPARE_FAILED", "playback_prepare", 0)
}

func assertPlaybackPreparationPublic(t *testing.T, err error, code, stage string, upstreamStatus int) {
	t.Helper()
	client := newHongguoClient()
	client.internalPlayback = func(context.Context, string, string, string, bool) (PlayInfo, error) {
		return PlayInfo{}, fmt.Errorf("private cookie URL path: %w", err)
	}
	s := &server{hongguo: client}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/v1/play/info?series_id=123&vid=456", nil)
	s.playInfo(w, r)
	var body struct {
		OK          bool                          `json:"ok"`
		Error       string                        `json:"error"`
		Stage       string                        `json:"stage"`
		Preparation playbackPreparationDiagnostic `json:"preparation"`
	}
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || w.Code != 502 || body.OK || body.Error != code || body.Stage != stage || body.Preparation.Code != code {
		t.Errorf("public error: %d %s", w.Code, w.Body.String())
	}
	if upstreamStatus == 0 && body.Preparation.HTTPStatus != nil || upstreamStatus != 0 && (body.Preparation.HTTPStatus == nil || *body.Preparation.HTTPStatus != upstreamStatus) {
		t.Errorf("upstream status lost/invented: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "token") || strings.Contains(w.Body.String(), "cookie") {
		t.Errorf("sensitive error leaked: %s", w.Body.String())
	}
}

func TestPlaybackPreparationFallbackModelKeepsItsOwnResponse(t *testing.T) {
	for _, tc := range []struct {
		status               int
		body, code, business string
	}{
		{503, "private response", "FALLBACK_API_HTTP", ""},
		{200, `{"code":101000}`, "FALLBACK_API_BUSINESS", "101000"},
		{200, "private response", "FALLBACK_API_INVALID", ""},
	} {
		t.Run(tc.code, func(t *testing.T) {
			client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header)}, nil
			})}
			_, err := miniReelFetchFallbackModelWithClient(context.Background(), "https://api.fqnovel.com/?token=private", client)
			d := playbackPreparationDetails(err)
			if d.Stage != "fallback_api" || d.Code != tc.code || d.BusinessCode != tc.business || d.HTTPStatus == nil || *d.HTTPStatus != tc.status {
				t.Fatalf("fallback = %+v %v", d, err)
			}
			assertPlaybackPreparationPublic(t, err, tc.code, "fallback_api", tc.status)
		})
	}
}

func TestPlaybackPreparationCancellationPreservesCause(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		t.Error("canceled resolver registered a device")
		return miniReelDevice{}, nil
	})
	_, err := miniReelNativeOptionsWithIdentityCache(ctx, "123", "https://must-not-resolve.invalid", "default", cache)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation = %v", err)
	}
	wrapped := wrapPlaybackPreparation(err, "device_register", "DEVICE_REGISTER_FAILED")
	if !errors.Is(wrapped, context.Canceled) {
		t.Fatal("diagnostics lost cancellation")
	}
}
