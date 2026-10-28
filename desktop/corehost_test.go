package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestOriginAndPrivateProxy(t *testing.T) {
	hits := 0
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if !strings.HasPrefix(r.Host, "127.0.0.1:") || r.Header.Get("Origin") != "" || r.Header.Get("Referer") != "" {
			t.Errorf("unsafe forwarded request: %s", r.Host)
		}
		if r.Method != "POST" || r.URL.Path != "/api/v1/account/login" || r.URL.Query().Get("fixture") != "1" {
			t.Error("request contract changed")
		}
		b, _ := io.ReadAll(r.Body)
		if string(b) != "{}" {
			t.Error("body lost")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer core.Close()
	host := newCoreHost()
	host.baseURL = core.URL
	for _, origin := range []string{"wails://wails", "http://wails.localhost", "https://evil.test", "null"} {
		request := httptest.NewRequest("POST", "http://wails.localhost/api/v1/account/login?fixture=1", strings.NewReader("{}"))
		if origin == "wails://wails" {
			request.Host = "wails"
		}
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		host.proxy(response, request)
		if origin == "wails://wails" || origin == "http://wails.localhost" {
			if response.Code != 200 {
				t.Fatal(response.Code)
			}
		} else if response.Code != 403 {
			t.Fatal("foreign origin accepted")
		}
	}
	if hits != 2 {
		t.Fatal(hits)
	}
	for _, addr := range []string{"http://evil.test/api/v1/account", "http://wails.localhost:9999/api/v1/account"} {
		request := httptest.NewRequest("POST", addr, nil)
		response := httptest.NewRecorder()
		host.proxy(response, request)
		if response.Code != 403 {
			t.Fatal(addr)
		}
	}
}
func TestSharedPageAndMediaRange(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Write([]byte("<html><head></head><body>shared-ui</body></html>"))
			return
		}
		if r.Header.Get("Range") != "bytes=2-4" {
			t.Error("Range lost")
		}
		w.Header().Set("Content-Range", "bytes 2-4/6")
		w.WriteHeader(206)
		w.Write([]byte("cde"))
	}))
	defer core.Close()
	host := newCoreHost()
	host.baseURL = core.URL
	request := httptest.NewRequest("GET", "http://wails.localhost/index.html", nil)
	response := httptest.NewRecorder()
	host.proxy(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "shared-ui") || !strings.Contains(response.Body.String(), core.URL) {
		t.Fatal(response.Body.String())
	}
	request = httptest.NewRequest("GET", "http://wails.localhost/minireel-proxy/media/test.mp4", nil)
	request.Header.Set("Range", "bytes=2-4")
	response = httptest.NewRecorder()
	host.proxy(response, request)
	if response.Code != 206 || response.Header().Get("Content-Range") != "bytes 2-4/6" || response.Body.String() != "cde" {
		t.Fatal(response)
	}
}
func TestReadinessIdentity(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "version": "test", "instance_id": "own"})
	}))
	defer core.Close()
	if err := verifyCore(context.Background(), core.URL, "own", "test"); err != nil {
		t.Fatal(err)
	}
	if err := verifyCore(context.Background(), core.URL, "other", "test"); err == nil {
		t.Fatal("stale process accepted")
	}
	if err := verifyCore(context.Background(), core.URL, "own", "old"); err == nil {
		t.Fatal("stale version accepted")
	}
}

// Child lifecycle failure is also exercised without a GUI/runtime.
func TestMissingCoreRetryState(t *testing.T) {
	host := newCoreHost()
	host.path = "/missing/hongguo-core"
	host.dataDir = t.TempDir()
	host.start()
	select {
	case <-host.done:
	case <-time.After(3 * time.Second):
		t.Fatal("failure did not settle")
	}
	response := httptest.NewRecorder()
	host.proxy(response, httptest.NewRequest("GET", "http://wails.localhost/desktop/status", nil))
	var state struct {
		Ready, Starting bool
		Error           string
	}
	json.Unmarshal(response.Body.Bytes(), &state)
	if state.Ready || state.Starting || state.Error == "" {
		t.Fatal(state)
	}
	host.start()
	select {
	case <-host.done:
	case <-time.After(3 * time.Second):
		t.Fatal("retry failed")
	}
	host.stop()
}

func TestBundledCoreLifecycle(t *testing.T) {
	path := os.Getenv("HONGGUO_TEST_CORE")
	if path == "" {
		t.Skip("set HONGGUO_TEST_CORE to a compiled shared core")
	}
	host := newCoreHost()
	host.path = path
	host.dataDir = t.TempDir()
	host.cacheDir = t.TempDir()
	host.start()
	deadline := time.Now().Add(10 * time.Second)
	for host.target() == "" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	target := host.target()
	if target == "" {
		host.stop()
		t.Fatal("core did not become ready")
	}
	request := httptest.NewRequest("GET", "http://wails.localhost/api/v1/library", nil)
	request.Header.Set("Origin", "http://wails.localhost")
	response := httptest.NewRecorder()
	host.proxy(response, request)
	if response.Code != 200 {
		host.stop()
		t.Fatal(response.Code, response.Body.String())
	}
	// The desktop child enables the private optional cache route. An unknown
	// prepared token must fail locally, without resolving an upstream source.
	request = httptest.NewRequest("POST", "http://wails.localhost/api/v1/play/cache?media=invalid", nil)
	request.Header.Set("Origin", "http://wails.localhost")
	response = httptest.NewRecorder()
	host.proxy(response, request)
	if response.Code != http.StatusConflict {
		host.stop()
		t.Fatal("desktop cache route unavailable", response.Code)
	}
	host.stop()
	client := http.Client{Timeout: time.Second, Transport: localTransport}
	if resp, err := client.Get(target + "/api/v1/status"); err == nil {
		resp.Body.Close()
		t.Fatal("child survived host shutdown")
	}
}
