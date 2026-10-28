package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type mediaPreparation func(context.Context, *miniReelMediaJob, string, string, string, string, bool)

// These tests never call the upstream resolver or touch the real media cache.
func isolatedMediaJobs(t testing.TB) string {
	t.Helper()
	root := t.TempDir()
	miniReelState.Lock()
	oldJobs, oldRoot := miniReelState.jobs, miniReelState.root
	oldLease, oldRootCleanup := miniReelState.lease, miniReelState.lastRootCleanup
	miniReelState.jobs, miniReelState.root = map[string]*miniReelMediaJob{}, root
	miniReelState.lease, miniReelState.lastRootCleanup = nil, time.Time{}
	miniReelState.Unlock()
	t.Cleanup(func() {
		miniReelState.Lock()
		jobs := miniReelState.jobs
		for _, job := range jobs {
			if job.Cancel != nil {
				job.Cancel()
			}
		}
		miniReelState.Unlock()
		for _, job := range jobs {
			awaitMediaSignal(t, job.Ready)
		}
		miniReelState.Lock()
		if miniReelState.lease != nil {
			miniReelState.lease.Close()
		}
		miniReelState.jobs, miniReelState.root = oldJobs, oldRoot
		miniReelState.lease, miniReelState.lastRootCleanup = oldLease, oldRootCleanup
		miniReelState.Unlock()
	})
	return root
}

func awaitMediaSignal(t testing.TB, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("media job did not settle")
	}
}

func waitMediaCondition(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !predicate() {
		if time.Now().After(deadline) {
			t.Fatal("media condition did not become true")
		}
		time.Sleep(time.Millisecond)
	}
}

func resolveTestMedia(ctx context.Context, quality string, fallback bool, prepare mediaPreparation) <-chan error {
	out := make(chan error, 1)
	go func() { _, err := resolveMiniReelMediaWith(ctx, "123", "456", quality, fallback, prepare); out <- err }()
	return out
}

func awaitMediaResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("media request did not settle")
		return nil
	}
}

func completedTestMedia(root string, job *miniReelMediaJob, token, quality string) {
	dir := filepath.Join(root, token)
	job.Err = os.MkdirAll(dir, 0700)
	if job.Err != nil {
		return
	}
	path := filepath.Join(dir, token+".mp4")
	job.Err = os.WriteFile(path, []byte("fixture media bytes"), 0600)
	if job.Err == nil {
		job.Path, job.Quality = path, quality
	}
}

func TestEpisodePreparationSharesJobAndCancellation(t *testing.T) {
	root := isolatedMediaJobs(t)
	started, release := make(chan struct{}), make(chan struct{})
	var attempts atomic.Int32
	prepare := func(ctx context.Context, job *miniReelMediaJob, token, _, _, quality string, _ bool) {
		attempts.Add(1)
		close(started)
		select {
		case <-ctx.Done():
			job.Err = ctx.Err()
		case <-release:
			completedTestMedia(root, job, token, quality)
		}
	}
	prefetchCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	prefetch := resolveTestMedia(prefetchCtx, "720P", true, prepare)
	awaitMediaSignal(t, started)
	foreground := resolveTestMedia(context.Background(), "720P", true, prepare)
	var job *miniReelMediaJob
	waitMediaCondition(t, func() bool {
		miniReelState.Lock()
		defer miniReelState.Unlock()
		job = miniReelState.jobs[miniReelQualityToken("123", "456", "720P", true)]
		return job != nil && job.Waiters == 2
	})
	cancel()
	if err := awaitMediaResult(t, prefetch); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if job.Context.Err() != nil {
		t.Fatal("canceling prefetch canceled its foreground consumer")
	}
	close(release)
	if err := awaitMediaResult(t, foreground); err != nil {
		t.Fatal(err)
	}
	if err := awaitMediaResult(t, resolveTestMedia(context.Background(), "720P", true, prepare)); err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 1 {
		t.Fatal("duplicate preparation", attempts.Load())
	}
}

func TestLastConsumerCancelsMediaDownloadAndRemovesPartialFile(t *testing.T) {
	root := isolatedMediaJobs(t)
	streaming, canceled := make(chan struct{}), make(chan struct{})
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, 16384))
		w.(http.Flusher).Flush()
		close(streaming)
		<-r.Context().Done()
		close(canceled)
	}))
	defer host.Close()
	path := filepath.Join(root, "partial.mp4")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := resolveTestMedia(ctx, "", true, func(ctx context.Context, job *miniReelMediaJob, _, _, _, _ string, _ bool) {
		job.Err = downloadMiniReelMedia(ctx, host.URL, path)
	})
	awaitMediaSignal(t, streaming)
	waitMediaCondition(t, func() bool { s, err := os.Stat(path); return err == nil && s.Size() > 0 })
	cancel()
	if err := awaitMediaResult(t, result); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	awaitMediaSignal(t, canceled)
	miniReelState.Lock()
	job := miniReelState.jobs[miniReelQualityToken("123", "456", "", true)]
	miniReelState.Unlock()
	awaitMediaSignal(t, job.Ready)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("partial download survived cancellation", err)
	}
}

func TestCanceledJobFinishesCleanupBeforeRetryWritesSameToken(t *testing.T) {
	root := isolatedMediaJobs(t)
	started, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var attempts atomic.Int32
	var overlap atomic.Bool
	var active atomic.Int32
	prepare := func(ctx context.Context, job *miniReelMediaJob, token, _, _, quality string, _ bool) {
		if active.Add(1) != 1 {
			overlap.Store(true)
		}
		defer active.Add(-1)
		if attempts.Add(1) == 1 {
			close(started)
			<-ctx.Done()
			close(canceled)
			<-release
			job.Err = ctx.Err()
			return
		}
		completedTestMedia(root, job, token, quality)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := resolveTestMedia(ctx, "720P", true, prepare)
	awaitMediaSignal(t, started)
	cancel()
	_ = awaitMediaResult(t, first)
	awaitMediaSignal(t, canceled)
	second := resolveTestMedia(context.Background(), "720P", true, prepare)
	select {
	case err := <-second:
		t.Fatal("retry returned before the canceled job finished cleaning", err)
	case <-time.After(20 * time.Millisecond):
	}
	if attempts.Load() != 1 {
		t.Fatal("retry wrote before the canceled job finished cleaning")
	}
	close(release)
	if err := awaitMediaResult(t, second); err != nil {
		t.Fatal(err)
	}
	if overlap.Load() || attempts.Load() != 2 {
		t.Fatal("same-token jobs overlapped", overlap.Load(), attempts.Load())
	}
}

func TestFailedPreparationRetriesAndQualityCacheIsIndependent(t *testing.T) {
	root := isolatedMediaJobs(t)
	var attempts atomic.Int32
	prepare := func(_ context.Context, job *miniReelMediaJob, token, _, _, quality string, _ bool) {
		if attempts.Add(1) == 1 {
			job.Err = errors.New("network failed")
			return
		}
		completedTestMedia(root, job, token, quality)
	}
	if err := awaitMediaResult(t, resolveTestMedia(context.Background(), "720P", true, prepare)); err == nil {
		t.Fatal("expected speculative failure")
	}
	for _, request := range []struct {
		quality  string
		fallback bool
	}{{"720P", true}, {"720P", true}, {"1080P", true}, {"720P", false}} {
		if err := awaitMediaResult(t, resolveTestMedia(context.Background(), request.quality, request.fallback, prepare)); err != nil {
			t.Fatal(err)
		}
	}
	if attempts.Load() != 4 {
		t.Fatal("failure or quality cache was reused incorrectly", attempts.Load())
	}
	miniReelState.Lock()
	path := miniReelState.jobs[miniReelQualityToken("123", "456", "720P", true)].Path
	miniReelState.Unlock()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := awaitMediaResult(t, resolveTestMedia(context.Background(), "720P", true, prepare)); err != nil {
		t.Fatal(err)
	}
	if attempts.Load() != 5 {
		t.Fatal("missing cached media did not retry", attempts.Load())
	}
}

func TestFailedMediaResponseRemovesUnusableFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tiny.mp4")
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("tiny")) }))
	defer host.Close()
	if err := downloadMiniReelMedia(context.Background(), host.URL, path); err == nil {
		t.Fatal("invalid small media accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("invalid file retained", err)
	}
}
