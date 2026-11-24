// Package resolverwire is the dependency-free contract between resolver and host.
package resolverwire

const (
	MaxRequest  = 16 * 1024
	MaxResult   = 256 * 1024
	MaxHTTPBody = 5 * 1024 * 1024
)

type Request struct {
	VID         string `json:"vid"`
	CodecMode   string `json:"codec_mode"`
	ContentType string `json:"content_type"`
}
type Option struct {
	URL           string
	Key           []byte
	Codec         string
	Width, Height int
	Quality       string
	Duration      int
}
type Response struct {
	Options    []Option `json:"options"`
	ErrorCode  string   `json:"error_code,omitempty"`
	ErrorStage string   `json:"error_stage,omitempty"`
}
type HTTPRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}
type HTTPResponse struct {
	Status     int               `json:"status"`
	Body       []byte            `json:"body,omitempty"`
	Cookies    map[string]string `json:"cookies,omitempty"`
	RetryAfter bool              `json:"retry_after,omitempty"`
	Location   string            `json:"location,omitempty"`
}

// Header only implements the map operations used by the pure signer.
type Header map[string][]string

func (h Header) Set(key, value string) { h[key] = []string{value} }
func (h Header) Get(key string) string {
	if values := h[key]; len(values) > 0 {
		return values[0]
	}
	return ""
}
func (h Header) Del(key string) { delete(h, key) }
