package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func assertMiniReelPlaybackSignature(t *testing.T, r *http.Request) {
	t.Helper()
	for _, name := range []string{"X-Gorgon", "X-Medusa", "X-Helios", "X-Khronos", "X-SS-Req-Ticket", "X-Argus", "X-Ladon"} {
		if r.Header.Get(name) == "" {
			t.Errorf("playback signature header missing: %s", name)
		}
	}
	if r.Header.Get("Cookie") != "" || r.Header.Get("X-Tt-Token") != "" {
		t.Error("playback signature must not use account credentials")
	}
	query := r.URL.Query()
	if query.Get("ts") != r.Header.Get("X-Khronos") || query.Get("_rticket") != r.Header.Get("X-SS-Req-Ticket") {
		t.Error("playback query and header timestamps diverged")
	}
	stamp, _ := strconv.ParseUint(query.Get("ts"), 10, 32)
	for _, header := range []string{"X-Argus", "X-Ladon"} {
		decoded, err := base64.StdEncoding.DecodeString(r.Header.Get(header))
		if err != nil || len(decoded) != 4 {
			t.Errorf("invalid %s timestamp", header)
			continue
		}
		var value uint32
		if header == "X-Argus" {
			value = binary.LittleEndian.Uint32(decoded)
		} else {
			value = binary.BigEndian.Uint32(decoded)
		}
		if value != uint32(stamp) {
			t.Errorf("%s differs from signed timestamp", header)
		}
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	signature, err := hex.DecodeString(r.Header.Get("X-Gorgon"))
	if err != nil || len(signature) != 26 {
		t.Fatal("invalid playback Gorgon length")
	}
	nonce := binary.LittleEndian.Uint16(signature[2:4])
	if r.Header.Get("X-Gorgon") != passportGorgon(r.URL.RawQuery, body, uint32(stamp), nonce) {
		t.Error("signature does not match the transmitted query and body")
	}
	if r.Header.Get("X-Gorgon") == passportGorgon(r.URL.RawQuery, append(append([]byte(nil), body...), ' '), uint32(stamp), nonce) {
		t.Error("signature ignored POST body bytes")
	}
	hash := md5.Sum(body)
	if r.Header.Get("X-SS-STUB") != strings.ToUpper(hex.EncodeToString(hash[:])) {
		t.Error("body checksum mismatch")
	}
	iv, _, _ := passportBranch(r.URL.RawQuery, body, uint32(stamp))
	if (iv&15)%3 != 2 {
		t.Error("playback selected an unsupported signature branch")
	}
}

func TestMiniReelPlaybackSignedWireAndCompatibilityFallback(t *testing.T) {
	for _, firstSuccess := range []int{1, 2, 3} {
		t.Run(strconv.Itoa(firstSuccess), func(t *testing.T) {
			calls := 0
			var initialBody []byte
			seen := map[string]bool{}
			connections := map[string]bool{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if connections[r.RemoteAddr] {
					t.Error("empty-response retry reused the failed connection")
				}
				connections[r.RemoteAddr] = true
				if calls < 3 {
					assertMiniReelPlaybackSignature(t, r)
					if seen[r.Header.Get("X-Medusa")] {
						t.Error("retry reused a signature")
					}
					seen[r.Header.Get("X-Medusa")] = true
				} else if r.Header.Get("X-Medusa") != "" || r.URL.Query().Get("ts") != "" {
					t.Error("compatibility retry did not restore the original request")
				}
				if r.Close != (calls > 1) {
					t.Error("retry connection policy differs from the first request")
				}
				body, _ := io.ReadAll(r.Body)
				if calls == 1 {
					initialBody = body
				} else if !bytes.Equal(body, initialBody) {
					t.Error("retry changed the requested video or POST bytes")
				}
				if calls == firstSuccess {
					_, _ = io.WriteString(w, miniReelRecoveryModel)
				}
			}))
			defer server.Close()
			options, err := miniReelNativeOptionsEndpointWithDevice(context.Background(), "123", server.URL, miniReelRecoveryDevice("1"))
			if err != nil || len(options) != 1 || calls != firstSuccess {
				t.Fatalf("requests=%d options=%d err=%v", calls, len(options), err)
			}
		})
	}
}

func TestMiniReelPlaybackAttemptHostsAreBounded(t *testing.T) {
	for _, endpoint := range []string{miniReelAPIBase + miniReelAPIPath, "http://127.0.0.1/test"} {
		for attempt := 0; attempt < 3; attempt++ {
			got, signed := miniReelPlaybackAttemptPolicy(endpoint, attempt)
			want := endpoint
			if endpoint == miniReelAPIBase+miniReelAPIPath && attempt == 1 {
				want = "https://api5-normal-hl.fqnovel.com" + miniReelAPIPath
			}
			if got != want || signed != (attempt != 2) {
				t.Errorf("attempt %d: endpoint=%s signed=%t", attempt, got, signed)
			}
		}
	}
}

func TestMiniReelPlaybackProfileDoesNotChangeAccountSignature(t *testing.T) {
	query := "device_id=7000000000000000001&version_name=7.1.3.32"
	ts := uint32(1800000000)
	_, hash, bodyHash := passportBranch(query, []byte("{}"), ts)
	account := passportProto(query, ts, 1, "7000000000000000001", hash, bodyHash, make([]byte, 20))
	playback := passportProtoVersion(query, ts, 1, "7000000000000000001", hash, bodyHash, make([]byte, 20), "7.1.3.32")
	if bytes.Count(playback, []byte("7.1.3.32")) != 2 || bytes.Contains(playback, []byte("7.3.5.32")) {
		t.Fatal("playback envelope has the wrong app version")
	}
	if bytes.Count(account, []byte("7.3.5.32")) != 2 || bytes.Contains(account, []byte("7.1.3.32")) {
		t.Fatal("playback changed the account signer profile")
	}
	params := url.Values{"device_id": {"7000000000000000001"}, "version_name": {"7.1.3.32"}}
	raw, headers, err := miniReelSignPlaybackRequest(params, []byte("{}"), 1800000000999, params.Get("device_id"))
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "https://fixture.test/?"+raw, strings.NewReader("{}"))
	r.Header = headers
	assertMiniReelPlaybackSignature(t, r)
}

func TestMiniReelPlaybackTransportDoesNotLeakSignedURL(t *testing.T) {
	client := &http.Client{Transport: miniReelTestRoundTripper(func(r *http.Request) (*http.Response, error) {
		assertMiniReelPlaybackSignature(t, r)
		return nil, context.DeadlineExceeded
	})}
	_, err := miniReelNativeOptionsAttemptWithClient(context.Background(), "123", "https://fixture.test", miniReelRecoveryDevice("private-device"), client)
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("transport lost timeout classification: %v", err)
	}
	if strings.Contains(err.Error(), "private-device") || strings.Contains(err.Error(), "_rticket") || strings.Contains(err.Error(), "https://") {
		t.Fatal("transport error exposed signed request details")
	}
}
