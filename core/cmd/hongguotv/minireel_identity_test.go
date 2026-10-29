package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type miniReelTestRoundTripper func(*http.Request) (*http.Response, error)

func (f miniReelTestRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestMiniReelPlaybackDeviceCacheRegistersOnce(t *testing.T) {
	var registrations atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		registrations.Add(1)
		return miniReelDevice{deviceID: "1234567890123456789", installID: "2234567890123456789", cdid: "test-cdid"}, nil
	})
	const workers = 12
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			device, err := cache.get()
			if err == nil && (device.deviceID != "1234567890123456789" || device.installID != "2234567890123456789" || device.cdid != "test-cdid") {
				t.Errorf("device = %#v", device)
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := registrations.Load(); got != 1 {
		t.Fatalf("registrations = %d, want 1", got)
	}
}

func TestMiniReelPlaybackDeviceCacheRetriesRegistrationFailure(t *testing.T) {
	var registrations atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		if registrations.Add(1) == 1 {
			return miniReelDevice{}, errors.New("temporary registration failure")
		}
		return miniReelDevice{deviceID: "1234567890123456789", installID: "2234567890123456789"}, nil
	})
	if _, err := cache.get(); err == nil {
		t.Fatal("first registration unexpectedly succeeded")
	}
	device, err := cache.get()
	if err != nil || device.deviceID == "" {
		t.Fatalf("registration retry = %#v, %v", device, err)
	}
	if _, err := cache.get(); err != nil {
		t.Fatal(err)
	}
	if got := registrations.Load(); got != 2 {
		t.Fatalf("registration attempts = %d, want failed attempt plus one successful registration", got)
	}
}

func TestMiniReelPlaybackDeviceRegistrationIsAnonymousAndInMemory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/service/2/device_register/" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Tt-Token") != "" {
			t.Fatal("anonymous registration sent account credentials")
		}
		if r.URL.Query().Get("device_id") != "" || r.URL.Query().Get("iid") != "" {
			t.Fatal("registration query included unregistered identity")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		plain, err := passportTTDecrypt(body)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(plain, &payload); err != nil {
			t.Fatal(err)
		}
		header, ok := payload["header"].(map[string]any)
		if !ok {
			t.Fatal("registration payload header is missing")
		}
		for _, field := range []string{"phone", "mobile", "phone_number", "mobile_number", "token", "sessionid"} {
			if _, exists := payload[field]; exists {
				t.Errorf("anonymous registration payload contains account field %q", field)
			}
			if _, exists := header[field]; exists {
				t.Errorf("anonymous registration header contains account field %q", field)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"device_id_str":"1234567890123456789","install_id_str":"2234567890123456789"}`)
	}))
	defer server.Close()

	device, err := registerMiniReelPlaybackDeviceAt(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if device.deviceID != "1234567890123456789" || device.installID != "2234567890123456789" || len(device.cdid) != 36 {
		t.Fatalf("registered device = %#v", device)
	}
}

func TestMiniReelMultiVideoModelUsesRegisteredIdentityAndDirectModel(t *testing.T) {
	device := miniReelDevice{deviceID: "1234567890123456789", installID: "2234567890123456789", cdid: "00000000-0000-4000-8000-000000000001"}
	var mu sync.Mutex
	requests := 0
	identities := make([]string, 0, miniReelVideoModelAttempts)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/novel/player/multi_video_model/v1/" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != http.MethodPost || r.Header.Get("User-Agent") != miniReelPlaybackUA {
			t.Errorf("unexpected playback request method/UA: %s %q", r.Method, r.Header.Get("User-Agent"))
		}
		for _, header := range []string{"X-Medusa", "X-Gorgon", "X-Helios", "X-Khronos"} {
			if r.Header.Get(header) != "" {
				t.Errorf("playback request unexpectedly signed with %s", header)
			}
		}
		if got := r.URL.Query().Get("device_id"); got != device.deviceID {
			t.Errorf("device_id = %q", got)
		}
		if got := r.URL.Query().Get("iid"); got != device.installID {
			t.Errorf("iid = %q", got)
		}
		if got := r.URL.Query().Get("cdid"); got != device.cdid {
			t.Errorf("cdid = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		videoIDs := nestedMiniReelValue(body, "mixed_video_id_map", "1004").([]any)
		if len(videoIDs) != 1 || videoIDs[0] != "123" {
			t.Errorf("mixed_video_id_map = %#v", videoIDs)
		}
		mu.Lock()
		requests++
		requestNumber := requests
		identities = append(identities, r.URL.Query().Get("device_id"), r.URL.Query().Get("iid"))
		mu.Unlock()
		if requestNumber < 3 {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"code":0,"data":{"123":{"video_model":{"video_list":{"720":{"main_url":"https://media.example/video.mp4","video_meta":{"codec_type":"h264","vwidth":1280,"vheight":720,"definition":"720p"},"encrypt_info":{}}},"video_duration":61}}}}`)
	}))
	defer server.Close()

	options, err := miniReelNativeOptionsEndpointWithDevice(context.Background(), "123", server.URL+miniReelAPIPath, device)
	if err != nil {
		t.Fatalf("miniReelNativeOptionsEndpointWithDevice() error = %v", err)
	}
	if len(options) != 1 || options[0].Quality != "720P" || options[0].Duration != 61 || options[0].URL != "https://media.example/video.mp4" || options[0].Width != 1280 || options[0].Height != 720 {
		t.Fatalf("options = %#v", options)
	}
	mu.Lock()
	defer mu.Unlock()
	if requests != 3 {
		t.Fatalf("requests = %d, want 3 empty-response retries with the same registered identity", requests)
	}
	for _, id := range identities {
		if id != device.deviceID && id != device.installID {
			t.Fatalf("retry used unexpected identity %q", id)
		}
	}
}

func TestMiniReelMultiVideoModelSupportsLegacyEnvelopeAndRejectsInvalidResponse(t *testing.T) {
	device := miniReelDevice{deviceID: "1234567890123456789", installID: "2234567890123456789"}
	for _, fixture := range []string{
		`{"code":0,"data":{"video_model":{"video_list":[{"main_url":"https://media.example/video.mp4","video_meta":{"vheight":720,"definition":"720p"}}]}}}`,
		`{}`,
	} {
		requests := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests++
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, fixture)
		}))
		_, err := miniReelNativeOptionsEndpointWithDevice(context.Background(), "123", server.URL+miniReelAPIPath, device)
		server.Close()
		if fixture == `{}` {
			if err == nil || requests != 1 {
				t.Fatalf("invalid response error = %v, requests = %d", err, requests)
			}
		} else if err != nil || requests != 1 {
			t.Fatalf("legacy envelope error = %v, requests = %d", err, requests)
		}
	}
}

func TestMiniReelMultiVideoModelLoadsSafeFallbackAPI(t *testing.T) {
	device := miniReelDevice{deviceID: "1234567890123456789", installID: "2234567890123456789", cdid: "00000000-0000-4000-8000-000000000001"}
	fallbackURL := "https://api5-normal-sinfonlineb.fqnovel.com/playback/fallback"
	playbackServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != miniReelAPIPath {
			t.Errorf("unexpected playback request: %s %s", r.Method, r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"code":0,"data":{"123":{"video_model":{"fallback_api":"`+fallbackURL+`"}}}}`)
	}))
	defer playbackServer.Close()
	var fallbackCalls atomic.Int32
	client := &http.Client{Transport: miniReelTestRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host == strings.TrimPrefix(strings.TrimPrefix(playbackServer.URL, "http://"), "https://") {
			return http.DefaultTransport.RoundTrip(request)
		}
		fallbackCalls.Add(1)
		if request.Method != http.MethodGet || request.URL.Host != "api5-normal-sinfonlineb.fqnovel.com" || request.URL.Path != "/playback/fallback" {
			t.Errorf("unexpected fallback request: %s %s", request.Method, request.URL)
		}
		if request.Header.Get("User-Agent") != miniReelFallbackUA || request.Header.Get("Cookie") != "" {
			t.Errorf("fallback request headers leaked or mismatched: %#v", request.Header)
		}
		body := `{"code":0,"video_info":{"code":0,"data":{"video_list":{"720":{"backup_url_list":["https://media.example/video.mp4"],"codec_type":"h264","vheight":720,"quality_desc":"720p"}},"video_duration":61}}}`
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})}
	options, err := miniReelNativeOptionsAttemptWithClient(context.Background(), "123", playbackServer.URL+miniReelAPIPath, device, client)
	if err != nil {
		t.Fatalf("fallback playback resolution failed: %v", err)
	}
	if fallbackCalls.Load() != 1 {
		t.Fatalf("fallback calls = %d, want 1", fallbackCalls.Load())
	}
	if len(options) != 1 || options[0].URL != "https://media.example/video.mp4" || options[0].Duration != 61 {
		t.Fatalf("fallback options = %#v", options)
	}
	if got := miniReelFallbackAPI(`{"fallback_api":"https://api.fqnovel.com/fallback"}`); got != "https://api.fqnovel.com/fallback" {
		t.Fatalf("fallback_api JSON wrapper = %q", got)
	}
}

func TestMiniReelFallbackAPIRejectsUntrustedURLAndRedirect(t *testing.T) {
	for _, raw := range []string{
		"http://api.fqnovel.com/fallback",
		"https://fqnovel.com.attacker.test/fallback",
		"https://user@fqnovel.com/fallback",
		"https://api.fqnovel.com:444/fallback",
	} {
		if _, err := miniReelValidateFallbackURL(raw); err == nil {
			t.Errorf("accepted unsafe fallback URL %q", raw)
		}
	}
	var calls atomic.Int32
	client := &http.Client{Transport: miniReelTestRoundTripper(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		response := &http.Response{StatusCode: http.StatusFound, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: request}
		response.Header.Set("Location", "https://attacker.test/collect")
		return response, nil
	})}
	_, err := miniReelFetchFallbackModelWithClient(context.Background(), "https://api.fqnovel.com/fallback", client)
	if err == nil {
		t.Fatal("untrusted redirect unexpectedly succeeded")
	}
	if calls.Load() != 1 {
		t.Fatalf("redirect transport calls = %d, want only the trusted first request", calls.Load())
	}
}

func TestMiniReelLiveRegisteredPlaybackSource(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_MINIREEL") != "1" {
		t.Skip("set HONGGUO_LIVE_MINIREEL=1 to verify the public upstream playback endpoint")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	options, err := miniReelNativeOptions(ctx, "7690963562042248217")
	if err != nil {
		t.Fatalf("live registered-device playback source request failed: %v", err)
	}
	if len(options) == 0 {
		t.Fatal("live playback response contained no playable quality")
	}
	for _, option := range options {
		if !strings.HasPrefix(option.URL, "https://") {
			t.Fatalf("live playback returned a non-HTTPS source")
		}
	}
	if len(options[0].Key) != 16 {
		t.Fatal("live playback source did not contain a valid CENC key")
	}
	source, err := openMiniReelRangeSource(ctx, options[0], "7690963562042248217")
	if err != nil {
		t.Fatalf("live playback Range initialization failed: %v", err)
	}
	if source.Length <= 0 || len(source.Prefix) == 0 || len(source.Samples) == 0 {
		t.Fatalf("live playback Range index was incomplete: length=%d prefix=%d samples=%d", source.Length, len(source.Prefix), len(source.Samples))
	}
	first := source.Samples[0]
	frame, err := source.readAndTransform(ctx, int64(first.Offset), int64(first.Offset+first.Size-1))
	if err != nil {
		t.Fatalf("live first CENC sample could not be fetched and decrypted: %v", err)
	}
	if len(frame) != first.Size {
		t.Fatalf("live first sample bytes = %d, want %d", len(frame), first.Size)
	}
	t.Logf("live playback verified: quality=%q range_bytes=%d init_bytes=%d indexed_samples=%d first_sample_bytes=%d", options[0].Quality, source.Length, len(source.Prefix), len(source.Samples), len(frame))
}
