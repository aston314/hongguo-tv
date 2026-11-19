//go:build resolverwasm && wasip1 && wasm

package main

// This reactor compiles the existing production algorithm itself. No host
// signing, identity, model parsing or embedded resolver is called by the guest.
import (
	"bytes"
	"context"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
	"unsafe"
)

func main() {}

//go:embed testdata/signing-v5-wire.json
var resolverGuestWireVectors []byte

//go:wasmexport resolver_self_test
func resolverGuestSelfTest() uint32 {
	var rows []struct {
		Query, Body, Medusa, Helios string
		TS                          uint32
	}
	if json.Unmarshal(resolverGuestWireVectors, &rows) != nil || len(rows) != 4 {
		return 0
	}
	for _, row := range rows {
		body, err := hex.DecodeString(row.Body)
		if err != nil {
			return 0
		}
		values := miniReelMobileV5Query(miniReelDevice{deviceID: "123", installID: "456", cdid: "synthetic"})
		query, q, m, err := playbackV5Tune(values, body, int64(row.TS)*1000)
		if err != nil || query != row.Query {
			return 1
		}
		medusa, err := playbackV5Medusa(values, row.TS, q, m, [3]uint32{0x80000000, 0x80000000, 0x80000000}, playbackV5Process{nonce: "synthetic", started: 1800000000000})
		if err != nil || medusa != row.Medusa || playbackV5Helios(row.TS, 0x80000000) != row.Helios {
			return 2
		}
	}
	return 4
}

//go:wasmimport hongguo_resolver_host resolver_http
func resolverGuestHTTP(uint32, uint32, uint32, uint32) uint32

var resolverGuestBuffers = map[uint32][]byte{}

//go:wasmexport resolver_alloc
func resolverGuestAlloc(size uint32) uint32 {
	if size == 0 || size > playbackResolverWASMMaxResult {
		return 0
	}
	b := make([]byte, size)
	p := uint32(uintptr(unsafe.Pointer(&b[0])))
	resolverGuestBuffers[p] = b
	return p
}

//go:wasmexport resolver_free
func resolverGuestFree(ptr, size uint32) { delete(resolverGuestBuffers, ptr) }

type resolverGuestTransport struct{}

func (resolverGuestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	var body []byte
	if req.Body != nil {
		defer req.Body.Close()
		var err error
		body, err = io.ReadAll(io.LimitReader(req.Body, playbackResolverWASMMaxRequest+1))
		if err != nil || len(body) > playbackResolverWASMMaxRequest {
			return nil, errors.New("resolver request too large")
		}
	}
	headers := map[string]string{}
	for k := range req.Header {
		headers[k] = req.Header.Get(k)
	}
	input, err := json.Marshal(playbackResolverWASMHTTPRequest{Method: req.Method, URL: req.URL.String(), Headers: headers, Body: body})
	if err != nil || len(input) > playbackResolverWASMMaxRequest {
		return nil, errors.New("resolver request encoding failed")
	}
	out := make([]byte, playbackResolverWASMMaxHTTPBody)
	n := resolverGuestHTTP(uint32(uintptr(unsafe.Pointer(&input[0]))), uint32(len(input)), uint32(uintptr(unsafe.Pointer(&out[0]))), uint32(len(out)))
	if n == 0 || n > uint32(len(out)) {
		return nil, errors.New("resolver host transport failed")
	}
	var response playbackResolverWASMHTTPResponse
	if json.Unmarshal(out[:n], &response) != nil {
		return nil, errors.New("resolver host response invalid")
	}
	return &http.Response{StatusCode: response.Status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(response.Body)), Request: req}, nil
}

//go:wasmexport resolver_resolve
func resolverGuestResolve(ptr, size uint32) uint64 {
	b, ok := resolverGuestBuffers[ptr]
	if !ok || size > uint32(len(b)) {
		return 0
	}
	var request playbackResolverWASMRequest
	if json.Unmarshal(b[:size], &request) != nil {
		return 0
	}
	// All anonymous registration, signing and fallback HTTP leaves through the
	// same bounded callback, including clients created by existing Go helpers.
	http.DefaultTransport = resolverGuestTransport{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	options, err := productionMobileV5.options(ctx, request.VID, request.CodecMode, request.ContentType)
	response := playbackResolverWASMResponse{Options: options}
	if err != nil {
		d := playbackPreparationDetails(err)
		response.ErrorCode, response.ErrorStage = d.Code, d.Stage
		if response.ErrorCode == "" {
			response.ErrorCode = "RESOLVER_FAILED"
		}
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return 0
	}
	output := resolverGuestAlloc(uint32(len(encoded)))
	if output == 0 {
		return 0
	}
	copy(resolverGuestBuffers[output], encoded)
	return uint64(output)<<32 | uint64(len(encoded))
}
