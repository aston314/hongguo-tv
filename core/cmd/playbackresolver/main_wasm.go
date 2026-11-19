//go:build wasip1 && wasm

// Playback-only reactor. No import of the application command or net/http.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"unsafe"

	"github.com/aston314/hongguo-tv/core/internal/playbackresolver"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

func main() {}

//go:wasmimport hongguo_resolver_host resolver_http
func hostHTTP(uint32, uint32, uint32, uint32) uint32

var buffers = map[uint32][]byte{}
var responseBuffer []byte
var resolver = playbackresolver.New(requestHTTP)

//go:wasmexport resolver_self_test
func selfTest() uint32 { return playbackresolver.SelfTest() }

//go:wasmexport resolver_alloc
func alloc(size uint32) uint32 {
	if size == 0 || size > resolverwire.MaxResult {
		return 0
	}
	b := make([]byte, size)
	ptr := uint32(uintptr(unsafe.Pointer(&b[0])))
	buffers[ptr] = b
	return ptr
}

//go:wasmexport resolver_free
func free(ptr, size uint32) { delete(buffers, ptr) }

func requestHTTP(ctx context.Context, request resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
	if err := ctx.Err(); err != nil {
		return resolverwire.HTTPResponse{}, err
	}
	input, err := json.Marshal(request)
	if err != nil || len(input) > resolverwire.MaxRequest {
		return resolverwire.HTTPResponse{}, errors.New("request too large")
	}
	// Reuse one callback output buffer, instead of allocating 2 MiB per request.
	if responseBuffer == nil {
		responseBuffer = make([]byte, resolverwire.MaxHTTPBody)
	}
	n := hostHTTP(uint32(uintptr(unsafe.Pointer(&input[0]))), uint32(len(input)), uint32(uintptr(unsafe.Pointer(&responseBuffer[0]))), uint32(len(responseBuffer)))
	runtime.KeepAlive(input)
	if n == 0 || n > uint32(len(responseBuffer)) {
		return resolverwire.HTTPResponse{}, errors.New("host transport failed")
	}
	var response resolverwire.HTTPResponse
	if json.Unmarshal(responseBuffer[:n], &response) != nil {
		return resolverwire.HTTPResponse{}, errors.New("host response invalid")
	}
	return response, nil
}

//go:wasmexport resolver_resolve
func resolve(ptr, size uint32) uint64 {
	input, ok := buffers[ptr]
	if !ok || size > uint32(len(input)) {
		return 0
	}
	var request resolverwire.Request
	if json.Unmarshal(input[:size], &request) != nil {
		return 0
	}
	options, err := resolver.Resolve(context.Background(), request)
	response := resolverwire.Response{Options: options}
	if err != nil {
		var detail *playbackresolver.Error
		if errors.As(err, &detail) {
			response.ErrorCode = detail.Code
			response.ErrorStage = detail.Stage
		} else {
			response.ErrorCode = "RESOLVER_FAILED"
		}
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		return 0
	}
	output := alloc(uint32(len(encoded)))
	if output == 0 {
		return 0
	}
	copy(buffers[output], encoded)
	return uint64(output)<<32 | uint64(len(encoded))
}
