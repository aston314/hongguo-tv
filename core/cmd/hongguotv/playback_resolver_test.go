package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestEmbeddedPlaybackResolverMetadata(t *testing.T) {
	resolver := (&embeddedPlaybackResolver{source: &miniReelMobileV5Source{}}).Metadata()
	want := playbackResolverMetadata{
		Name:     builtInPlaybackResolverName,
		Version:  builtInPlaybackResolverVersion,
		Protocol: builtInPlaybackResolverProtocol,
	}
	if !reflect.DeepEqual(resolver, want) {
		t.Fatalf("metadata=%#v want=%#v", resolver, want)
	}
	production := miniReelProductionSources().resolver()
	if production == nil {
		t.Fatal("production resolver is nil")
	}
	if got := production.Metadata(); !reflect.DeepEqual(got, want) {
		t.Fatalf("production metadata=%#v want=%#v", got, want)
	}
}

func TestEmbeddedPlaybackResolverMatchesMobileV5(t *testing.T) {
	registered := 0
	client := &http.Client{Transport: miniReelTestRoundTripper(func(*http.Request) (*http.Response, error) {
		data, err := json.Marshal(map[string]any{
			"code": 0,
			"data": map[string]any{"123": map[string]any{"video_model": codecFallbackModel("h265", "123", 90)}},
		})
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}, nil
	})}
	source := mobileV5Fixture(client, &registered)
	resolver := &embeddedPlaybackResolver{source: source}
	want, err := source.options(context.Background(), "123", "default", "1004")
	if err != nil {
		t.Fatal(err)
	}
	got, err := resolver.Resolve(context.Background(), playbackResolverRequest{VID: "123", CodecMode: "default", ContentType: "1004"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resolver options=%#v legacy options=%#v", got, want)
	}
}

func TestPlaybackResolverOverridePrecedesLegacySource(t *testing.T) {
	override := &stubPlaybackResolver{
		metadata: playbackResolverMetadata{Name: "test", Version: "1.2.3", Protocol: 1},
		options:  []miniReelOption{{URL: "https://media.example.test/episode.mp4", Codec: "h265", Width: 1920, Height: 1080}},
	}
	sources := miniReelPlaybackSources{
		resolverOverride: override,
		mobileV5:         &miniReelMobileV5Source{},
	}
	if got := sources.resolver(); got != override {
		t.Fatalf("resolver=%T want explicit override", got)
	}
	if got := (miniReelPlaybackSources{mobileV5: &miniReelMobileV5Source{}}).resolver(); got == nil || got.Metadata().Name != builtInPlaybackResolverName {
		t.Fatalf("legacy source was not wrapped by embedded resolver: %#v", got)
	}
	options, err := miniReelNativeOptionsWithSources(context.Background(), "123", "default", "1004", sources)
	if err != nil || !reflect.DeepEqual(options, override.options) {
		t.Fatalf("resolver options=%#v error=%v", options, err)
	}
	if len(override.requests) != 1 || override.requests[0].VID != "123" || override.requests[0].ContentType != "1004" {
		t.Fatalf("resolver request=%#v", override.requests)
	}
}

func TestParsePlaybackResolverPublicKey(t *testing.T) {
	key := make([]byte, ed25519.PublicKeySize)
	for i := range key {
		key[i] = byte(i + 1)
	}
	for _, raw := range []string{
		base64.StdEncoding.EncodeToString(key),
		hex.EncodeToString(key),
		"  " + base64.StdEncoding.EncodeToString(key) + "  ",
	} {
		got, err := parsePlaybackResolverPublicKey(raw)
		if err != nil || !reflect.DeepEqual([]byte(got), key) {
			t.Fatalf("parse key %q: got %x err=%v", raw, got, err)
		}
	}
	for _, raw := range []string{"not-a-key", strings.Repeat("00", 31), strings.Repeat("0", 66)} {
		if got, err := parsePlaybackResolverPublicKey(raw); err == nil {
			t.Fatalf("invalid key accepted: %q -> %x", raw, got)
		}
	}
}

type stubPlaybackResolver struct {
	metadata playbackResolverMetadata
	options  []miniReelOption
	requests []playbackResolverRequest
	err      error
}

func (s *stubPlaybackResolver) Resolve(_ context.Context, request playbackResolverRequest) ([]miniReelOption, error) {
	s.requests = append(s.requests, request)
	if s.err != nil {
		return nil, s.err
	}
	return append([]miniReelOption(nil), s.options...), nil
}

func (s *stubPlaybackResolver) Metadata() playbackResolverMetadata { return s.metadata }
