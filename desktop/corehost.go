package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var localTransport = &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext, ResponseHeaderTimeout: 40 * time.Second}

type coreHost struct {
	mu       sync.RWMutex
	cmd      *exec.Cmd
	baseURL  string
	starting bool
	stopped  bool
	failure  string
	done     chan struct{}
	path     string
	dataDir  string
	cacheDir string
	timeout  time.Duration
}

func newCoreHost() *coreHost { return &coreHost{timeout: 20 * time.Second} }
func (h *coreHost) start() {
	h.mu.Lock()
	if h.starting || h.baseURL != "" || h.stopped {
		h.mu.Unlock()
		return
	}
	h.starting, h.failure = true, ""
	h.done = make(chan struct{})
	done := h.done
	h.mu.Unlock()
	go h.run(done)
}
func (h *coreHost) run(done chan struct{}) {
	defer close(done)
	fail := func(message string) {
		h.mu.Lock()
		h.starting = false
		h.baseURL = ""
		h.failure = message
		h.cmd = nil
		h.mu.Unlock()
	}
	path := h.path
	if path == "" {
		path = os.Getenv("HONGGUO_CORE_PATH")
	}
	if path == "" {
		exe, err := os.Executable()
		if err != nil {
			fail("无法定位内置核心，请重新安装。")
			return
		}
		path = filepath.Join(filepath.Dir(exe), coreName())
	}
	dataDir := h.dataDir
	if dataDir == "" {
		var err error
		dataDir, err = desktopDataDir()
		if err != nil {
			fail("无法读取系统配置目录。")
			return
		}
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		fail("无法创建应用数据目录，请检查目录权限。")
		return
	}
	cacheDir := h.cacheDir
	if cacheDir == "" {
		var err error
		cacheDir, err = os.UserCacheDir()
		if err != nil {
			fail("无法读取系统缓存目录。")
			return
		}
	}
	token := make([]byte, 16)
	if _, err := rand.Read(token); err != nil {
		fail("无法生成启动标识。")
		return
	}
	instance := hex.EncodeToString(token)
	cmd := exec.Command(path, "-port", "0", "-instance-id", instance, "-data-dir", dataDir, "-parent-pid", strconv.Itoa(os.Getpid()), "-desktop-episode-cache")
	cmd.Env = append(os.Environ(), "MINIREEL_CACHE_DIR="+filepath.Join(cacheDir, "HongguoDesktop", "media"))
	configureProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fail("无法启动核心通信。")
		return
	}
	// Never copy account or upstream request logs into desktop diagnostics.
	cmd.Stderr = io.Discard
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		fail("")
		return
	}
	if err = cmd.Start(); err != nil {
		h.mu.Unlock()
		fail("内置核心启动失败，请检查安装文件是否完整。")
		return
	}
	h.cmd = cmd
	h.mu.Unlock()
	ready := make(chan string, 1)
	scanned := make(chan struct{})
	go func() {
		defer close(scanned)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			parts := strings.Fields(scanner.Text())
			if len(parts) != 3 || parts[0] != "HONGGUO_TV_READY" || parts[2] != instance {
				continue
			}
			port, err := strconv.Atoi(parts[1])
			if err != nil || port < 1 || port > 65535 {
				continue
			}
			select {
			case ready <- "http://127.0.0.1:" + strconv.Itoa(port):
			default:
			}
		}
	}()
	exited := make(chan error, 1)
	go func() { <-scanned; exited <- cmd.Wait() }()
	timer := time.NewTimer(h.timeout)
	defer timer.Stop()
	var target string
	select {
	case target = <-ready:
	case <-exited:
		fail("核心服务提前停止，请重试或重新安装。")
		return
	case <-timer.C:
		_ = cmd.Process.Kill()
		<-exited
		fail("核心服务启动超时，请重试。")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	err = verifyCore(ctx, target, instance, version)
	cancel()
	if err != nil {
		_ = cmd.Process.Kill()
		<-exited
		fail("核心版本或启动状态不匹配，请重新安装完整安装包。")
		return
	}
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		_ = cmd.Process.Kill()
		<-exited
		fail("")
		return
	}
	h.baseURL = target
	h.starting = false
	h.mu.Unlock()
	<-exited
	fail("核心服务已停止，请重试。")
}
func verifyCore(ctx context.Context, target, instance, expectedVersion string) error {
	client := &http.Client{Transport: localTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("unexpected redirect") }}
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target+"/api/v1/status", nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			var status struct {
				OK       bool   `json:"ok"`
				Version  string `json:"version"`
				Instance string `json:"instance_id"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&status)
			resp.Body.Close()
			if resp.StatusCode == 200 && decodeErr == nil && status.OK && status.Instance == instance && status.Version == expectedVersion {
				return nil
			}
			return errors.New("core identity mismatch")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func (h *coreHost) target() string { h.mu.RLock(); defer h.mu.RUnlock(); return h.baseURL }
func (h *coreHost) stop() {
	h.mu.Lock()
	h.stopped = true
	cmd, done := h.cmd, h.done
	h.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	}
	localTransport.CloseIdleConnections()
}
func coreName() string {
	if runtime.GOOS == "windows" {
		return "hongguo-tv-core.exe"
	}
	return "hongguo-tv-core"
}

// Validate the Wails origin before stripping synthetic headers for the core.
// Loopback is allowed for the same handler's explicit browser test/preview.
func desktopRequestAllowed(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	u, err := url.Parse("http://" + r.Host)
	if err != nil || u.User != nil {
		return false
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	synthetic := r.Host == "wails" || r.Host == "wails.localhost"
	if !synthetic && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return false
	}
	for _, value := range []string{r.Header.Get("Origin"), r.Header.Get("Referer")} {
		if value == "" {
			continue
		}
		origin, err := url.Parse(value)
		if err != nil || origin.User != nil || origin.Host != r.Host {
			return false
		}
		if synthetic {
			if !(r.Host == "wails" && origin.Scheme == "wails" || r.Host == "wails.localhost" && origin.Scheme == "http") {
				return false
			}
		} else if origin.Scheme != "http" {
			return false
		}
	}
	return true
}
func (h *coreHost) proxy(w http.ResponseWriter, r *http.Request) {
	if !desktopRequestAllowed(r) {
		http.Error(w, "只允许应用页面访问", http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/desktop/status":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		h.mu.RLock()
		state := map[string]interface{}{"ready": h.baseURL != "", "starting": h.starting, "error": h.failure, "version": version}
		h.mu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(state)
		return
	case "/desktop/retry":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		h.start()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	target := h.target()
	if target == "" {
		if r.Method == http.MethodGet && (r.URL.Path == "/" || r.URL.Path == "/index.html") {
			h.writePage(w, startupHTML)
			return
		}
		http.Error(w, "核心服务尚未就绪，请返回启动页重试。", http.StatusServiceUnavailable)
		return
	}
	req := r.Clone(r.Context())
	req.URL.Scheme = "http"
	req.URL.Host = strings.TrimPrefix(target, "http://")
	if r.URL.Path == "/index.html" {
		req.URL.Path = "/"
	}
	req.Host = req.URL.Host
	req.RequestURI = ""
	req.Header = req.Header.Clone()
	for _, key := range []string{"Origin", "Referer", "Sec-Fetch-Site", "Connection", "Proxy-Authorization"} {
		req.Header.Del(key)
	}
	resp, err := localTransport.RoundTrip(req)
	if err != nil {
		http.Error(w, "核心服务连接中断，请重新打开应用。", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 && r.Method == http.MethodGet && (r.URL.Path == "/" || r.URL.Path == "/index.html") {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
		if err != nil {
			http.Error(w, "页面读取失败", http.StatusBadGateway)
			return
		}
		h.writePage(w, string(body))
		return
	}
	for key, values := range resp.Header {
		if key == "Connection" || key == "Access-Control-Allow-Origin" {
			continue
		}
		for _, v := range values {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
func (h *coreHost) writePage(w http.ResponseWriter, html string) {
	config, _ := json.Marshal(map[string]string{"platform": runtime.GOOS, "version": desktopVersion, "mediaBase": h.target()})
	html = strings.Replace(html, "<head>", "<head><script>window.HongguoDesktop="+string(config)+";</script>", 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprint(w, html)
}
