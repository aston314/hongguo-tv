package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const miniReelRecoveryModel = `{"code":0,"data":{"123":{"video_model":{"video_list":{"720":{"main_url":"https://media.example/video.mp4","video_meta":{"codec_type":"h264","vwidth":1280,"vheight":720}}}}}}}`

func miniReelRecoveryDevice(id string) miniReelDevice {
	return miniReelDevice{deviceID: id, installID: "install-" + id, cdid: "cdid-" + id}
}

func TestMiniReelIdentityRecoveryReplacesEmptyIdentityAndReusesSuccess(t *testing.T) {
	var registrations, oldRequests, newRequests atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		return miniReelRecoveryDevice(fmt.Sprint(registrations.Add(1))), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("device_id")
		if r.URL.Query().Get("iid") != "install-"+id || r.URL.Query().Get("cdid") != "cdid-"+id {
			t.Error("recovery mixed fields from different identities")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Tt-Token") != "" {
			t.Error("anonymous recovery sent account credentials")
		}
		if id == "1" {
			oldRequests.Add(1)
			return
		}
		newRequests.Add(1)
		_, _ = io.WriteString(w, miniReelRecoveryModel)
	}))
	defer server.Close()

	for i := 0; i < 2; i++ {
		options, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "software", cache)
		if err != nil || len(options) != 1 || options[0].Codec != "h264" {
			t.Fatalf("resolved options = %#v, %v", options, err)
		}
	}
	if registrations.Load() != 2 || oldRequests.Load() != 1 || newRequests.Load() != 2 {
		t.Fatalf("registrations/old/new = %d/%d/%d, want 2/1/2", registrations.Load(), oldRequests.Load(), newRequests.Load())
	}
}

func TestMiniReelIdentityRecoveryRefreshesAfterFirstEmpty(t *testing.T) {
	var registrations, requests atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		return miniReelRecoveryDevice(fmt.Sprint(registrations.Add(1))), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 3 {
			_, _ = io.WriteString(w, miniReelRecoveryModel)
		}
	}))
	defer server.Close()
	if _, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "default", cache); err != nil {
		t.Fatal(err)
	}
	if registrations.Load() != 2 || requests.Load() != 3 {
		t.Fatalf("registrations/requests = %d/%d, want 2/3", registrations.Load(), requests.Load())
	}
}

func TestMiniReelIdentityRecoveryStopsOnOtherErrorAfterEmpty(t *testing.T) {
	var registrations, requests atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		return miniReelRecoveryDevice(fmt.Sprint(registrations.Add(1))), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 3 {
			_, _ = io.WriteString(w, `{"code":101000}`)
		}
	}))
	defer server.Close()
	_, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "default", cache)
	if err == nil || errors.Is(err, errMiniReelVideoModelEmpty) || registrations.Load() != 2 || requests.Load() != 3 {
		t.Fatalf("mixed failures triggered recovery: err=%v registrations=%d requests=%d", err, registrations.Load(), requests.Load())
	}
}

func TestMiniReelIdentityRecoveryIsBoundedAndCooldownExpires(t *testing.T) {
	var registrations, requests atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		return miniReelRecoveryDevice(fmt.Sprint(registrations.Add(1))), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Query().Get("device_id") == "3" {
			_, _ = io.WriteString(w, miniReelRecoveryModel)
		}
	}))
	defer server.Close()
	resolve := func() error {
		_, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "default", cache)
		return err
	}
	if err := resolve(); !errors.Is(err, errMiniReelVideoModelEmpty) {
		t.Fatalf("persistent empty error = %v", err)
	}
	if registrations.Load() != 2 || requests.Load() != 4 {
		t.Fatalf("registrations/requests = %d/%d, want 2/4", registrations.Load(), requests.Load())
	}
	if err := resolve(); !errors.Is(err, errMiniReelVideoModelEmpty) {
		t.Fatalf("cooldown error = %v", err)
	}
	if registrations.Load() != 2 || requests.Load() != 7 {
		t.Fatalf("cooldown registrations/requests = %d/%d, want 2/7", registrations.Load(), requests.Load())
	}
	cache.mu.Lock()
	cache.refreshAfter = time.Now().Add(-time.Second)
	cache.mu.Unlock()
	if err := resolve(); err != nil {
		t.Fatalf("recovery after cooldown = %v", err)
	}
	if registrations.Load() != 3 || requests.Load() != 9 {
		t.Fatalf("after cooldown registrations/requests = %d/%d, want 3/9", registrations.Load(), requests.Load())
	}
}

func TestMiniReelIdentityRecoveryIgnoresOtherFailures(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		abort  bool
	}{
		{name: "server error", status: 502},
		{name: "unauthorized", status: 403},
		{name: "no content", status: 204},
		{name: "other successful status", status: 201},
		{name: "business error", status: 200, body: `{"code":101000}`},
		{name: "invalid JSON", status: 200, body: `{`},
		{name: "missing model", status: 200, body: `{}`},
		{name: "connection closed", abort: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var registrations, requests atomic.Int32
			cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
				registrations.Add(1)
				return miniReelRecoveryDevice("1"), nil
			})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if test.abort {
					panic(http.ErrAbortHandler)
				}
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			_, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "default", cache)
			if err == nil || errors.Is(err, errMiniReelVideoModelEmpty) {
				t.Fatalf("nonempty/transport/status failure misclassified: %v", err)
			}
			if registrations.Load() != 1 || requests.Load() != 1 {
				t.Fatalf("registrations/requests = %d/%d, want 1/1", registrations.Load(), requests.Load())
			}
		})
	}
}

func TestMiniReelIdentityRecoveryDoesNotRotateForCodecFiltering(t *testing.T) {
	var registrations atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		registrations.Add(1)
		return miniReelRecoveryDevice("1"), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.ReplaceAll(miniReelRecoveryModel, "h264", "bytevc1"))
	}))
	defer server.Close()
	options, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "software", cache)
	if err != nil || len(options) != 0 || registrations.Load() != 1 {
		t.Fatalf("codec filtering changed identity: options=%#v err=%v registrations=%d", options, err, registrations.Load())
	}
}

func TestMiniReelIdentityRecoveryConcurrentRequestsShareReplacement(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	const workers = 8
	var registrations, oldRequests, newRequests atomic.Int32
	allOldRequests := make(chan struct{})
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		n := registrations.Add(1)
		if n == 2 {
			select {
			case <-allOldRequests:
			case <-ctx.Done():
				return miniReelDevice{}, ctx.Err()
			}
		}
		return miniReelRecoveryDevice(fmt.Sprint(n)), nil
	})
	var firstRequests atomic.Int32
	allStarted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("device_id") != "1" {
			newRequests.Add(1)
			_, _ = io.WriteString(w, miniReelRecoveryModel)
			return
		}
		if firstRequests.Add(1) == workers {
			close(allStarted)
		}
		select {
		case <-allStarted:
		case <-ctx.Done():
			return
		}
		if oldRequests.Add(1) == workers {
			close(allOldRequests)
		}
	}))
	defer server.Close()
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			options, err := miniReelNativeOptionsWithIdentityCache(ctx, "123", server.URL, "default", cache)
			if err != nil || len(options) != 1 {
				t.Errorf("concurrent resolve = %#v, %v", options, err)
			}
		}()
	}
	wg.Wait()
	if registrations.Load() != 2 || oldRequests.Load() != workers || newRequests.Load() != workers {
		t.Fatalf("registrations/old/new = %d/%d/%d, want 2/%d/%d", registrations.Load(), oldRequests.Load(), newRequests.Load(), workers, workers)
	}
}

func TestMiniReelIdentityRecoveryLateOldFailureCannotReplaceNewIdentity(t *testing.T) {
	var registrations atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		return miniReelRecoveryDevice(fmt.Sprint(registrations.Add(1))), nil
	})
	ctx := context.Background()
	old, err := cache.get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := cache.refreshAfterEmpty(ctx, old)
	if err != nil {
		t.Fatal(err)
	}
	// Even after the throttle expires, an old request may only adopt the new
	// identity. It cannot initiate another replacement.
	cache.mu.Lock()
	cache.refreshAfter = time.Time{}
	cache.mu.Unlock()
	late, err := cache.refreshAfterEmpty(ctx, old)
	if err != nil || late != replacement || registrations.Load() != 2 {
		t.Fatalf("late refresh = %#v, %v, registrations=%d", late, err, registrations.Load())
	}
}

func TestMiniReelIdentityRecoveryRegistrationFailureKeepsOldIdentity(t *testing.T) {
	var registrations atomic.Int32
	registrationErr := errors.New("registration unavailable")
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		if registrations.Add(1) > 1 {
			return miniReelDevice{}, registrationErr
		}
		return miniReelRecoveryDevice("1"), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer server.Close()
	_, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "default", cache)
	if !errors.Is(err, errMiniReelVideoModelEmpty) || !strings.Contains(err.Error(), registrationErr.Error()) {
		t.Fatalf("refresh failure = %v", err)
	}
	device, err := cache.get(context.Background())
	if err != nil || device != miniReelRecoveryDevice("1") {
		t.Fatalf("failed refresh discarded old identity: %#v, %v", device, err)
	}
	if _, err := cache.refreshAfterEmpty(context.Background(), device); !errors.Is(err, errMiniReelIdentityRefreshCoolingDown) {
		t.Fatalf("failed refresh was not throttled: %v", err)
	}
	if registrations.Load() != 2 {
		t.Fatalf("registrations = %d, want 2", registrations.Load())
	}
}

func TestMiniReelIdentityRecoveryCancellationDoesNotCancelSharedRegistration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var registrations atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		registrations.Add(1)
		close(started)
		select {
		case <-release:
			return miniReelRecoveryDevice("1"), nil
		case <-ctx.Done():
			return miniReelDevice{}, ctx.Err()
		}
	})
	waitCtx, stopWaiting := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() {
		_, err := miniReelNativeOptionsWithIdentityCache(waitCtx, "123", "http://unused.invalid", "default", cache)
		result <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	stopWaiting()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled resolve = %v", err)
		}
	case <-ctx.Done():
		t.Fatal("canceled playback remained blocked on registration")
	}
	close(release)
	device, err := cache.get(ctx)
	if err != nil || device != miniReelRecoveryDevice("1") || registrations.Load() != 1 {
		t.Fatalf("shared registration lost: %#v, %v, registrations=%d", device, err, registrations.Load())
	}
}

func TestMiniReelIdentityRecoveryCanceledRefreshWaiterDoesNotDisruptOthers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var registrations atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		n := registrations.Add(1)
		if n == 2 {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return miniReelDevice{}, ctx.Err()
			}
		}
		return miniReelRecoveryDevice(fmt.Sprint(n)), nil
	})
	old, err := cache.get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	waitCtx, stopWaiting := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() {
		_, err := cache.refreshAfterEmpty(waitCtx, old)
		result <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	stopWaiting()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled refresh = %v", err)
		}
	case <-ctx.Done():
		t.Fatal("canceled refresh waiter did not return")
	}
	close(release)
	replacement, err := cache.refreshAfterEmpty(ctx, old)
	if err != nil || replacement != miniReelRecoveryDevice("2") || registrations.Load() != 2 {
		t.Fatalf("shared refresh lost: %#v, %v, registrations=%d", replacement, err, registrations.Load())
	}
}

func TestMiniReelIdentityRecoveryAlreadyCanceledDoesNotRegister(t *testing.T) {
	var registrations atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		registrations.Add(1)
		return miniReelRecoveryDevice("1"), nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := miniReelNativeOptionsWithIdentityCache(ctx, "123", "http://unused.invalid", "default", cache)
	if !errors.Is(err, context.Canceled) || registrations.Load() != 0 {
		t.Fatalf("already canceled resolve = %v, registrations=%d", err, registrations.Load())
	}
}

func TestMiniReelIdentityRecoveryNewRequestWaitsForReplacement(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var registrations atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		n := registrations.Add(1)
		if n == 2 {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return miniReelDevice{}, ctx.Err()
			}
		}
		return miniReelRecoveryDevice(fmt.Sprint(n)), nil
	})
	old, err := cache.get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	refreshResult := make(chan error, 1)
	go func() {
		_, err := cache.refreshAfterEmpty(ctx, old)
		refreshResult <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// A new request must wait on the refresh, even though the old identity is
	// retained for recovery if that registration eventually fails.
	waitCtx, stopWaiting := context.WithCancel(ctx)
	stopWaiting()
	if _, err := cache.get(waitCtx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled get during refresh = %v", err)
	}
	result := make(chan miniReelDevice, 1)
	go func() {
		device, err := cache.get(ctx)
		if err != nil {
			t.Errorf("get during refresh = %v", err)
		}
		result <- device
	}()
	// The replacement registration's release is controlled by the test. A short
	// deadline checks that the getter waits instead of returning the old identity.
	deadlineCtx, stopDeadline := context.WithDeadline(ctx, time.Now().Add(20*time.Millisecond))
	defer stopDeadline()
	if device, err := cache.get(deadlineCtx); !errors.Is(err, context.DeadlineExceeded) || device != (miniReelDevice{}) {
		t.Fatalf("new request reused identity during refresh: %#v, %v", device, err)
	}
	close(release)
	if err := <-refreshResult; err != nil {
		t.Fatal(err)
	}
	if device := <-result; device != miniReelRecoveryDevice("2") || registrations.Load() != 2 {
		t.Fatalf("new request did not use replacement: %#v, registrations=%d", device, registrations.Load())
	}
}

func TestMiniReelIdentityRecoveryFirstEmptyBackoffAndCompatibility(t *testing.T) {
	var registrations, oldRequests atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		n := registrations.Add(1)
		if n == 2 && oldRequests.Load() != 1 {
			t.Error("identity was not refreshed after the first empty response")
		}
		return miniReelRecoveryDevice(fmt.Sprint(n)), nil
	})
	var mu sync.Mutex
	var seen []time.Time
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, time.Now())
		n := len(seen)
		if n == 1 {
			oldRequests.Add(1)
		} else if r.URL.Query().Get("device_id") != "2" || !r.Close {
			t.Error("retry did not use the replacement identity and a fresh connection")
		}
		if n < 4 {
			assertMiniReelPlaybackSignature(t, r)
		} else {
			if r.Header.Get("X-Medusa") != "" || r.URL.Query().Get("ts") != "" {
				t.Error("unsigned compatibility request was lost")
			}
			_, _ = io.WriteString(w, miniReelRecoveryModel)
		}
	}))
	defer server.Close()
	options, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "default", cache)
	if err != nil || len(options) != 1 || registrations.Load() != 2 {
		t.Fatalf("recovery = %#v, %v; registrations=%d", options, err, registrations.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 4 {
		t.Fatalf("requests = %d, want 4", len(seen))
	}
	for i := 1; i < len(seen); i++ {
		if gap := seen[i].Sub(seen[i-1]); gap < miniReelRetryDelay(i-1)-20*time.Millisecond {
			t.Errorf("retry %d arrived too early: %v", i, gap)
		}
	}
}

func TestMiniReelIdentityRecoveryRefreshFailureContinuesCompatibility(t *testing.T) {
	var registrations, requests atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		if registrations.Add(1) > 1 {
			return miniReelDevice{}, errors.New("registration unavailable")
		}
		return miniReelRecoveryDevice("1"), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("device_id") != "1" {
			t.Error("failed registration discarded the old identity")
		}
		if requests.Add(1) > 1 {
			_, _ = io.WriteString(w, miniReelRecoveryModel)
		}
	}))
	defer server.Close()
	for i := 0; i < 2; i++ {
		if _, err := miniReelNativeOptionsWithIdentityCache(context.Background(), "123", server.URL, "default", cache); err != nil {
			t.Fatal(err)
		}
	}
	if registrations.Load() != 2 || requests.Load() != 3 {
		t.Fatalf("registrations/requests = %d/%d, want 2/3", registrations.Load(), requests.Load())
	}
}

func TestMiniReelIdentityRecoveryCancelDuringBackoffStopsRequests(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var registrations, requests atomic.Int32
	refreshed := make(chan struct{})
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		n := registrations.Add(1)
		if n == 2 {
			close(refreshed)
		}
		return miniReelRecoveryDevice(fmt.Sprint(n)), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer server.Close()
	result := make(chan error, 1)
	go func() {
		_, err := miniReelNativeOptionsWithIdentityCache(ctx, "123", server.URL, "default", cache)
		result <- err
	}()
	select {
	case <-refreshed:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) || requests.Load() != 1 {
			t.Fatalf("canceled backoff = %v, requests=%d", err, requests.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation remained blocked on retry delay")
	}
}

func TestMiniReelIdentityRecoveryRegistrationTimeCountsAsBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var registrations, requests atomic.Int32
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		n := registrations.Add(1)
		if n == 2 {
			time.Sleep(350 * time.Millisecond)
			// Another full 300ms sleep would cross this deadline.
			time.AfterFunc(250*time.Millisecond, cancel)
		}
		return miniReelRecoveryDevice(fmt.Sprint(n)), nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) > 1 {
			_, _ = io.WriteString(w, miniReelRecoveryModel)
		}
	}))
	defer server.Close()
	if _, err := miniReelNativeOptionsWithIdentityCache(ctx, "123", server.URL, "default", cache); err != nil {
		t.Fatalf("registration time was not counted toward backoff: %v", err)
	}
}
