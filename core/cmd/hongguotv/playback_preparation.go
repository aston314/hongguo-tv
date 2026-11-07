package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"os"
	"regexp"
	"syscall"
	"time"
)

// Request-owned, immutable metadata. Never serialize the wrapped error: network
// errors contain signed URLs and filesystem errors contain private cache paths.
type playbackPreparationDiagnostic struct {
	Code          string                         `json:"code"`
	Stage         string                         `json:"stage"`
	HTTPStatus    *int                           `json:"http_status,omitempty"`
	ResponseBytes *int                           `json:"response_bytes,omitempty"`
	Attempt       int                            `json:"attempt,omitempty"`
	ElapsedMS     *int64                         `json:"elapsed_ms,omitempty"`
	BusinessCode  string                         `json:"business_code,omitempty"`
	NetworkReason string                         `json:"network_reason,omitempty"`
	RangeFailure  *playbackPreparationDiagnostic `json:"range_failure,omitempty"`
}

type playbackPreparationError struct {
	diagnostic playbackPreparationDiagnostic
	cause      error
}

func (e *playbackPreparationError) Error() string { return e.cause.Error() }
func (e *playbackPreparationError) Unwrap() error { return e.cause }

func playbackPreparationDetails(err error) playbackPreparationDiagnostic {
	var failure *playbackPreparationError
	if errors.As(err, &failure) {
		return failure.diagnostic
	}
	return playbackPreparationDiagnostic{Code: "PLAYBACK_PREPARE_FAILED", Stage: "playback_prepare"}
}

// Classify types only: error text may contain signed URLs, proxy credentials
// or private hostnames. This is diagnostic metadata, never a retry policy.
func playbackNetworkReason(err error) string {
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns"
	}
	var certificate *tls.CertificateVerificationError
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.As(err, &certificate) || errors.As(err, &authority) || errors.As(err, &hostname) || errors.As(err, &invalid) {
		return "tls"
	}
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout() {
		return "timeout"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "refused"
	}
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) {
		return "reset"
	}
	if errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) {
		return "unreachable"
	}
	return ""
}

func wrapPlaybackPreparation(err error, stage, code string) error {
	if err == nil {
		return nil
	}
	var existing *playbackPreparationError
	if errors.As(err, &existing) {
		return err
	}
	if errors.Is(err, context.DeadlineExceeded) {
		code += "_TIMEOUT"
	} else {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			code += "_TIMEOUT"
		}
	}
	return &playbackPreparationError{diagnostic: playbackPreparationDiagnostic{Code: code, Stage: stage, NetworkReason: playbackNetworkReason(err)}, cause: err}
}

func finishPlaybackPreparation(err error, diagnostic playbackPreparationDiagnostic, started time.Time) error {
	if err == nil {
		return nil
	}
	var existing *playbackPreparationError
	if errors.As(err, &existing) {
		return err
	}
	elapsed := time.Since(started).Milliseconds()
	diagnostic.ElapsedMS = &elapsed
	// This also classifies deadlines without examining potentially sensitive text.
	classified := wrapPlaybackPreparation(err, diagnostic.Stage, diagnostic.Code).(*playbackPreparationError)
	diagnostic.Code = classified.diagnostic.Code
	if diagnostic.NetworkReason == "" {
		diagnostic.NetworkReason = classified.diagnostic.NetworkReason
	}
	return &playbackPreparationError{diagnostic: diagnostic, cause: err}
}

func playbackPreparationAttempt(err error, attempt int, add bool) error {
	if err == nil {
		return nil
	}
	var existing *playbackPreparationError
	if !errors.As(err, &existing) {
		return err
	}
	diagnostic := existing.diagnostic
	if diagnostic.Stage != "multi_video_model" {
		return err
	}
	if add {
		diagnostic.Attempt += attempt
	} else {
		diagnostic.Attempt = attempt
	}
	return &playbackPreparationError{diagnostic: diagnostic, cause: err}
}

func playbackPreparationFallback(rangeErr, fullErr error) error {
	diagnostic := playbackPreparationDetails(fullErr)
	rangeDiagnostic := playbackPreparationDetails(rangeErr)
	diagnostic.RangeFailure = &rangeDiagnostic
	return &playbackPreparationError{diagnostic: diagnostic, cause: fullErr}
}

func playbackStorageError(err error) error {
	return wrapPlaybackPreparation(err, "cache_write", "MEDIA_CACHE_WRITE_FAILED")
}

func playbackDownloadError(err error) error {
	var pathError *os.PathError
	if errors.As(err, &pathError) {
		return playbackStorageError(err)
	}
	return wrapPlaybackPreparation(err, "media_download", "MEDIA_DOWNLOAD_FAILED")
}

var playbackBusinessCode = regexp.MustCompile(`^[0-9]{1,16}$`)

func safePlaybackBusinessCode(value string) string {
	if playbackBusinessCode.MatchString(value) {
		return value
	}
	return ""
}

func writePlaybackPreparationError(w http.ResponseWriter, err error) {
	diagnostic := playbackPreparationDetails(err)
	writeJSON(w, http.StatusBadGateway, map[string]any{
		"ok": false, "error": diagnostic.Code, "stage": diagnostic.Stage, "preparation": diagnostic,
	})
}
