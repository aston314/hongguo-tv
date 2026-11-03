package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// v1.2.20 treats a missing/empty model as a stream miss for the current
// anonymous identity. Recovery is deliberately serialized and bounded: a
// candidate is not published until the same vid returns a usable source.
type miniReelIdentityRecoveryTask struct {
	done    chan struct{}
	key     string
	options []miniReelOption
	err     error
}

func (t *miniReelIdentityRecoveryTask) wait(ctx context.Context) ([]miniReelOption, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.done:
		return t.options, t.err
	}
}

type miniReelIdentityRecovery struct {
	mu            sync.Mutex
	active        map[string]*miniReelIdentityRecoveryTask
	lastStarted   map[string]time.Time
	cooldown      time.Duration
	confirmGap    time.Duration
	maxCandidates int
}

func newMiniReelIdentityRecovery() *miniReelIdentityRecovery {
	return &miniReelIdentityRecovery{
		active:        make(map[string]*miniReelIdentityRecoveryTask),
		lastStarted:   make(map[string]time.Time),
		cooldown:      miniReelIdentityRefreshGap,
		confirmGap:    miniReelIdentityConfirmGap,
		maxCandidates: miniReelIdentityCandidates,
	}
}

var miniReelPlaybackRecovery = newMiniReelIdentityRecovery()

func miniReelRecoveryKey(identity *miniReelPlaybackDeviceCache, endpoint, vid, codecMode, contentType string) string {
	return fmt.Sprintf("%p\x00%s\x00%s\x00%s\x00%s", identity, endpoint, vid, codecMode, contentType)
}

func (r *miniReelIdentityRecovery) recover(ctx context.Context, identity *miniReelPlaybackDeviceCache, failed miniReelDevice, vid, endpoint, codecMode, contentType string, original error) ([]miniReelOption, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := miniReelRecoveryKey(identity, endpoint, vid, codecMode, contentType)
	r.mu.Lock()
	if task := r.active[key]; task != nil {
		r.mu.Unlock()
		return task.wait(ctx)
	}
	if started := r.lastStarted[key]; !started.IsZero() && time.Since(started) < r.cooldown {
		r.mu.Unlock()
		return nil, fmt.Errorf("%w: %w", errMiniReelIdentityRefreshCoolingDown, original)
	}
	task := &miniReelIdentityRecoveryTask{done: make(chan struct{}), key: key}
	r.active[key] = task
	r.lastStarted[key] = time.Now()
	identity.mu.Lock()
	identity.refreshAfter = time.Now().Add(r.cooldown)
	identity.mu.Unlock()
	r.mu.Unlock()

	// A caller leaving the player must not cancel a recovery that another
	// prefetch or foreground request is already waiting for.
	workCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
	go func() {
		defer cancel()
		task.options, task.err = r.run(workCtx, identity, failed, vid, endpoint, codecMode, contentType, original)
		close(task.done)
		r.mu.Lock()
		delete(r.active, key)
		r.mu.Unlock()
	}()
	return task.wait(ctx)
}

func (r *miniReelIdentityRecovery) run(ctx context.Context, identity *miniReelPlaybackDeviceCache, failed miniReelDevice, vid, endpoint, codecMode, contentType string, original error) ([]miniReelOption, error) {
	// Confirm that the current identity still misses this exact vid before
	// spending registrations. A transient edge response must not rotate it.
	var lastErr error = original
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 && r.confirmGap > 0 {
			if err := miniReelWaitForRetry(ctx, time.Now().Add(r.confirmGap)); err != nil {
				return nil, err
			}
		}
		requestEndpoint, signed := miniReelPlaybackAttemptPolicy(endpoint, attempt)
		options, err := miniReelNativeOptionsAttemptPolicyForContentType(ctx, vid, requestEndpoint, failed, nil, codecMode, contentType, signed, attempt > 0)
		if err == nil {
			return options, nil
		}
		lastErr = err
		if !errors.Is(err, errMiniReelStreamMiss) {
			return nil, err
		}
	}

	for candidateIndex := 0; candidateIndex < r.maxCandidates; candidateIndex++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		candidate, err := identity.register()
		if err != nil {
			lastErr = err
			continue
		}
		// Do not publish the candidate until it has returned a usable source for
		// the same vid that triggered recovery.
		requestEndpoint, signed := miniReelPlaybackAttemptPolicy(endpoint, 0)
		options, err := miniReelNativeOptionsAttemptPolicyForContentType(ctx, vid, requestEndpoint, candidate, nil, codecMode, contentType, signed, false)
		if err == nil && len(options) > 0 {
			identity.adopt(candidate)
			return options, nil
		}
		lastErr = err
		if err != nil && !errors.Is(err, errMiniReelStreamMiss) {
			return nil, err
		}
	}
	return nil, fmt.Errorf("%w; anonymous playback identity recovery exhausted: %v", original, lastErr)
}

func miniReelWaitForRetry(ctx context.Context, retryAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if delay := time.Until(retryAt); delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
	return ctx.Err()
}
