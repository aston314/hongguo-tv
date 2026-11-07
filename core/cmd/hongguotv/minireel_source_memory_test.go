package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMiniReelFreshFallbackSourceMemoryScopeExpiryAndBound(t *testing.T) {
	m := newMiniReelSourceMemory()
	now := time.Now()
	m.now = func() time.Time { return now }
	key := miniReelSourceMemoryKey("12", "default", "1004", "", true)
	first := m.plan(key)
	first.observe(miniReelSingleProvider, true)
	if got := m.plan(key).order; got != [3]miniReelProvider{miniReelSingleProvider, miniReelTabProvider, miniReelLegacyProvider} {
		t.Fatal(got)
	}
	for _, other := range []string{
		miniReelSourceMemoryKey("13", "default", "1004", "", true),
		miniReelSourceMemoryKey("12", "software", "1004", "", true),
		miniReelSourceMemoryKey("12", "default", "1003", "", true),
		miniReelSourceMemoryKey("12", "default", "1004", "1080P", true),
		miniReelSourceMemoryKey("12", "default", "1004", "", false), "",
	} {
		if m.plan(other).order != first.order {
			t.Fatal("hint crossed preparation conditions")
		}
	}
	if first.order[0] != miniReelTabProvider {
		t.Fatal("in-flight plan changed")
	}
	now = now.Add(miniReelSourceMemoryTTL)
	if m.plan(key).order != first.order {
		t.Fatal("expired hint did not restore default")
	}
	for i := 0; i < miniReelSourceMemoryMax+20; i++ {
		m.plan(strings.Repeat("x", i+1)).observe(miniReelSingleProvider, true)
	}
	if len(m.entries) != miniReelSourceMemoryMax {
		t.Fatal("unbounded source memory")
	}
}

func TestMiniReelFreshFallbackSourceMemoryLateObservations(t *testing.T) {
	m := newMiniReelSourceMemory()
	old, current := m.plan("series"), m.plan("series")
	current.observe(miniReelSingleProvider, true)
	old.observe(miniReelLegacyProvider, true)
	old.observe(miniReelSingleProvider, false)
	if m.plan("series").order[0] != miniReelSingleProvider {
		t.Fatal("older job overwrote newer success")
	}
	newest := m.plan("series")
	newest.observe(miniReelSingleProvider, false)
	current.observe(miniReelSingleProvider, true)
	if m.plan("series").order[0] != miniReelTabProvider {
		t.Fatal("older job resurrected failed preference")
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Go(func() { m.plan("concurrent").observe(miniReelLegacyProvider, true) })
	}
	wg.Wait()
	if m.plan("concurrent").order[0] != miniReelLegacyProvider {
		t.Fatal("concurrent observation lost")
	}
}

// Exercise the real resolver cursor and quality/media error boundaries. Learning
// comes from the media callback, not merely parsing a model or a cached result.
func TestMiniReelFreshFallbackSeriesMemoryPreparation(t *testing.T) {
	for _, failure := range []string{"model", "media", "cancel", "storage", "quality", "success"} {
		t.Run(failure, func(t *testing.T) {
			m := newMiniReelSourceMemory()
			var order []string
			round := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, r.URL.Path)
				// First episode: only the single-episode route is compatible.
				if round == 0 && r.URL.Path != "/single" {
					io.WriteString(w, strings.ReplaceAll(miniReelRecoveryModel, "h264", "bytevc2"))
					return
				}
				if round == 1 && failure == "model" && r.URL.Path == "/single" {
					io.WriteString(w, strings.ReplaceAll(miniReelRecoveryModel, "h264", "bytevc2"))
					return
				}
				model := miniReelRecoveryModel
				if r.URL.Path == "/tab" {
					model = strings.Replace(model, `"data":`, `"data":{"video_model_data":`, 1) + "}"
				}
				io.WriteString(w, model)
			}))
			defer server.Close()
			sources := miniReelPlaybackSources{memory: m, tabEndpoint: server.URL + "/tab", tabIdentity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("tab"), nil }), legacyEndpoints: []string{server.URL + "/legacy"}, register: func(context.Context) (miniReelDevice, error) { return miniReelRecoveryDevice("legacy"), nil }, singleEndpoint: server.URL + "/single", registerSingle: func(context.Context) (miniReelDevice, error) { return miniReelRecoveryDevice("single"), nil }}
			prepare := func(ctx context.Context, series, quality string, media func(miniReelOption) error) *miniReelMediaJob {
				job := &miniReelMediaJob{CodecMode: "default", ContentType: "1004"}
				prepareMiniReelWithSources(ctx, job, series, "123", quality, false, sources, media)
				return job
			}
			ok := func(miniReelOption) error { return nil }
			if job := prepare(context.Background(), "999", "", ok); job.Err != nil || !reflect.DeepEqual(order, []string{"/tab", "/legacy", "/single"}) {
				t.Fatalf("initial order=%v error=%v", order, job.Err)
			}
			round, order = 1, nil
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			media := func(miniReelOption) error {
				calls++
				if calls > 1 {
					return nil
				}
				switch failure {
				case "media":
					return wrapPlaybackPreparation(errors.New("invalid media"), "media_decrypt", "MEDIA_DECRYPT_FAILED")
				case "cancel":
					cancel()
					return context.Canceled
				case "storage":
					return playbackStorageError(os.ErrPermission)
				}
				return nil
			}
			if failure == "quality" {
				// Use the same normalized preference key, but remove the selected
				// quality from the current candidate set in a separate sequence.
				key := miniReelSourceMemoryKey("999", "default", "1004", "1080P", false)
				m.plan(key).observe(miniReelSingleProvider, true)
				job := prepare(ctx, "999", "1080P", media)
				if job.Err == nil || calls != 0 || m.plan(key).order[0] != miniReelSingleProvider || !reflect.DeepEqual(order, []string{"/single"}) {
					t.Fatalf("quality incorrectly learned/retried: %v %v", order, job.Err)
				}
				return
			}
			job := prepare(ctx, "999", "", media)
			key := miniReelSourceMemoryKey("999", "default", "1004", "", false)
			if failure == "cancel" || failure == "storage" {
				if job.Err == nil || m.plan(key).order[0] != miniReelSingleProvider || !reflect.DeepEqual(order, []string{"/single"}) {
					t.Fatalf("non-source failure altered hint: %v %v", order, job.Err)
				}
				return
			}
			want := []string{"/single"}
			preferred := miniReelSingleProvider
			if failure == "model" || failure == "media" {
				want = append(want, "/tab")
				preferred = miniReelTabProvider
			}
			if job.Err != nil || !reflect.DeepEqual(order, want) || m.plan(key).order[0] != preferred {
				t.Fatalf("order=%v wanted=%v error=%v", order, want, job.Err)
			}
			order, round = nil, 2
			if next := prepare(context.Background(), "998", "", ok); next.Err != nil || !reflect.DeepEqual(order, []string{"/tab"}) {
				t.Fatal("preference leaked to another series", order, next.Err)
			}
		})
	}
}

func TestMiniReelFreshFallbackRememberedOrderNeverRevisitsProviders(t *testing.T) {
	for _, preferred := range []miniReelProvider{miniReelTabProvider, miniReelLegacyProvider, miniReelSingleProvider} {
		t.Run(string(preferred), func(t *testing.T) {
			m := newMiniReelSourceMemory()
			key := miniReelSourceMemoryKey("999", "default", "1004", "", true)
			m.plan(key).observe(preferred, true)
			want := m.plan(key).order
			var order []miniReelProvider
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				provider := miniReelProvider(strings.TrimPrefix(r.URL.Path, "/"))
				order = append(order, provider)
				model := miniReelRecoveryModel
				if provider == miniReelTabProvider {
					model = strings.Replace(model, `"data":`, `"data":{"video_model_data":`, 1) + "}"
				}
				io.WriteString(w, model)
			}))
			defer server.Close()
			sources := miniReelPlaybackSources{memory: m, tabEndpoint: server.URL + "/video_tab", tabIdentity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("tab"), nil }), legacyEndpoints: []string{server.URL + "/multi_video_model"}, register: func(context.Context) (miniReelDevice, error) { return miniReelRecoveryDevice("legacy"), nil }, singleEndpoint: server.URL + "/video_model", registerSingle: func(context.Context) (miniReelDevice, error) { return miniReelRecoveryDevice("single"), nil }}
			job := &miniReelMediaJob{CodecMode: "default", ContentType: "1004"}
			calls := 0
			prepareMiniReelWithSources(context.Background(), job, "999", "123", "", true, sources, func(miniReelOption) error {
				calls++
				// Learning by another in-flight episode must not reorder this job.
				m.plan(key).observe(miniReelLegacyProvider, true)
				return wrapPlaybackPreparation(errors.New("bad media"), "media_decrypt", "MEDIA_DECRYPT_FAILED")
			})
			if job.Err == nil || calls != 3 || !reflect.DeepEqual(order, want[:]) {
				t.Fatalf("provider revisited/reordered: %v expected %v error=%v", order, want, job.Err)
			}
		})
	}
}
