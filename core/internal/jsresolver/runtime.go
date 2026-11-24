// Package jsresolver runs anonymous playback algorithms in a local JS runtime.
// The script receives byte primitives and bounded HTTP, never native signing,
// device registration, a filesystem, account state or a native resolver fallback.
package jsresolver

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
	"github.com/dop251/goja"
	"github.com/dop251/goja/parser"
	"github.com/dop251/goja_nodejs/buffer"
	"github.com/dop251/goja_nodejs/require"
)

//go:embed resolver.js
var source []byte

func Source() []byte { return bytes.Clone(source) }

const MaxScript = 1024 * 1024
const Version = "2026.11.24.1"

var ErrRequest = errors.New("invalid resolver request")

type Transport func(context.Context, resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error)
type Error struct{ Code, Stage string }

func (e *Error) Error() string { return e.Code + " at " + e.Stage }

type Resolver struct {
	vm       *goja.Runtime
	api      *goja.Object
	gate     chan struct{}
	ctx      context.Context
	do       Transport
	requests int
	closed   bool
}

func New(ctx context.Context, script []byte, transport Transport) (*Resolver, error) {
	if len(script) == 0 || len(script) > MaxScript || transport == nil {
		return nil, errors.New("invalid JS resolver input")
	}
	vm := goja.New()
	vm.SetMaxCallStackSize(256)
	vm.SetParserOptions(parser.WithDisableSourceMaps)
	r := &Resolver{vm: vm, gate: make(chan struct{}, 1), do: transport}
	r.gate <- struct{}{}
	// Buffer only; all filesystem/module resolution is disabled, even on failure.
	registry := require.NewRegistry(require.WithLoader(func(string) ([]byte, error) { return nil, require.ModuleFileDoesNotExistError }))
	registry.Enable(vm)
	buffer.Enable(vm)
	vm.Set("require", goja.Undefined())
	host := vm.NewObject()
	host.Set("hash", r.hash)
	host.Set("cipher", r.cipher)
	host.Set("random", r.random)
	host.Set("gzip", r.gzip)
	host.Set("gunzip", r.gunzip)
	host.Set("http", r.http)
	vm.Set("__resolverHost", host)
	err := r.run(ctx, func() error {
		v, e := vm.RunScript("resolver.js", string(script))
		if e != nil {
			return e
		}
		if goja.IsUndefined(v) || goja.IsNull(v) {
			return errors.New("missing JS resolver API")
		}
		r.api = v.ToObject(vm)
		if _, ok := goja.AssertFunction(r.api.Get("resolve")); !ok {
			return errors.New("missing JS resolver entry")
		}
		return nil
	})
	if err != nil {
		return nil, errors.New("JS resolver load failed")
	}
	return r, nil
}

func (r *Resolver) run(ctx context.Context, fn func() error) (err error) {
	// Object getters and value conversion can throw outside a JS function call.
	// Keep exceptions inside the resolver boundary and redact source/URLs.
	defer func() {
		if recover() != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
			} else {
				err = errors.New("JS resolver host boundary failed")
			}
		}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-r.gate:
	}
	defer func() { r.gate <- struct{}{} }()
	if r.closed {
		return errors.New("JS resolver closed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	r.ctx = ctx
	r.requests = 0
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { r.vm.Interrupt("resolver cancelled"); close(done) })
	defer func() {
		if !stop() {
			<-done
		}
		r.vm.ClearInterrupt()
		r.ctx = nil
	}()
	err = fn()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func (r *Resolver) Resolve(ctx context.Context, request resolverwire.Request) ([]resolverwire.Option, error) {
	input, e := json.Marshal(request)
	if e != nil || len(input) > resolverwire.MaxRequest {
		return nil, ErrRequest
	}
	var result resolverwire.Response
	e = r.run(ctx, func() error {
		f, ok := goja.AssertFunction(r.api.Get("resolve"))
		if !ok {
			return errors.New("missing resolver entry")
		}
		v, err := f(r.api, r.vm.ToValue(string(input)))
		if err != nil {
			return errors.New("JS resolver execution failed")
		}
		if promise, ok := v.Export().(*goja.Promise); ok {
			if promise.State() != goja.PromiseStateFulfilled {
				return errors.New("unfinished JS resolver job")
			}
			v = promise.Result()
		}
		text := v.String()
		if len(text) > resolverwire.MaxResult || json.Unmarshal([]byte(text), &result) != nil {
			return errors.New("invalid JS resolver result")
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	if result.ErrorCode != "" {
		if !regexp.MustCompile(`^[A-Z0-9_]{1,64}$`).MatchString(result.ErrorCode) || !regexp.MustCompile(`^[a-z_]{1,40}$`).MatchString(result.ErrorStage) {
			return nil, errors.New("invalid JS resolver error")
		}
		return nil, &Error{result.ErrorCode, result.ErrorStage}
	}
	if len(result.Options) == 0 || len(result.Options) > 32 {
		return nil, errors.New("invalid JS resolver options")
	}
	for _, o := range result.Options {
		u, err := url.Parse(o.URL)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || len(o.URL) > 8192 || len(o.Key) > 128 || o.Width < 0 || o.Height < 0 || o.Duration < 0 || o.Quality == "" || o.Codec == "" {
			return nil, errors.New("invalid JS media option")
		}
	}
	return result.Options, nil
}

type Metadata struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Protocol  int    `json:"protocol"`
	NativeSM3 bool   `json:"native_sm3"`
}

func (r *Resolver) Metadata(ctx context.Context) (Metadata, error) {
	var m Metadata
	e := r.run(ctx, func() error {
		f, ok := goja.AssertFunction(r.api.Get("metadata"))
		if !ok {
			return errors.New("missing JS metadata")
		}
		v, e := f(r.api)
		if e != nil {
			return errors.New("invalid JS metadata")
		}
		b, e := json.Marshal(v.Export())
		if e != nil {
			return e
		}
		return json.Unmarshal(b, &m)
	})
	return m, e
}

func (r *Resolver) SelfTest(ctx context.Context, vectors []byte) (uint32, error) {
	var n uint32
	e := r.run(ctx, func() error {
		f, ok := goja.AssertFunction(r.api.Get("selfTest"))
		if !ok {
			return errors.New("missing self-test")
		}
		v, e := f(r.api, r.vm.ToValue(string(vectors)))
		if e != nil {
			return errors.New("JS signing vectors failed")
		}
		n = uint32(v.ToInteger())
		return nil
	})
	return n, e
}
func (r *Resolver) Close(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-r.gate:
	}
	r.closed = true
	r.api = nil
	r.vm = nil
	r.gate <- struct{}{}
	return nil
}
func (r *Resolver) check() {
	if r.ctx == nil || r.ctx.Err() != nil {
		panic(r.vm.NewTypeError("resolver cancelled"))
	}
}
func (r *Resolver) blob(v goja.Value) []byte {
	r.check()
	b := buffer.DecodeBytes(r.vm, v, goja.Undefined())
	if len(b) > resolverwire.MaxHTTPBody {
		panic(r.vm.NewTypeError("byte input too large"))
	}
	return b
}
func (r *Resolver) wrap(b []byte) goja.Value {
	if len(b) > resolverwire.MaxHTTPBody {
		panic(r.vm.NewTypeError("byte result too large"))
	}
	return buffer.WrapBytes(r.vm, b)
}
func (r *Resolver) hash(call goja.FunctionCall) goja.Value {
	b := r.blob(call.Argument(1))
	var out []byte
	switch call.Argument(0).String() {
	case "sm3":
		v := sumSM3(b)
		out = v[:]
	case "md5":
		v := md5.Sum(b)
		out = v[:]
	case "sha256":
		v := sha256.Sum256(b)
		out = v[:]
	case "sha512":
		v := sha512.Sum512(b)
		out = v[:]
	default:
		panic(r.vm.NewTypeError("hash unavailable"))
	}
	return r.wrap(out)
}
func (r *Resolver) random(call goja.FunctionCall) goja.Value {
	r.check()
	n := call.Argument(0).ToInteger()
	if n < 0 || n > 4096 {
		panic(r.vm.NewTypeError("random size rejected"))
	}
	b := make([]byte, int(n))
	if _, e := rand.Read(b); e != nil {
		panic(r.vm.NewTypeError("entropy unavailable"))
	}
	return r.wrap(b)
}
func (r *Resolver) gzip(call goja.FunctionCall) goja.Value {
	b := r.blob(call.Argument(0))
	var out bytes.Buffer
	w, e := gzip.NewWriterLevel(&out, int(call.Argument(1).ToInteger()))
	if e != nil {
		panic(r.vm.NewTypeError("gzip level rejected"))
	}
	if _, e = w.Write(b); e == nil {
		e = w.Close()
	}
	if e != nil {
		panic(r.vm.NewTypeError("gzip failed"))
	}
	return r.wrap(out.Bytes())
}
func (r *Resolver) gunzip(call goja.FunctionCall) goja.Value {
	w, e := gzip.NewReader(bytes.NewReader(r.blob(call.Argument(0))))
	if e != nil {
		panic(r.vm.NewTypeError("invalid gzip"))
	}
	defer w.Close()
	b, e := io.ReadAll(io.LimitReader(w, resolverwire.MaxHTTPBody+1))
	if e != nil {
		panic(r.vm.NewTypeError("invalid gzip"))
	}
	return r.wrap(b)
}
func (r *Resolver) cipher(call goja.FunctionCall) goja.Value {
	name := call.Argument(0).String()
	key, iv, data := r.blob(call.Argument(1)), r.blob(call.Argument(2)), r.blob(call.Argument(3))
	decrypt, padding := call.Argument(4).ToBoolean(), call.Argument(5).ToBoolean()
	if len(key) != 16 || len(iv) != aes.BlockSize {
		panic(r.vm.NewTypeError("invalid AES parameters"))
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		panic(r.vm.NewTypeError("invalid AES key"))
	}
	if name == "aes-128-ctr" {
		out := make([]byte, len(data))
		cipher.NewCTR(block, iv).XORKeyStream(out, data)
		return r.wrap(out)
	}
	if name != "aes-128-cbc" {
		panic(r.vm.NewTypeError("cipher unavailable"))
	}
	if !decrypt && padding {
		n := aes.BlockSize - len(data)%aes.BlockSize
		data = append(bytes.Clone(data), bytes.Repeat([]byte{byte(n)}, n)...)
	}
	if len(data)%aes.BlockSize != 0 {
		panic(r.vm.NewTypeError("invalid AES block length"))
	}
	out := make([]byte, len(data))
	if decrypt {
		cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, data)
		if padding {
			if len(out) == 0 {
				panic(r.vm.NewTypeError("invalid AES padding"))
			}
			n := int(out[len(out)-1])
			if n < 1 || n > 16 || n > len(out) || !bytes.Equal(out[len(out)-n:], bytes.Repeat([]byte{byte(n)}, n)) {
				panic(r.vm.NewTypeError("invalid AES padding"))
			}
			out = out[:len(out)-n]
		}
	} else {
		cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, data)
	}
	return r.wrap(out)
}

func ValidHTTPURL(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" || u.Fragment != "" || u.Port() != "" && u.Port() != "443" {
		return false
	}
	h := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	return h == "fqnovel.com" || strings.HasSuffix(h, ".fqnovel.com") || h == "snssdk.com" || strings.HasSuffix(h, ".snssdk.com")
}
func (r *Resolver) http(call goja.FunctionCall) goja.Value {
	r.check()
	r.requests++
	method, raw := call.Argument(0).String(), call.Argument(1).String()
	var headers map[string]string
	if r.requests > 24 || (method != "GET" && method != "POST") || !ValidHTTPURL(raw) || r.vm.ExportTo(call.Argument(2), &headers) != nil || len(headers) > 32 {
		panic(r.vm.NewTypeError("HTTP request rejected"))
	}
	for k, v := range headers {
		key := strings.ToLower(strings.TrimSpace(k))
		if key == "set-cookie" || key == "authorization" || len(v) > 4096 || strings.ContainsAny(k+v, "\r\n") {
			panic(r.vm.NewTypeError("HTTP header rejected"))
		}
		if key == "cookie" && (!validPlaybackCookieHeader(v) || !strings.HasSuffix(strings.Split(raw, "?")[0], "/v1/")) {
			panic(r.vm.NewTypeError("HTTP cookie rejected"))
		}
	}
	body := r.blob(call.Argument(3))
	if len(body) > resolverwire.MaxRequest {
		panic(r.vm.NewTypeError("HTTP body too large"))
	}
	timeout := 8 * time.Second
	if len(call.Arguments) > 4 {
		n := call.Argument(4).ToInteger()
		if n < 1 || n > 8000 {
			panic(r.vm.NewTypeError("HTTP timeout rejected"))
		}
		timeout = time.Duration(n) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(r.ctx, timeout)
	defer cancel()
	response, e := r.do(ctx, resolverwire.HTTPRequest{Method: method, URL: raw, Headers: headers, Body: body})
	if e != nil {
		panic(r.vm.NewTypeError("HTTP transport failed"))
	}
	if len(response.Body) > resolverwire.MaxHTTPBody {
		panic(r.vm.NewTypeError("HTTP response too large"))
	}
	result := r.vm.NewObject()
	result.Set("status", response.Status)
	result.Set("body", r.wrap(response.Body))
	safe := map[string]string{}
	for name, value := range response.Cookies {
		if allowedPlaybackCookie(name) && len(value) <= 1024 {
			safe[name] = value
		}
	}
	result.Set("cookies", safe)
	result.Set("retry_after", response.RetryAfter)
	if len(response.Location) <= 8192 {
		result.Set("location", response.Location)
	}
	return result
}

func allowedPlaybackCookie(name string) bool {
	switch name {
	case "install_id", "ttreq", "store-region", "store-region-src":
		return true
	}
	return false
}
func validPlaybackCookieHeader(value string) bool {
	if len(value) > 4096 || strings.TrimSpace(value) == "" {
		return false
	}
	for _, part := range strings.Split(value, ";") {
		bits := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(bits) != 2 || !allowedPlaybackCookie(bits[0]) || strings.TrimSpace(bits[1]) == "" || strings.ContainsAny(bits[1], "\r\n;") {
			return false
		}
	}
	return true
}
