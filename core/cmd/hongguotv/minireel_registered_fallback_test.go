package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMiniReelFreshFallbackVideoTabSuccessReturnsWithoutLegacyRegistration(t *testing.T) {
	var legacyRegistrations atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("unexpected legacy request: %s", r.Method)
		}
		io.WriteString(w, strings.Replace(miniReelRecoveryModel, `"data":`, `"data":{"video_model_data":`, 1)+"}")
	}))
	defer server.Close()
	identity := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("primary"), nil })
	sources := miniReelPlaybackSources{tabEndpoint: server.URL, tabIdentity: identity,
		legacyEndpoints: []string{server.URL}, register: func(context.Context) (miniReelDevice, error) {
			legacyRegistrations.Add(1)
			return miniReelRecoveryDevice("legacy"), nil
		}}
	options, err := miniReelNativeOptionsWithSources(context.Background(), "123", "default", "1004", sources)
	if err != nil || len(options) != 1 || legacyRegistrations.Load() != 0 {
		t.Fatalf("options=%d error=%v registrations=%d", len(options), err, legacyRegistrations.Load())
	}
}

func TestMiniReelFreshFallbackHostOrderNewIdentityAndBound(t *testing.T) {
	for _, succeedsAt := range []int{1, 2, 3, 4, 0} {
		t.Run(fmt.Sprint(succeedsAt), func(t *testing.T) {
			var registrations, calls int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				assertMiniReelPlaybackSignature(t, r)
				if r.Header.Get("Content-Encoding") != "" {
					t.Error("legacy request must send uncompressed JSON")
				}
				if r.URL.Query().Get("device_id") != fmt.Sprint((calls+1)/2) {
					t.Error("identity reused across rounds or replaced between hosts")
				}
				wantPath := "/primary"
				if calls%2 == 0 {
					wantPath = "/alternate"
				}
				if r.URL.Path != wantPath {
					t.Errorf("host order: %s", r.URL.Path)
				}
				body, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(body), `"device_level":3`) || !strings.Contains(string(body), `"1004":["123"]`) {
					t.Errorf("wrong legacy body: %s", body)
				}
				if calls == succeedsAt {
					io.WriteString(w, miniReelRecoveryModel)
				}
			}))
			defer server.Close()
			sources := miniReelPlaybackSources{legacyEndpoints: []string{server.URL + "/primary", server.URL + "/alternate"}, register: func(ctx context.Context) (miniReelDevice, error) {
				registrations++
				return miniReelRecoveryDevice(fmt.Sprint(registrations)), ctx.Err()
			}}
			options, err := miniReelRegisteredFallbackOptions(context.Background(), "123", "default", "1004", sources)
			wantCalls := succeedsAt
			if wantCalls == 0 {
				wantCalls = 4
			}
			if calls != wantCalls || registrations != (wantCalls+1)/2 {
				t.Fatalf("calls=%d registrations=%d", calls, registrations)
			}
			if succeedsAt > 0 && (err != nil || len(options) != 1) {
				t.Fatalf("options=%d error=%v", len(options), err)
			}
			if succeedsAt == 0 && !errors.Is(err, errMiniReelVideoModelEmpty) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestMiniReelFreshFallbackCancellationAndPermanentFailureStop(t *testing.T) {
	for _, cancelled := range []bool{true, false} {
		ctx, cancel := context.WithCancel(context.Background())
		calls, registrations := 0, 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			if cancelled {
				cancel()
			} else {
				io.WriteString(w, `{"code":100103}`)
			}
		}))
		sources := miniReelPlaybackSources{legacyEndpoints: []string{server.URL, server.URL}, register: func(context.Context) (miniReelDevice, error) {
			registrations++
			return miniReelRecoveryDevice("1"), nil
		}}
		_, err := miniReelRegisteredFallbackOptions(ctx, "123", "default", "1004", sources)
		if err == nil || calls != 1 || registrations != 1 {
			t.Fatalf("cancelled=%t calls=%d registrations=%d err=%v", cancelled, calls, registrations, err)
		}
		cancel()
		server.Close()
	}
}

func TestMiniReelFreshFallbackEpisodesDoNotConsumeTabIdentity(t *testing.T) {
	var tabRegistrations, legacyRegistrations int
	var used []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if r.URL.Query().Get("device_id") != "tab" {
				t.Error("legacy identity replaced video_tab identity")
			}
			return // Force fallback for each episode without changing the tab cache.
		}
		used = append(used, r.URL.Query().Get("device_id"))
		body, _ := io.ReadAll(r.Body)
		vid := "123"
		if strings.Contains(string(body), `"456"`) {
			vid = "456"
		}
		if !strings.Contains(string(body), `"1003":["`+vid+`"]`) {
			t.Error("fallback lost the content type")
		}
		io.WriteString(w, strings.ReplaceAll(miniReelRecoveryModel, `"123"`, `"`+vid+`"`))
	}))
	defer server.Close()
	cache := newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) {
		tabRegistrations++
		return miniReelRecoveryDevice("tab"), nil
	})
	sources := miniReelPlaybackSources{tabEndpoint: server.URL, tabIdentity: cache, legacyEndpoints: []string{server.URL}, register: func(context.Context) (miniReelDevice, error) {
		legacyRegistrations++
		return miniReelRecoveryDevice(fmt.Sprint(legacyRegistrations)), nil
	}}
	for _, vid := range []string{"123", "456"} {
		options, err := miniReelNativeOptionsWithSources(context.Background(), vid, "default", "1003", sources)
		if err != nil || len(options) != 1 {
			t.Fatalf("episode %s: options=%d error=%v", vid, len(options), err)
		}
	}
	if tabRegistrations != 1 || legacyRegistrations != 2 || strings.Join(used, ",") != "1,2" {
		t.Fatalf("tab=%d legacy=%d used=%v", tabRegistrations, legacyRegistrations, used)
	}
}

func TestMiniReelFreshFallbackNoCompatibleTabModelDoesNotRegister(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		model := strings.Replace(miniReelRecoveryModel, `"codec_type":"h264"`, `"codec_type":"bytevc2"`, 1)
		io.WriteString(w, strings.Replace(model, `"data":`, `"data":{"video_model_data":`, 1)+"}")
	}))
	defer server.Close()
	sources := miniReelPlaybackSources{tabEndpoint: server.URL,
		tabIdentity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("tab"), nil }),
		register: func(context.Context) (miniReelDevice, error) {
			t.Error("codec filtering must not rotate identities")
			return miniReelDevice{}, errors.New("unexpected registration")
		}}
	options, err := miniReelNativeOptionsWithSources(context.Background(), "123", "default", "1004", sources)
	if err != nil || len(options) != 0 {
		t.Fatalf("options=%d error=%v", len(options), err)
	}
}

func TestMiniReelFreshFallbackCancellationDuringRegistration(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	done := make(chan error, 1)
	var calls atomic.Int32
	sources := miniReelPlaybackSources{register: func(ctx context.Context) (miniReelDevice, error) {
		calls.Add(1)
		close(started)
		<-ctx.Done()
		return miniReelDevice{}, ctx.Err()
	}}
	go func() {
		_, err := miniReelRegisteredFallbackOptions(ctx, "123", "default", "1004", sources)
		done <- err
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || calls.Load() != 1 {
			t.Fatalf("calls=%d error=%v", calls.Load(), err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled registration did not release caller")
	}
}

func TestMiniReelLiveFreshRegisteredFallback(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_FRESH_FALLBACK") != "1" {
		t.Skip("set HONGGUO_LIVE_FRESH_FALLBACK=1 for forced legacy fallback verification")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 95*time.Second)
	defer cancel()
	vid := firstNonEmpty(os.Getenv("HONGGUO_LIVE_MINIREEL_VIDEO_ID"), "7690963562042248217")
	sources := miniReelPlaybackSources{legacyEndpoints: []string{"https://api5-normal-sinfonlineb.fqnovel.com" + miniReelAPIPath, "https://api5-normal-hl.fqnovel.com" + miniReelAPIPath}, register: registerMiniReelPlaybackDeviceContext}
	options, err := miniReelRegisteredFallbackOptions(ctx, vid, "default", "1004", sources)
	if err != nil || len(options) == 0 {
		t.Fatalf("forced legacy fallback: options=%d error=%v", len(options), err)
	}
	selected := chooseMiniReelOption(options)
	source, err := openMiniReelRangeSource(ctx, selected, vid)
	if err != nil {
		// Production also falls back to complete-file preparation when a CDN
		// cannot supply a strong validator or an indexable Range response.
		file := filepath.Join(t.TempDir(), "legacy.mp4")
		if err := downloadMiniReelMedia(ctx, selected.URL, file); err != nil {
			t.Fatalf("legacy full-file download: %v", err)
		}
		if len(selected.Key) > 0 {
			if err := decryptMiniReelMP4(file, selected.Key); err != nil {
				t.Fatalf("legacy full-file decrypt: %v", err)
			}
		}
		data, err := os.ReadFile(file)
		if err != nil || len(data) < 1048576 {
			t.Fatalf("legacy full-file bytes=%d error=%v", len(data), err)
		}
		t.Logf("forced legacy fallback quality=%s codec=%s renditions=%d mode=full decrypted_bytes=%d", selected.Quality, selected.Codec, len(options), len(data))
		return
	}
	end := int64(1048575)
	if source.Length-1 < end {
		end = source.Length - 1
	}
	data, err := source.readAndTransform(ctx, 0, end)
	if err != nil || len(data) != int(end+1) {
		t.Fatalf("legacy media read bytes=%d error=%v", len(data), err)
	}
	t.Logf("forced legacy fallback quality=%s codec=%s renditions=%d mode=range decrypted_bytes=%d", selected.Quality, selected.Codec, len(options), len(data))
}
