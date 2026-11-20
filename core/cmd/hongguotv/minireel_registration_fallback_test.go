package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestMiniReelPlaybackRegistrationFallsBackOnHTTP444(t *testing.T) {
	var primary, fallback atomic.Int32
	primaryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primary.Add(1)
		w.WriteHeader(444)
	}))
	defer primaryServer.Close()
	fallbackServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallback.Add(1)
		ioJSON(w, `{"device_id_str":"7390000000000000001","install_id_str":"7390000000000000002"}`)
	}))
	defer fallbackServer.Close()

	oldBases := miniReelPlaybackDeviceBases
	miniReelPlaybackDeviceBases = []string{primaryServer.URL, fallbackServer.URL}
	defer func() { miniReelPlaybackDeviceBases = oldBases }()

	device, err := registerMiniReelPlaybackDeviceContext(context.Background())
	if err != nil {
		t.Fatalf("registration fallback failed: %v", err)
	}
	if device.deviceID != "7390000000000000001" || device.installID != "7390000000000000002" {
		t.Fatalf("unexpected fallback identity: %+v", device)
	}
	if primary.Load() != 1 || fallback.Load() != 1 {
		t.Fatalf("registration attempts primary=%d fallback=%d", primary.Load(), fallback.Load())
	}
}

func TestMiniReelPlaybackRegistrationDoesNotFallbackOnBusinessRejection(t *testing.T) {
	var primary, fallback atomic.Int32
	primaryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primary.Add(1)
		ioJSON(w, `{"device_id_str":"0","install_id_str":"0"}`)
	}))
	defer primaryServer.Close()
	fallbackServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallback.Add(1)
		ioJSON(w, `{"device_id_str":"7390000000000000001","install_id_str":"7390000000000000002"}`)
	}))
	defer fallbackServer.Close()

	oldBases := miniReelPlaybackDeviceBases
	miniReelPlaybackDeviceBases = []string{primaryServer.URL, fallbackServer.URL}
	defer func() { miniReelPlaybackDeviceBases = oldBases }()

	if _, err := registerMiniReelPlaybackDeviceContext(context.Background()); err == nil {
		t.Fatal("invalid registration accepted")
	}
	if primary.Load() != 1 || fallback.Load() != 0 {
		t.Fatalf("unexpected attempts primary=%d fallback=%d", primary.Load(), fallback.Load())
	}
}
