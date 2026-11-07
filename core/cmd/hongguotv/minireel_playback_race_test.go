package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestMiniReelPlaybackRaceUsesSpareForMissingModel(t *testing.T) {
	var primaryRequests, spareRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("device_id") == "primary" {
			primaryRequests.Add(1)
			_, _ = io.WriteString(w, `{}`)
			return
		}
		spareRequests.Add(1)
		_, _ = io.WriteString(w, miniReelRecoveryModel)
	}))
	defer server.Close()

	var primaryRegistrations, spareRegistrations atomic.Int32
	primary := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		primaryRegistrations.Add(1)
		return miniReelRecoveryDevice("primary"), nil
	})
	spare := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		spareRegistrations.Add(1)
		return miniReelRecoveryDevice("spare"), nil
	})

	options, err := miniReelNativeOptionsWithIdentityRace(context.Background(), "123", server.URL, "default", primary, spare)
	if err != nil || len(options) != 1 || options[0].Codec != "h264" {
		t.Fatalf("race result = %#v, %v", options, err)
	}
	if primaryRegistrations.Load() != 1 || spareRegistrations.Load() != 1 {
		t.Fatalf("registrations = %d/%d, want one primary and one spare", primaryRegistrations.Load(), spareRegistrations.Load())
	}
	if primaryRequests.Load() != miniReelVideoModelAttempts || spareRequests.Load() != 1 {
		t.Fatalf("requests = %d/%d, want %d primary retries and one spare request for missing model", primaryRequests.Load(), spareRequests.Load(), miniReelVideoModelAttempts)
	}
}

func TestMiniReelRouteRaceUsesAnotherProductionLineAfterEmptyResponse(t *testing.T) {
	var routeCalls atomic.Int32
	emptyObserved := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/empty") {
			routeCalls.Add(1)
			_, _ = io.WriteString(w, ``)
			close(emptyObserved)
			return
		}
		routeCalls.Add(1)
		<-emptyObserved
		_, _ = io.WriteString(w, miniReelRecoveryModel)
	}))
	defer server.Close()
	identity := func(label string) *miniReelPlaybackDeviceCache {
		return newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
			return miniReelRecoveryDevice(label), nil
		})
	}
	routes := []miniReelPlaybackRouteTarget{
		{name: "empty", endpoint: server.URL + "/empty", identity: identity("empty")},
		{name: "working", endpoint: server.URL + "/working", identity: identity("working")},
	}
	options, err := miniReelNativeOptionsWithRouteTargets(context.Background(), "123", "default", routes)
	if err != nil || len(options) != 1 || options[0].Codec != "h264" {
		t.Fatalf("route race result = %#v, %v", options, err)
	}
	if routeCalls.Load() != 2 {
		t.Fatalf("route calls = %d, want both routes attempted after empty response", routeCalls.Load())
	}
}

func TestMiniReelPlaybackRaceDoesNotRotateForNoCompatibleSource(t *testing.T) {
	var primaryRegistrations, spareRegistrations atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"code":0,"data":{"123":{"video_model":{"video_list":{"bytevc2":{"main_url":"https://media.example/video.mp4","codec_type":"bytevc2"}}}}}}`)
	}))
	defer server.Close()
	primary := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		primaryRegistrations.Add(1)
		return miniReelRecoveryDevice("primary"), nil
	})
	spare := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		spareRegistrations.Add(1)
		return miniReelRecoveryDevice("spare"), nil
	})

	options, err := miniReelNativeOptionsWithIdentityRace(context.Background(), "123", server.URL, "software", primary, spare)
	if !errors.Is(err, errMiniReelNoCompatibleSource) || len(options) != 0 {
		t.Fatalf("software filtering result = %#v, %v", options, err)
	}
	if primaryRegistrations.Load() != 1 || spareRegistrations.Load() != 0 {
		t.Fatalf("identity rotation for codec filtering: registrations = %d/%d", primaryRegistrations.Load(), spareRegistrations.Load())
	}
}

func TestMiniReelPlaybackRaceReturnsPrimaryFailureWhenBothTargetsFail(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	primary := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("primary"), nil })
	spare := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("spare"), nil })

	_, err := miniReelNativeOptionsWithIdentityRace(context.Background(), "123", server.URL, "default", primary, spare)
	if err == nil || !errors.Is(err, errMiniReelVideoModelMissing) {
		t.Fatalf("both-target failure = %v, want missing-model error", err)
	}
	if requests.Load() != 2*miniReelVideoModelAttempts {
		t.Fatalf("requests = %d, want %d total attempts", requests.Load(), 2*miniReelVideoModelAttempts)
	}
}

func TestMiniReelPlaybackTargetRetryableClassification(t *testing.T) {
	for _, test := range []struct {
		name      string
		err       error
		retryable bool
	}{
		{name: "empty", err: errMiniReelVideoModelEmpty, retryable: true},
		{name: "missing", err: errMiniReelVideoModelMissing, retryable: true},
		{name: "no compatible source", err: errMiniReelNoCompatibleSource, retryable: false},
		{name: "business rejection", err: errors.New("business rejection"), retryable: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := miniReelPlaybackTargetRetryable(test.err); got != test.retryable {
				t.Fatalf("retryable = %t, want %t", got, test.retryable)
			}
		})
	}
}

func TestMiniReelCustomDeviceFallbackMapsPhoneIDsAndPreservesDefaultError(t *testing.T) {
	var customRequests atomic.Int32
	var badCustomQuery atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("device_id") == "987654" {
			customRequests.Add(1)
			if query.Get("iid") != "123456" || query.Get("cdid") != "" {
				badCustomQuery.Add(1)
			}
			_, _ = io.WriteString(w, miniReelRecoveryModel)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()

	oldPrimary, oldSpare := miniReelPlaybackIdentity, miniReelPlaybackSpareIdentity
	defer func() { miniReelPlaybackIdentity, miniReelPlaybackSpareIdentity = oldPrimary, oldSpare }()
	miniReelPlaybackIdentity = newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("primary"), nil })
	miniReelPlaybackSpareIdentity = newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("spare"), nil })

	oldCustom := getPlaybackCustomDevice()
	defer func() { _ = setPlaybackCustomDevice(oldCustom) }()
	if err := setPlaybackCustomDevice(playbackCustomDevice{DID: "987654", UID: "123456"}); err != nil {
		t.Fatal(err)
	}
	options, err := miniReelNativeOptionsEndpointModeForContentType(context.Background(), "123", server.URL, "default", miniReelDefaultContentType)
	if err != nil || len(options) != 1 || options[0].Codec != "h264" {
		t.Fatalf("custom fallback result = %#v, %v", options, err)
	}
	if customRequests.Load() == 0 {
		t.Fatal("custom device was not requested")
	}
	if badCustomQuery.Load() != 0 {
		t.Fatal("custom device IDs were not mapped to iid/cdid correctly")
	}
}

func TestMiniReelCustomDeviceFallbackDoesNotRunForCodecMismatch(t *testing.T) {
	var customRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("device_id") == "987654" {
			customRequests.Add(1)
		}
		_, _ = io.WriteString(w, `{"code":0,"data":{"123":{"video_model":{"video_list":{"bytevc2":{"main_url":"https://media.example/video.mp4","codec_type":"bytevc2"}}}}}}`)
	}))
	defer server.Close()
	oldPrimary, oldSpare := miniReelPlaybackIdentity, miniReelPlaybackSpareIdentity
	defer func() { miniReelPlaybackIdentity, miniReelPlaybackSpareIdentity = oldPrimary, oldSpare }()
	miniReelPlaybackIdentity = newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("primary"), nil })
	miniReelPlaybackSpareIdentity = newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("spare"), nil })
	oldCustom := getPlaybackCustomDevice()
	defer func() { _ = setPlaybackCustomDevice(oldCustom) }()
	if err := setPlaybackCustomDevice(playbackCustomDevice{DID: "987654"}); err != nil {
		t.Fatal(err)
	}
	options, err := miniReelNativeOptionsEndpointModeForContentType(context.Background(), "123", server.URL, "software", miniReelDefaultContentType)
	if err != nil || len(options) != 0 {
		t.Fatalf("codec mismatch result = %#v, %v", options, err)
	}
	if customRequests.Load() != 0 {
		t.Fatalf("codec mismatch used custom device %d times", customRequests.Load())
	}
}

func TestPlaybackCustomDevicePersistenceAndClear(t *testing.T) {
	path := filepath.Join(t.TempDir(), "playback-custom-device.json")
	oldPath := playbackCustomDeviceState.path
	oldValue := getPlaybackCustomDevice()
	defer func() {
		playbackCustomDeviceState.Lock()
		playbackCustomDeviceState.path = oldPath
		playbackCustomDeviceState.value = oldValue
		playbackCustomDeviceState.Unlock()
	}()
	playbackCustomDeviceState.Lock()
	playbackCustomDeviceState.path = path
	playbackCustomDeviceState.value = playbackCustomDevice{}
	playbackCustomDeviceState.Unlock()
	if err := setPlaybackCustomDevice(playbackCustomDevice{DID: "123", UID: "456"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), `"did":"123"`) || !strings.Contains(string(data), `"uid":"456"`) {
		t.Fatalf("persisted custom device = %s, %v", data, err)
	}
	if err := setPlaybackCustomDevice(playbackCustomDevice{}); err != nil {
		t.Fatal(err)
	}
	if got := getPlaybackCustomDevice(); got != (playbackCustomDevice{}) {
		t.Fatalf("cleared custom device = %#v", got)
	}
}

func TestPlaybackCustomDeviceAPI(t *testing.T) {
	oldValue := getPlaybackCustomDevice()
	defer func() { _ = setPlaybackCustomDevice(oldValue) }()
	if err := setPlaybackCustomDevice(playbackCustomDevice{}); err != nil {
		t.Fatal(err)
	}
	s := &server{}
	post := httptest.NewRecorder()
	s.playbackCustomDevice(post, httptest.NewRequest(http.MethodPost, "/api/v1/playback/custom-device", bytes.NewBufferString(`{"did":"321","uid":"654"}`)))
	if post.Code != http.StatusOK || !strings.Contains(post.Body.String(), `"did":"321"`) {
		t.Fatalf("custom device POST = %d %s", post.Code, post.Body.String())
	}
	get := httptest.NewRecorder()
	s.playbackCustomDevice(get, httptest.NewRequest(http.MethodGet, "/api/v1/playback/custom-device", nil))
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"uid":"654"`) {
		t.Fatalf("custom device GET = %d %s", get.Code, get.Body.String())
	}
	bad := httptest.NewRecorder()
	s.playbackCustomDevice(bad, httptest.NewRequest(http.MethodPost, "/api/v1/playback/custom-device", bytes.NewBufferString(`{"did":"not-a-number"}`)))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid custom device status = %d", bad.Code)
	}
}
