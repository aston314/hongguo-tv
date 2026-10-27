package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
)

func fakeMiniReelRegistrar(t *testing.T) func() int {
	var mu sync.Mutex
	var registrations int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		registrations++
		n := registrations
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"device_id_str":"`+strconv.Itoa(1000000000000000+n)+`","install_id_str":"`+strconv.Itoa(2000000000000000+n)+`"}`)
	}))
	t.Cleanup(server.Close)
	miniReelRegistration.Lock()
	previous := miniReelRegistration.base
	miniReelRegistration.base, miniReelRegistration.device = server.URL, miniReelDevice{}
	miniReelRegistration.Unlock()
	t.Cleanup(func() {
		miniReelRegistration.Lock()
		miniReelRegistration.base, miniReelRegistration.device = previous, miniReelDevice{}
		miniReelRegistration.Unlock()
	})
	return func() int {
		mu.Lock()
		defer mu.Unlock()
		return registrations
	}
}

func TestMiniReelNativeOptionsReusesRegisteredDevice(t *testing.T) {
	registrations := fakeMiniReelRegistrar(t)
	var devices []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		devices = append(devices, r.URL.Query().Get("device_id"))
		_, _ = io.WriteString(w, `{"data":{"video_model":{"video_list":[{"video_meta":{"codec_type":"h264","vheight":720,"definition":"720p"},"main_url":"https://media.example/video.mp4","encrypt_info":{}}],"video_duration":1}}}`)
	}))
	defer server.Close()

	for i := 0; i < 2; i++ {
		if _, err := miniReelNativeOptionsEndpoint(context.Background(), "123", server.URL); err != nil {
			t.Fatalf("miniReelNativeOptionsEndpoint() error = %v", err)
		}
	}
	if registrations() != 1 || len(devices) != 2 || devices[0] != devices[1] || devices[0] != "1000000000000001" {
		t.Fatalf("registrations = %d, devices = %v; want one registered device reused", registrations(), devices)
	}
}

func TestMiniReelNativeOptionsReregistersAfterEmptyResponses(t *testing.T) {
	registrations := fakeMiniReelRegistrar(t)
	var mu sync.Mutex
	var requests int
	ids := make([]string, 0, miniReelVideoModelAttempts)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, key := range []string{"X-Khronos", "X-SS-Req-Ticket", "X-Helios", "X-Medusa", "X-Gorgon", "X-SS-STUB"} {
			if r.Header.Get(key) == "" {
				t.Errorf("missing signed request header %s", key)
			}
		}
		if got, want := r.Header.Get("X-SS-Req-Ticket"), r.URL.Query().Get("_rticket"); got != want {
			t.Errorf("request ticket = %q, query ticket = %q", got, want)
		}

		mu.Lock()
		requests++
		requestNumber := requests
		ids = append(ids, r.URL.Query().Get("device_id"), r.URL.Query().Get("iid"))
		mu.Unlock()
		if requestNumber < 3 {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":{"video_model":{"video_list":[{"video_meta":{"codec_type":"h264","vheight":720,"definition":"720p"},"main_url":"https://media.example/video.mp4","encrypt_info":{}}],"video_duration":1}}}`)
	}))
	defer server.Close()

	options, err := miniReelNativeOptionsEndpoint(context.Background(), "123", server.URL)
	if err != nil {
		t.Fatalf("miniReelNativeOptionsEndpoint() error = %v", err)
	}
	if len(options) != 1 || options[0].Quality != "720P" {
		t.Fatalf("options = %#v, want one 720P option", options)
	}
	mu.Lock()
	defer mu.Unlock()
	if requests != 3 {
		t.Fatalf("requests = %d, want 3", requests)
	}
	if registrations() != 3 {
		t.Fatalf("registrations = %d, want 3", registrations())
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if len(id) != 16 {
			t.Fatalf("device identity %q has length %d, want 16", id, len(id))
		}
		if _, err := strconv.ParseUint(id, 10, 64); err != nil {
			t.Fatalf("device identity %q is not decimal: %v", id, err)
		}
		if seen[id] {
			t.Fatalf("device identity %q was reused", id)
		}
		seen[id] = true
	}
}

func TestMiniReelNativeOptionsDoesNotRetryNonEmptyInvalidResponse(t *testing.T) {
	fakeMiniReelRegistrar(t)
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()

	_, err := miniReelNativeOptionsEndpoint(context.Background(), "123", server.URL)
	if err == nil || requests != 1 {
		t.Fatalf("error = %v, requests = %d; want one request and a direct parse error", err, requests)
	}
	if errors.Is(err, errMiniReelVideoModelEmpty) {
		t.Fatalf("non-empty invalid JSON was classified as an empty response: %v", err)
	}
}

func TestMiniReelNativeOptionsStopsAfterEmptyResponseLimit(t *testing.T) {
	fakeMiniReelRegistrar(t)
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
	}))
	defer server.Close()

	_, err := miniReelNativeOptionsEndpoint(context.Background(), "123", server.URL)
	if err == nil || requests != miniReelVideoModelAttempts {
		t.Fatalf("error = %v, requests = %d; want %d empty-response attempts", err, requests, miniReelVideoModelAttempts)
	}
	if !errors.Is(err, errMiniReelVideoModelEmpty) {
		t.Fatalf("error = %v, want empty-response cause", err)
	}
}
