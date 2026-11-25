package jsupdate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var Proxies = []string{"https://gh-proxy.com/", "https://v4.gh-proxy.org/", "https://gh-proxy.org/", "https://ghfast.top/"}

const ChannelRoot = "https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/resolver-js/"
const ManifestURL = ChannelRoot + "manifest.json"
const ProfileRoot = "https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/resolver-profile/"
const ProfileManifestURL = ProfileRoot + "manifest.json"

func ProfileURL(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Host != "raw.githubusercontent.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" {
		return false
	}
	if raw == ProfileManifestURL {
		return true
	}
	name := strings.TrimPrefix(raw, ProfileRoot+"profiles/")
	return strings.HasPrefix(raw, ProfileRoot+"profiles/") && strings.HasSuffix(name, ".json") && digestRE.MatchString(strings.TrimSuffix(name, ".json"))
}

// Only this dedicated path is eligible; a signed artifact cannot redirect downloads
// to an account endpoint, arbitrary host or an older product's update channel.
func OfficialURL(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && u.Host == "raw.githubusercontent.com" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && u.RawPath == "" && strings.HasPrefix(u.Path, "/aston314/hongguo-tv-releases/main/resolver-js/") && !strings.Contains(u.Path, "..")
}
func Routes(raw string) []string {
	out := make([]string, 0, len(Proxies)+1)
	for _, p := range Proxies {
		out = append(out, p+raw)
	}
	return append(out, raw)
}

// fetch validates each response before moving on, so a proxy's HTTP-200 HTML,
// invalid signature or truncated file cannot block the other routes. No cookie
// jar, Authorization, referrer, or redirects are used on any route.
func (m *Manager) fetch(ctx context.Context, raw string, limit int, accept func([]byte) error) ([]byte, error) {
	if !m.cfg.AllowedURL(raw) {
		return nil, errors.New("update_url_rejected")
	}
	client := *m.cfg.Client
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for _, route := range m.cfg.Routes(raw) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		attempt, cancel := context.WithTimeout(ctx, m.cfg.RouteTimeout)
		req, e := http.NewRequestWithContext(attempt, "GET", route, nil)
		var data []byte
		if e == nil {
			req.Header.Set("Accept", "application/octet-stream")
			req.Header.Set("Cache-Control", "no-cache")
			res, err := client.Do(req)
			if err == nil {
				if res.StatusCode == 200 && res.ContentLength <= int64(limit) {
					data, e = io.ReadAll(io.LimitReader(res.Body, int64(limit)+1))
					if e == nil && len(data) <= limit {
						e = accept(data)
					} else {
						e = errors.New("download_size_or_read_rejected")
					}
				} else {
					e = errors.New("download_status_or_size_rejected")
				}
				res.Body.Close()
			} else {
				e = err
			}
		}
		cancel()
		if e == nil {
			return data, nil
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, errors.New("all_update_routes_failed")
}
func defaultClient() *http.Client { return &http.Client{Timeout: 8 * time.Second} }
