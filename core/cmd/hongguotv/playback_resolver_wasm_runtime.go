package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/aston314/hongguo-tv/core/internal/resolverwire"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

const (
	playbackResolverWASMName       = "wasm-v1"
	playbackResolverWASMMaxRequest = resolverwire.MaxRequest
	playbackResolverWASMMaxResult  = resolverwire.MaxResult
	playbackResolverWASMMaxOptions = 32
	playbackResolverWASMMaxKey     = 128

	playbackResolverWASMAlloc       = "resolver_alloc"
	playbackResolverWASMResolve     = "resolver_resolve"
	playbackResolverWASMFree        = "resolver_free"
	playbackResolverWASMHostModule  = "hongguo_resolver_host"
	playbackResolverWASMHTTP        = "resolver_http"
	playbackResolverWASMMaxHTTPBody = resolverwire.MaxHTTPBody
)

var (
	errPlaybackResolverWASMInvalid = errors.New("invalid playback resolver wasm result")
	errPlaybackResolverWASMABI     = errors.New("unsupported playback resolver wasm ABI")
)

// playbackResolverWASMRequest and playbackResolverWASMResponse are the only
// structured data crossing the guest boundary. The guest never receives
// account cookies or authorization headers. A production module may opt into
// the separately validated fqnovel/snssdk HTTP callback below; the no-import fixture
// remains the default and has no network capability.
type playbackResolverWASMRequest = resolverwire.Request

type playbackResolverWASMResponse struct {
	Options    []miniReelOption `json:"options"`
	ErrorCode  string           `json:"error_code,omitempty"`
	ErrorStage string           `json:"error_stage,omitempty"`
}

type playbackResolverWASMHTTPResponse = resolverwire.HTTPResponse
type playbackResolverWASMHTTPRequest = resolverwire.HTTPRequest

type wasmPlaybackResolver struct {
	mu       sync.Mutex
	runtime  wazero.Runtime
	module   api.Module
	alloc    api.Function
	resolve  api.Function
	free     api.Function
	metadata playbackResolverMetadata
}

// loadWASMPlaybackResolver loads a module without upstream HTTP capability.
// Algorithm modules use the separately validated HTTP loader below. The caller owns the artifact's signature/digest
// checks and activation rollback.
func loadWASMPlaybackResolver(ctx context.Context, manifest playbackResolverManifest, artifact string) (playbackResolver, error) {
	return loadWASMPlaybackResolverWithHTTP(ctx, manifest, artifact, nil)
}

func newWASMPlaybackResolverLoader(client *http.Client) playbackResolverRuntimeLoader {
	return func(ctx context.Context, manifest playbackResolverManifest, artifact string) (playbackResolver, error) {
		return loadWASMPlaybackResolverWithHTTP(ctx, manifest, artifact, client)
	}
}

func loadWASMPlaybackResolverWithHTTP(ctx context.Context, manifest playbackResolverManifest, artifact string, client *http.Client) (playbackResolver, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(artifact)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, errors.New("empty playback resolver wasm")
	}
	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigInterpreter().WithMemoryLimitPages(4096).WithCloseOnContextDone(true))
	compiled, err := rt.CompileModule(ctx, b)
	if err != nil {
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("compile resolver wasm: %w", err)
	}
	imports := compiled.ImportedFunctions()
	needsHTTP, needsWASI := false, false
	for _, function := range imports {
		module, _, _ := function.Import()
		if validWASMHTTPImport(function) {
			needsHTTP = true
			continue
		}
		if module == wasi_snapshot_preview1.ModuleName {
			needsWASI = true
			continue
		}
		_ = rt.Close(ctx)
		return nil, errPlaybackResolverWASMABI
	}
	if needsWASI {
		// No filesystem mounts, environment, argv, stdin, stdout or sockets.
		// Go's reactor needs clocks and fresh entropy for the real signer.
		if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
			_ = rt.Close(ctx)
			return nil, err
		}
	}
	if needsHTTP {
		if client == nil {
			_ = compiled.Close(ctx)
			_ = rt.Close(ctx)
			return nil, errPlaybackResolverWASMABI
		}
		_, err = rt.NewHostModuleBuilder(playbackResolverWASMHostModule).
			NewFunctionBuilder().WithFunc(newWASMHTTPHost(client)).Export(playbackResolverWASMHTTP).
			Instantiate(ctx)
		if err != nil {
			_ = compiled.Close(ctx)
			_ = rt.Close(ctx)
			return nil, fmt.Errorf("instantiate resolver host: %w", err)
		}
	}
	config := wazero.NewModuleConfig().WithName("hongguo-playback-resolver").WithSysWalltime().WithSysNanotime().WithRandSource(rand.Reader)
	if needsWASI {
		config = config.WithStartFunctions("_initialize")
	}
	module, err := rt.InstantiateModule(ctx, compiled, config)
	if err != nil {
		_ = compiled.Close(ctx)
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("instantiate resolver wasm: %w", err)
	}
	alloc := module.ExportedFunction(playbackResolverWASMAlloc)
	resolve := module.ExportedFunction(playbackResolverWASMResolve)
	free := module.ExportedFunction(playbackResolverWASMFree)
	if alloc == nil || resolve == nil || free == nil || module.Memory() == nil {
		_ = module.Close(ctx)
		_ = compiled.Close(ctx)
		_ = rt.Close(ctx)
		return nil, errPlaybackResolverWASMABI
	}
	return &wasmPlaybackResolver{
		runtime:  rt,
		module:   module,
		alloc:    alloc,
		resolve:  resolve,
		free:     free,
		metadata: playbackResolverMetadata{Name: playbackResolverWASMName, Version: manifest.Version, Protocol: manifest.Protocol},
	}, nil
}

func validWASMHTTPImport(function api.FunctionDefinition) bool {
	module, name, imported := function.Import()
	if !imported || module != playbackResolverWASMHostModule || name != playbackResolverWASMHTTP {
		return false
	}
	parameters := function.ParamTypes()
	results := function.ResultTypes()
	if len(parameters) != 4 || len(results) != 1 || results[0] != api.ValueTypeI32 {
		return false
	}
	for _, parameter := range parameters {
		if parameter != api.ValueTypeI32 {
			return false
		}
	}
	return true
}

func newWASMHTTPHost(client *http.Client) func(context.Context, api.Module, uint32, uint32, uint32, uint32) uint32 {
	return func(ctx context.Context, module api.Module, requestPtr, requestLen, outputPtr, outputCap uint32) uint32 {
		if requestLen == 0 || requestLen > playbackResolverWASMMaxRequest || outputCap == 0 || outputCap > playbackResolverWASMMaxHTTPBody {
			return 0
		}
		requestBytes, ok := module.Memory().Read(requestPtr, requestLen)
		if !ok {
			return 0
		}
		var input playbackResolverWASMHTTPRequest
		if json.Unmarshal(requestBytes, &input) != nil || !validWASMHTTPURL(input.URL) {
			return 0
		}
		method := input.Method
		if method == "" {
			method = http.MethodGet
		}
		if method != http.MethodGet && method != http.MethodPost {
			return 0
		}
		if len(input.Body) > playbackResolverWASMMaxRequest || !validWASMHTTPHeaders(input.Headers) {
			return 0
		}
		req, err := http.NewRequestWithContext(ctx, method, input.URL, bytes.NewReader(input.Body))
		if err != nil {
			return 0
		}
		for key, value := range input.Headers {
			req.Header.Set(key, value)
		}
		requestClient := resolverHTTPClient(client)
		// Validate every hop, including Location, rather than only the first URL.
		requestClient.CheckRedirect = func(next *http.Request, via []*http.Request) error {
			if len(via) >= 5 || !validWASMHTTPURL(next.URL.String()) {
				return errors.New("unsafe resolver redirect")
			}
			return nil
		}
		response, err := requestClient.Do(req)
		if err != nil {
			return 0
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, playbackResolverWASMMaxHTTPBody+1))
		response.Body.Close()
		if readErr != nil || len(body) > playbackResolverWASMMaxHTTPBody {
			return 0
		}
		encoded, err := json.Marshal(playbackResolverWASMHTTPResponse{Status: response.StatusCode, Body: body})
		if err != nil || uint32(len(encoded)) > outputCap || !module.Memory().Write(outputPtr, encoded) {
			return 0
		}
		return uint32(len(encoded))
	}
}

func validWASMHTTPURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" || u.Fragment != "" || u.Port() != "" && u.Port() != "443" {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	return host == "fqnovel.com" || strings.HasSuffix(host, ".fqnovel.com") ||
		host == "snssdk.com" || strings.HasSuffix(host, ".snssdk.com")
}

func validWASMHTTPHeaders(headers map[string]string) bool {
	if len(headers) > 32 {
		return false
	}
	for key, value := range headers {
		lower := strings.ToLower(strings.TrimSpace(key))
		if lower == "authorization" || lower == "cookie" || lower == "set-cookie" || len(value) > 4096 {
			return false
		}
	}
	return true
}

func (r *wasmPlaybackResolver) Metadata() playbackResolverMetadata {
	if r == nil {
		return playbackResolverMetadata{}
	}
	return r.metadata
}

func (r *wasmPlaybackResolver) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.module != nil {
		_ = r.module.Close(ctx)
		r.module = nil
	}
	if r.runtime != nil {
		return r.runtime.Close(ctx)
	}
	return nil
}

func (r *wasmPlaybackResolver) Resolve(ctx context.Context, request playbackResolverRequest) ([]miniReelOption, error) {
	if r == nil {
		return nil, errPlaybackResolverWASMABI
	}
	input, err := json.Marshal(playbackResolverWASMRequest{VID: request.VID, CodecMode: request.CodecMode, ContentType: request.ContentType})
	if err != nil || len(input) > playbackResolverWASMMaxRequest {
		return nil, errPlaybackResolverWASMInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// A module instance owns one linear memory. Serialize calls so a resolver
	// cannot observe another episode's request or overwrite its output.
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.module == nil {
		return nil, errPlaybackResolverWASMABI
	}
	allocated, err := r.alloc.Call(ctx, uint64(len(input)))
	if err != nil || len(allocated) != 1 || allocated[0] > uint64(^uint32(0)) {
		return nil, fmt.Errorf("resolver alloc: %w", wasmCallError(err, errPlaybackResolverWASMInvalid))
	}
	ptr := uint32(allocated[0])
	if ptr == 0 || !r.module.Memory().Write(ptr, input) {
		return nil, errPlaybackResolverWASMInvalid
	}
	result, callErr := r.resolve.Call(ctx, uint64(ptr), uint64(len(input)))
	// The guest owns its input and output buffers. Free is best effort because
	// a trapped module may have already invalidated its allocator state.
	_, _ = r.free.Call(ctx, uint64(ptr), uint64(len(input)))
	if callErr != nil || len(result) != 1 {
		return nil, fmt.Errorf("resolver call: %w", wasmCallError(callErr, errPlaybackResolverWASMInvalid))
	}
	resultPtr, resultLen := uint32(result[0]>>32), uint32(result[0])
	if resultPtr == 0 || resultLen == 0 || resultLen > playbackResolverWASMMaxResult {
		return nil, errPlaybackResolverWASMInvalid
	}
	output, ok := r.module.Memory().Read(resultPtr, resultLen)
	if !ok {
		return nil, errPlaybackResolverWASMInvalid
	}
	output = append([]byte(nil), output...)
	_, _ = r.free.Call(ctx, uint64(resultPtr), uint64(resultLen))
	var response playbackResolverWASMResponse
	decoder := json.NewDecoder(bytes.NewReader(output))
	if err := decoder.Decode(&response); err != nil {
		return nil, fmt.Errorf("resolver response JSON: %w", err)
	}
	if response.ErrorCode != "" {
		return nil, &playbackPreparationError{cause: errors.New("wasm resolver failed"), diagnostic: playbackPreparationDiagnostic{Code: response.ErrorCode, Stage: response.ErrorStage}}
	}
	if err := validatePlaybackResolverWASMOptions(response.Options); err != nil {
		return nil, err
	}
	return response.Options, nil
}

func validatePlaybackResolverWASMOptions(options []miniReelOption) error {
	if len(options) == 0 || len(options) > playbackResolverWASMMaxOptions {
		return errPlaybackResolverWASMInvalid
	}
	for i := range options {
		option := &options[i]
		u, err := url.Parse(option.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return errPlaybackResolverWASMInvalid
		}
		if len(option.Key) > playbackResolverWASMMaxKey || option.Width < 0 || option.Height < 0 || option.Duration < 0 || option.Quality == "" || option.Codec == "" {
			return errPlaybackResolverWASMInvalid
		}
	}
	return nil
}

func wasmCallError(callErr, fallback error) error {
	if callErr != nil {
		return callErr
	}
	return fallback
}
