package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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
	if primaryRequests.Load() != 1 || spareRequests.Load() != 1 {
		t.Fatalf("requests = %d/%d, want one request per target for missing model", primaryRequests.Load(), spareRequests.Load())
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
		_, _ = io.WriteString(w, `{"code":0,"data":{"123":{"video_model":{"video_list":{"bytevc1":{"main_url":"https://media.example/video.mp4","codec_type":"bytevc1"}}}}}}`)
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
	if requests.Load() != 2 {
		t.Fatalf("requests = %d, want one per target", requests.Load())
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
