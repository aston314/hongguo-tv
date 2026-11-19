//go:build resolverjsprobe || resolverjstest

package main

import (
	"context"
	"errors"
	"net/http"
	"os"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

type jsPlaybackResolver struct {
	script   *jsresolver.Resolver
	metadata playbackResolverMetadata
}

func loadJSPlaybackResolver(ctx context.Context, m playbackResolverManifest, artifact string, client *http.Client) (playbackResolver, error) {
	b, e := os.ReadFile(artifact)
	if e != nil {
		return nil, e
	}
	return newJSPlaybackResolver(ctx, m, b, client)
}
func newJSPlaybackResolver(ctx context.Context, m playbackResolverManifest, b []byte, client *http.Client) (playbackResolver, error) {
	s, e := jsresolver.New(ctx, b, jsresolver.HTTPTransport(client))
	if e != nil {
		return nil, e
	}
	metadata, e := s.Metadata(ctx)
	if e != nil || metadata.Name != "js-v5" || metadata.Version != m.Version || metadata.Protocol != m.Protocol {
		s.Close(context.Background())
		return nil, errors.New("JS resolver metadata mismatch")
	}
	return &jsPlaybackResolver{s, playbackResolverMetadata{Name: metadata.Name, Version: metadata.Version, Protocol: metadata.Protocol}}, nil
}
func (r *jsPlaybackResolver) Metadata() playbackResolverMetadata { return r.metadata }
func (r *jsPlaybackResolver) Close(ctx context.Context) error    { return r.script.Close(ctx) }
func (r *jsPlaybackResolver) Resolve(ctx context.Context, in playbackResolverRequest) ([]miniReelOption, error) {
	options, e := r.script.Resolve(ctx, resolverwire.Request{VID: in.VID, CodecMode: in.CodecMode, ContentType: in.ContentType})
	if e != nil {
		var detail *jsresolver.Error
		if errors.As(e, &detail) {
			return nil, &playbackPreparationError{cause: errors.New("JS resolver failed"), diagnostic: playbackPreparationDiagnostic{Code: detail.Code, Stage: detail.Stage}}
		}
		return nil, e
	}
	out := make([]miniReelOption, len(options))
	for i, o := range options {
		out[i] = miniReelOption(o)
	}
	if e := validatePlaybackResolverWASMOptions(out); e != nil {
		return nil, e
	}
	return out, nil
}
