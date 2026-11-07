package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPlaybackPreparationSafeNetworkReason(t *testing.T) {
	for _, tc := range []struct {
		err    error
		reason string
	}{
		{&net.DNSError{Name: "private.test", Err: "secret"}, "dns"},
		{x509.UnknownAuthorityError{}, "tls"},
		{x509.HostnameError{Host: "private.test"}, "tls"},
		{context.DeadlineExceeded, "timeout"},
		{context.Canceled, "cancelled"},
		{syscall.ECONNREFUSED, "refused"},
		{syscall.ECONNRESET, "reset"},
		{syscall.ENETUNREACH, "unreachable"},
		{errors.New("DNS TLS timeout private.test secret"), ""},
	} {
		t.Run(tc.reason+fmt.Sprint(tc.err), func(t *testing.T) {
			cause := &url.Error{Op: "Post", URL: "https://private.test?token=secret", Err: tc.err}
			err := finishPlaybackPreparation(cause, playbackPreparationDiagnostic{Code: "DEVICE_REGISTER_FAILED", Stage: "device_register"}, time.Now())
			d := playbackPreparationDetails(err)
			if d.NetworkReason != tc.reason || d.HTTPStatus != nil || !errors.Is(err, tc.err) {
				t.Fatalf("diagnostic=%+v", d)
			}
			b, _ := json.Marshal(d)
			if strings.Contains(string(b), "private") || strings.Contains(string(b), "secret") {
				t.Fatal("private transport data leaked")
			}
		})
	}
}

func TestPlaybackPreparationRegistrationPreservesOnlySafeNetworkCause(t *testing.T) {
	device, err := newPassportDevice()
	if err != nil {
		t.Fatal(err)
	}
	client := newPassportClient(accountSession{Device: device})
	calls := 0
	client.http = &http.Client{Transport: miniReelTestRoundTripper(func(*http.Request) (*http.Response, error) {
		calls++
		return nil, &net.DNSError{Name: "private.test", Err: "secret"}
	})}
	err = client.registerDevice(context.Background())
	d := playbackPreparationDetails(err)
	if calls != 1 || d.Code != "DEVICE_REGISTER_FAILED" || d.NetworkReason != "dns" || d.HTTPStatus != nil {
		t.Fatalf("diagnostic=%+v calls=%d", d, calls)
	}
	if strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "secret") {
		t.Fatal("sanitized registration error changed")
	}
	assertPlaybackPreparationPublic(t, err, d.Code, "device_register", 0)
}
