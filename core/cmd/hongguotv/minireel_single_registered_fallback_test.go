package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestSingleRegisteredPlaybackRegistrationFallsBackOnHTTP444(t *testing.T) {
	var primary, fallback atomic.Int32
	primaryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primary.Add(1)
		w.WriteHeader(444)
	}))
	defer primaryServer.Close()
	fallbackServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallback.Add(1)
		ioJSON(w, `{"device_id":7000000000000000001,"install_id_str":"7000000000000000002"}`)
	}))
	defer fallbackServer.Close()

	oldBases := singleRegisteredDeviceBases
	singleRegisteredDeviceBases = []string{primaryServer.URL, fallbackServer.URL}
	defer func() { singleRegisteredDeviceBases = oldBases }()

	device, err := registerSingleRegisteredDeviceWithFallback(context.Background(), fallbackServer.Client())
	if err != nil {
		t.Fatalf("single registered fallback failed: %v", err)
	}
	if device.deviceID != "7000000000000000001" || device.installID != "7000000000000000002" {
		t.Fatalf("unexpected fallback identity: %+v", device)
	}
	if primary.Load() != 1 || fallback.Load() != 1 {
		t.Fatalf("registration attempts primary=%d fallback=%d", primary.Load(), fallback.Load())
	}
}
