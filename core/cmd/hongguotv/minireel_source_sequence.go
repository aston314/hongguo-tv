package main

import (
	"context"
	"errors"
	"time"
)

func miniReelProductionSources() miniReelPlaybackSources {
	return miniReelPlaybackSources{
		tabEndpoint: miniReelVideoTabBase + miniReelVideoTabPath, tabIdentity: miniReelPlaybackRouteIdentities[2],
		legacyEndpoints: []string{"https://api5-normal-sinfonlineb.fqnovel.com" + miniReelAPIPath, "https://api5-normal-hl.fqnovel.com" + miniReelAPIPath},
		register:        registerMiniReelPlaybackDeviceContext,
		singleEndpoint:  miniReelSingleEndpoint, registerSingle: registerMiniReelSingleDevice,
	}
}

// This cursor belongs to one preparation job. A parsed model is only a
// candidate; next also remains available if reading/decrypting that media fails.
// Only time spent resolving models consumes the shared 30-second source budget.
// The media job retains its existing overall deadline and cancellation owner.
type miniReelSourceSequence struct {
	sources                     miniReelPlaybackSources
	vid, codecMode, contentType string
	stage                       int
	spent                       time.Duration
	lastErr                     error
}

func miniReelSourceFallbackAllowed(err error) bool {
	if err == nil {
		return true
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	d := playbackPreparationDetails(err)
	if d.BusinessCode != "" {
		return false
	}
	if miniReelFreshFallbackRetryable(err) {
		return true
	}
	switch d.Code {
	case "VIDEO_MODEL_MISSING", "VIDEO_MODEL_LIST_EMPTY", "VIDEO_MODEL_JSON", "VIDEO_MODEL_NO_QUALITY", "DEVICE_REGISTER_FAILED", "DEVICE_REGISTER_READ":
		return true
	}
	return false
}

func (s *miniReelSourceSequence) next(ctx context.Context) ([]miniReelOption, error) {
	if _, err := normalizeMiniReelCodecMode(s.codecMode); err != nil {
		return nil, err
	}
	if _, err := normalizeMiniReelContentType(s.contentType); err != nil {
		return nil, err
	}
	for s.stage < 3 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		stage := s.stage
		s.stage++
		// Reserve time for later sources when an earlier upstream stalls.
		limit := []time.Duration{8 * time.Second, 14 * time.Second, 8 * time.Second}[stage]
		remaining := miniReelPlaybackRaceTimeout - s.spent
		if remaining <= 0 {
			return nil, context.DeadlineExceeded
		}
		if limit > remaining {
			limit = remaining
		}
		requestCtx, cancel := context.WithTimeout(ctx, limit)
		started := time.Now()
		var options []miniReelOption
		var err error
		switch stage {
		case 0:
			if s.sources.tabIdentity == nil || s.sources.tabEndpoint == "" {
				cancel()
				continue
			}
			var d miniReelDevice
			d, err = s.sources.tabIdentity.get(requestCtx)
			if err == nil {
				options, err = miniReelVideoTabOptionsWithClient(requestCtx, s.vid, s.sources.tabEndpoint, d, s.codecMode, s.sources.client)
			}
		case 1:
			if s.sources.register == nil || len(s.sources.legacyEndpoints) == 0 {
				cancel()
				continue
			}
			options, err = miniReelRegisteredFallbackOptions(requestCtx, s.vid, s.codecMode, s.contentType, s.sources)
		case 2:
			if s.sources.registerSingle == nil || s.sources.singleEndpoint == "" {
				cancel()
				continue
			}
			for attempt := 0; attempt < 2; attempt++ {
				var d miniReelDevice
				d, err = s.sources.registerSingle(requestCtx)
				if err == nil {
					options, err = miniReelSingleOptions(requestCtx, s.vid, s.sources.singleEndpoint, s.codecMode, d, s.sources.client)
				}
				if err == nil || !miniReelSourceFallbackAllowed(err) {
					break
				}
			}
		}
		timedOut := requestCtx.Err() != nil
		cancel()
		s.spent += time.Since(started)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err == nil && len(options) > 0 {
			return options, nil
		}
		s.lastErr = err
		if err != nil && !timedOut && !miniReelSourceFallbackAllowed(err) {
			return nil, err
		}
	}
	// Preserve the explicitly configured phone-device last resort, without
	// allowing test/custom source lists to escape to production hosts.
	if s.stage == 3 && s.sources.singleEndpoint == miniReelSingleEndpoint && miniReelPlaybackTargetRetryable(s.lastErr) {
		s.stage++
		if custom, ok := getPlaybackCustomDeviceForMiniReel(); ok && ctx.Err() == nil {
			remaining := miniReelPlaybackRaceTimeout - s.spent
			if remaining > 0 {
				customCtx, cancel := context.WithTimeout(ctx, remaining)
				options, err := miniReelNativeOptionsWithCustomDeviceForContentType(customCtx, s.vid, miniReelAPIBase+miniReelAPIPath, custom, s.codecMode, s.contentType)
				cancel()
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				if err == nil && len(options) > 0 {
					return options, nil
				}
			}
		}
	}

	return nil, s.lastErr
}

// Capability limitations of Range keep their established full-download fallback.
// Only actual HTTP/transport failures advance the provider here. Invalid MP4 or
// decrypt failures in the full path also advance, but cache errors never do.
func miniReelMediaSourceFallbackAllowed(ctx context.Context, err error) bool {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return false
	}
	switch playbackPreparationDetails(err).Code {
	case "MEDIA_DOWNLOAD_HTTP", "MEDIA_DOWNLOAD_FAILED", "MEDIA_DOWNLOAD_FAILED_TIMEOUT", "MEDIA_DECRYPT_FAILED", "RANGE_INIT_TRANSPORT", "RANGE_INIT_TRANSPORT_TIMEOUT":
		return true
	case "RANGE_INIT_HTTP":
		d := playbackPreparationDetails(err)
		return d.HTTPStatus != nil && *d.HTTPStatus != 200
	}
	return false
}

func prepareMiniReelWithSources(ctx context.Context, job *miniReelMediaJob, vid, quality string, fallback bool, sources miniReelPlaybackSources, prepare func(miniReelOption) error) {
	sequence := miniReelSourceSequence{sources: sources, vid: vid, codecMode: job.CodecMode, contentType: job.ContentType}
	for {
		started := time.Now()
		options, err := sequence.next(ctx)
		job.ResolveMS += time.Since(started).Milliseconds()
		if err != nil {
			job.Err = err
			return
		}
		if len(options) == 0 {
			job.Err = wrapPlaybackPreparation(miniReelNoCompatibleOptionsError(job.CodecMode), "source_select", "VIDEO_MODEL_NO_QUALITY")
			return
		}
		option, err := selectMiniReelQuality(options, quality, fallback)
		if err != nil {
			job.Err = wrapPlaybackPreparation(err, "source_select", "VIDEO_MODEL_NO_QUALITY")
			return
		}
		err = prepare(option)
		if err == nil {
			job.Quality = option.Quality
			job.Qualities = miniReelQualities(options)
			job.VideoCodec = option.Codec
			job.VideoWidth = option.Width
			job.VideoHeight = option.Height
			return
		}
		if !miniReelMediaSourceFallbackAllowed(ctx, err) || sequence.stage >= 3 {
			job.Err = err
			return
		}
		sequence.lastErr = err
	}
}
