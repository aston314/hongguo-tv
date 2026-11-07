package main

import (
	"context"
	"errors"
	"net/http"
)

// The primary GET keeps its existing reusable identity and cookie contract.
// Legacy POST identities belong to one resolution only, never to video_tab,
// another episode, an account, or the old multi-route identity cache.
type miniReelPlaybackSources struct {
	tabEndpoint     string
	tabIdentity     *miniReelPlaybackDeviceCache
	legacyEndpoints []string
	register        func(context.Context) (miniReelDevice, error)
	singleEndpoint  string
	registerSingle  func(context.Context) (miniReelDevice, error)
	client          *http.Client
	memory          *miniReelSourceMemoryStore
}

func miniReelNativeOptionsWithSources(ctx context.Context, vid, codecMode, contentType string, sources miniReelPlaybackSources) ([]miniReelOption, error) {
	sequence := newMiniReelSourceSequence(sources, vid, codecMode, contentType, "")
	return sequence.next(ctx)
}

func miniReelRegisteredFallbackOptions(ctx context.Context, vid, codecMode, contentType string, sources miniReelPlaybackSources) ([]miniReelOption, error) {
	if _, err := normalizeMiniReelCodecMode(codecMode); err != nil {
		return nil, err
	}
	if _, err := normalizeMiniReelContentType(contentType); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, miniReelPlaybackRaceTimeout)
	defer cancel()
	var lastErr error
	attempt := 0
	// Two independently registered identities, at most two hosts each. These
	// requests already share the media job's foreground/prefetch cancellation.
	for round := 0; round < 2; round++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		device, err := sources.register(ctx)
		if err != nil {
			lastErr = err
			continue
		}
		for host, endpoint := range sources.legacyEndpoints {
			if host >= 2 {
				break
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			attempt++
			options, err := miniReelNativeOptionsAttemptProfile(ctx, vid, endpoint, device, sources.client, codecMode, contentType, true, host > 0, true)
			if err == nil {
				return options, nil
			}
			lastErr = playbackPreparationAttempt(err, attempt, round > 0)
			if !miniReelFreshFallbackRetryable(err) {
				return nil, lastErr
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if lastErr == nil {
		lastErr = errMiniReelVideoModelEmpty
	}
	return nil, lastErr
}

func miniReelFreshFallbackRetryable(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	diagnostic := playbackPreparationDetails(err)
	if errors.Is(err, errMiniReelVideoModelEmpty) {
		return diagnostic.HTTPStatus != nil && *diagnostic.HTTPStatus == http.StatusOK
	}
	if diagnostic.Code == "VIDEO_MODEL_TRANSPORT" || diagnostic.Code == "VIDEO_MODEL_READ" {
		return true
	}
	if diagnostic.Code == "VIDEO_MODEL_HTTP" && diagnostic.HTTPStatus != nil {
		switch *diagnostic.HTTPStatus {
		case 408, 425, 429, 500, 502, 503, 504:
			return true
		}
	}
	return false
}
