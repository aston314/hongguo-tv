package jsresolver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

// HTTPTransport is a host capability, not an HTTP stack exposed to JavaScript.
// It never consults an account cookie jar and never follows a redirect.
func HTTPTransport(client *http.Client) Transport {
	if client == nil {
		client = http.DefaultClient
	}
	safe := *client
	safe.Jar = nil
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		if !ValidHTTPURL(in.URL) {
			return resolverwire.HTTPResponse{}, errors.New("resolver URL rejected")
		}
		req, e := http.NewRequestWithContext(ctx, in.Method, in.URL, bytes.NewReader(in.Body))
		if e != nil {
			return resolverwire.HTTPResponse{}, errors.New("invalid resolver HTTP request")
		}
		for k, v := range in.Headers {
			req.Header.Set(k, v)
		}
		res, e := safe.Do(req)
		if e != nil {
			return resolverwire.HTTPResponse{}, errors.New("resolver HTTP transport failed")
		}
		defer res.Body.Close()
		body, e := io.ReadAll(io.LimitReader(res.Body, resolverwire.MaxHTTPBody+1))
		if e != nil || len(body) > resolverwire.MaxHTTPBody {
			return resolverwire.HTTPResponse{}, errors.New("resolver HTTP response rejected")
		}
		cookies := map[string]string{}
		if req.URL.Path == "/service/2/device_register/" {
			for _, c := range res.Cookies() {
				if allowedPlaybackCookie(c.Name) && c.MaxAge >= 0 && len(c.Value) <= 1024 {
					cookies[c.Name] = c.Value
				}
			}
		}
		return resolverwire.HTTPResponse{Status: res.StatusCode, Body: body, Cookies: cookies, RetryAfter: res.Header.Get("Retry-After") != "", Location: res.Header.Get("Location")}, nil
	}
}
