package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsupdate"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

type fakeRepairRuntime struct {
	mu      sync.Mutex
	status  jsupdate.Status
	check   func(context.Context) error
	resolve func(context.Context, resolverwire.Request) ([]resolverwire.Option, error)
	closed  atomic.Bool
}

func (f *fakeRepairRuntime) Status() jsupdate.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status
}
func (f *fakeRepairRuntime) Check(ctx context.Context) error {
	if f.check != nil {
		return f.check(ctx)
	}
	return nil
}
func (f *fakeRepairRuntime) Resolve(ctx context.Context, r resolverwire.Request) ([]resolverwire.Option, error) {
	if f.resolve != nil {
		return f.resolve(ctx, r)
	}
	return nil, nil
}
func (f *fakeRepairRuntime) Close(context.Context) error { f.closed.Store(true); return nil }
func (f *fakeRepairRuntime) setStatus(s jsupdate.Status) { f.mu.Lock(); f.status = s; f.mu.Unlock() }
func waitRepair(t *testing.T, s *playbackRepairService) playbackRepairStatus {
	t.Helper()
	until := time.Now().Add(2 * time.Second)
	for time.Now().Before(until) {
		v := s.status()
		if !v.Checking {
			return v
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("repair check stalled")
	return playbackRepairStatus{}
}
func repairServiceForTest(t *testing.T) (*playbackRepairService, *fakeRepairRuntime, *atomic.Int32) {
	t.Helper()
	s := newPlaybackRepairService(t.TempDir())
	f := &fakeRepairRuntime{status: jsupdate.Status{Source: "embedded", SHA256: "old"}}
	var count atomic.Int32
	s.factory = func(context.Context) (repairRuntime, error) { count.Add(1); return f, nil }
	t.Cleanup(func() { s.close(context.Background()) })
	return s, f, &count
}
func TestPlaybackRepairDefaultOffAndPersistence(t *testing.T) {
	s, f, count := repairServiceForTest(t)
	s.check()
	if s.status().Enabled || count.Load() != 0 {
		t.Fatal("default started JS")
	}
	f.check = func(context.Context) error {
		f.setStatus(jsupdate.Status{Source: "downloaded", Enabled: true, Version: "v1", SHA256: "new", Event: "activated"})
		return nil
	}
	if e := s.setEnabled(true); e != nil {
		t.Fatal(e)
	}
	v := waitRepair(t, s)
	if v.Source != "repair" || v.Event != "updated" || v.LastUpdated == 0 || count.Load() != 1 {
		t.Fatal(v, count.Load())
	}
	s.check()
	v = waitRepair(t, s)
	if v.Event != "up_to_date" {
		t.Fatal("same script advertised as a new update", v)
	}
	restored := newPlaybackRepairService(s.dir)
	defer restored.close(context.Background())
	if !restored.status().Enabled {
		t.Fatal("preference lost on new port/process")
	}
	if e := s.setEnabled(false); e != nil {
		t.Fatal(e)
	}
	if s.status().Source != "native" || s.status().Enabled {
		t.Fatal(s.status())
	}
	again := newPlaybackRepairService(s.dir)
	defer again.close(context.Background())
	if again.status().Enabled {
		t.Fatal("disabled preference lost")
	}
}
func TestPlaybackRepairDownloadFailureKeepsCachedRules(t *testing.T) {
	s, f, _ := repairServiceForTest(t)
	f.status = jsupdate.Status{Source: "downloaded", Enabled: true, Version: "cached", SHA256: "good"}
	f.check = func(context.Context) error { return errors.New("offline") }
	s.setEnabled(true)
	v := waitRepair(t, s)
	if v.Event != "check_failed" || v.Source != "repair" || v.Version != "cached" {
		t.Fatal(v)
	}
}
func TestPlaybackRepairDisableCancelsCheckAndCannotReenableItself(t *testing.T) {
	s, f, count := repairServiceForTest(t)
	entered := make(chan struct{})
	f.check = func(ctx context.Context) error { close(entered); <-ctx.Done(); return ctx.Err() }
	s.setEnabled(true)
	<-entered
	s.check()
	if count.Load() != 1 {
		t.Fatal("duplicate runtime")
	}
	if e := s.setEnabled(false); e != nil {
		t.Fatal(e)
	}
	time.Sleep(15 * time.Millisecond)
	v := s.status()
	if v.Enabled || v.Checking || v.Source != "native" {
		t.Fatal("late check revived disabled rules", v)
	}
}
func TestPlaybackRepairFailureToSaveKeepsSelection(t *testing.T) {
	s, _, count := repairServiceForTest(t)
	os.MkdirAll(filepath.Dir(s.preferencePath()), 0700)
	os.Mkdir(s.preferencePath(), 0700)
	if e := s.setEnabled(true); e == nil {
		t.Fatal("failed preference write accepted")
	}
	if s.status().Enabled || count.Load() != 0 {
		t.Fatal(s.status())
	}
}
func TestPlaybackRepairDoesNotUseEmbeddedJSOrDisabledRemote(t *testing.T) {
	s, f, _ := repairServiceForTest(t)
	var calls atomic.Int32
	f.resolve = func(context.Context, resolverwire.Request) ([]resolverwire.Option, error) {
		calls.Add(1)
		return []resolverwire.Option{{URL: "https://media.example/repair.mp4", Codec: "h265", Quality: "720P"}}, nil
	}
	s.setEnabled(true)
	waitRepair(t, s)
	out, e := s.resolve(context.Background(), "123", "default", "1004")
	if e != nil || len(out) > 0 || calls.Load() != 0 {
		t.Fatal("embedded JS duplicated native")
	}
	f.setStatus(jsupdate.Status{Source: "downloaded", Enabled: true})
	out, e = s.resolve(context.Background(), "123", "default", "1004")
	if e != nil || len(out) != 1 || calls.Load() != 1 {
		t.Fatal(out, e)
	}
	s.setEnabled(false)
	s.resolve(context.Background(), "123", "default", "1004")
	if calls.Load() != 1 {
		t.Fatal("used rule after off")
	}
}
func TestMiniReelRepairFailureAndMediaFailureKeepNativeFallback(t *testing.T) {
	var nativeCalls atomic.Int32
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nativeCalls.Add(1)
		io.WriteString(w, `{"code":0,"data":{"video_model_data":{"123":{"video_model":{"video_list":[{"main_url":"https://media.example/native.mp4","codec_type":"h264","vwidth":1280,"vheight":720}]}}}}}`)
	}))
	defer native.Close()
	for _, fails := range []bool{true, false} {
		nativeCalls.Store(0)
		var repairCalls int
		sources := miniReelPlaybackSources{tabEndpoint: native.URL, tabIdentity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("tab"), nil }), repair: func(context.Context, string, string, string) ([]miniReelOption, error) {
			repairCalls++
			if fails {
				return nil, errors.New("script failed")
			}
			return []miniReelOption{{URL: "https://media.example/repair.mp4", Codec: "h264", Width: 1280, Height: 720, Quality: "720P"}}, nil
		}}
		job := &miniReelMediaJob{CodecMode: "default", ContentType: "1004"}
		prepareMiniReelWithSources(context.Background(), job, "1", "123", "", true, sources, func(o miniReelOption) error {
			if o.URL == "https://media.example/repair.mp4" {
				return wrapPlaybackPreparation(errors.New("unreachable"), "media_download", "MEDIA_DOWNLOAD_FAILED")
			}
			return nil
		})
		if job.Err != nil || nativeCalls.Load() != 1 || repairCalls != 1 {
			t.Fatalf("repair=%d native=%d err=%v", repairCalls, nativeCalls.Load(), job.Err)
		}
	}
}
func TestPlaybackRepairMutationRequiresPrivateLocalRequest(t *testing.T) {
	s, _, _ := repairServiceForTest(t)
	app := &server{repair: s}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/playback/repair", app.playbackRepair)
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8797/api/v1/playback/repair", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	app.withCORS(mux).ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("external site could change repair preference", w.Code)
	}
}

func TestPlaybackRepairRapidToggleRetiresBeforeNewRuntime(t *testing.T) {
	s := newPlaybackRepairService(t.TempDir())
	defer s.close(context.Background())
	var live, maximum, created atomic.Int32
	s.factory = func(context.Context) (repairRuntime, error) {
		n := live.Add(1)
		for {
			old := maximum.Load()
			if n <= old || maximum.CompareAndSwap(old, n) {
				break
			}
		}
		created.Add(1)
		return &countedRepairRuntime{fakeRepairRuntime: fakeRepairRuntime{status: jsupdate.Status{Source: "embedded"}}, close: func() { live.Add(-1) }}, nil
	}
	for i := 0; i < 20; i++ {
		if e := s.setEnabled(true); e != nil {
			t.Fatal(e)
		}
		waitRepair(t, s)
		if e := s.setEnabled(false); e != nil {
			t.Fatal(e)
		}
	}
	s.close(context.Background())
	if maximum.Load() != 1 || live.Load() != 0 || created.Load() != 20 {
		t.Fatal("runtime accumulation", maximum.Load(), live.Load(), created.Load())
	}
}

type countedRepairRuntime struct {
	fakeRepairRuntime
	once  sync.Once
	close func()
}

func (f *countedRepairRuntime) Close(context.Context) error { f.once.Do(f.close); return nil }
