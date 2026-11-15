package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// The bookmark is a random capability scoped to search, never to the core API.
// Only the app can renew a short foreground lease and consume its bounded inbox.
type phoneSearchManager struct {
	mu                                    sync.Mutex
	dir, token, host, lease, nonce, value string
	port                                  int
	id                                    int
	ready, closed                         bool
	expires                               time.Time
	server                                *http.Server
	selectIP                              func() (net.IP, error)
}

type phoneSearchResult struct {
	Session string `json:"session,omitempty"`
	State   string `json:"state"`
	QR      string `json:"qr,omitempty"`
	ID      int    `json:"id,omitempty"`
	Value   string `json:"value,omitempty"`
}

func phoneSearchNonce() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(b[:])
}

func newPhoneSearchManager(dir string) *phoneSearchManager {
	return &phoneSearchManager{dir: dir, selectIP: numberInputLANIP}
}

func (m *phoneSearchManager) start() (phoneSearchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return phoneSearchResult{}, errors.New("手机搜索已关闭")
	}
	ip, err := m.selectIP()
	if err != nil {
		return phoneSearchResult{}, err
	}
	if m.token == "" {
		var saved struct {
			Token string `json:"token"`
			Port  int    `json:"port"`
		}
		if body, e := os.ReadFile(filepath.Join(m.dir, "phone-search.json")); e == nil && len(body) < 1024 {
			if json.Unmarshal(body, &saved) == nil && len(saved.Token) == 64 {
				if _, e = hex.DecodeString(saved.Token); e == nil {
					m.token = saved.Token
				}
			}
			if saved.Port >= 1024 && saved.Port <= 65535 {
				m.port = saved.Port
			}
		}
		if m.token == "" {
			m.token = phoneSearchNonce()
		}
		if m.token == "" {
			return phoneSearchResult{}, errors.New("无法创建手机搜索入口")
		}
	}
	if m.server == nil || !strings.HasPrefix(m.host, ip.String()+":") {
		if m.server != nil {
			m.server.Close()
			m.server = nil
		}
		listener, e := net.Listen("tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(m.port)))
		if e != nil && m.port != 0 {
			listener, e = net.Listen("tcp4", net.JoinHostPort(ip.String(), "0"))
		}
		if e != nil {
			return phoneSearchResult{}, errors.New("手机搜索暂不可用，请使用扫码输入")
		}
		m.host = listener.Addr().String()
		m.port = listener.Addr().(*net.TCPAddr).Port
		body, _ := json.Marshal(struct {
			Token string `json:"token"`
			Port  int    `json:"port"`
		}{m.token, m.port})
		if e = os.MkdirAll(m.dir, 0700); e == nil {
			e = os.WriteFile(filepath.Join(m.dir, "phone-search.json.tmp"), body, 0600)
		}
		if e == nil {
			e = os.Rename(filepath.Join(m.dir, "phone-search.json.tmp"), filepath.Join(m.dir, "phone-search.json"))
		}
		if e != nil {
			listener.Close()
			return phoneSearchResult{}, errors.New("无法保存手机搜索入口，请使用扫码输入")
		}
		m.server = &http.Server{Handler: http.HandlerFunc(m.mobile), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8192}
		go m.server.Serve(listener)
	}
	lease, nonce := phoneSearchNonce(), phoneSearchNonce()
	if lease == "" || nonce == "" {
		return phoneSearchResult{}, errors.New("无法创建手机搜索会话")
	}
	png, err := qrcode.Encode("http://"+m.host+"/search/"+m.token+"/", qrcode.Medium, 280)
	if err != nil {
		return phoneSearchResult{}, errors.New("无法生成手机搜索二维码")
	}
	m.lease, m.nonce, m.value, m.id = lease, nonce, "", 0
	m.ready = true
	m.expires = time.Now().Add(10 * time.Second)
	return phoneSearchResult{Session: lease, State: "waiting", QR: "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)}, nil
}

func (m *phoneSearchManager) poll(lease string, ack int, ready, stop bool) phoneSearchResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	if lease == "" || lease != m.lease || !time.Now().Before(m.expires) {
		return phoneSearchResult{State: "expired"}
	}
	if stop {
		m.lease, m.nonce, m.value = "", "", ""
		m.ready = false
		return phoneSearchResult{State: "closed"}
	}
	m.ready = ready
	m.expires = time.Now().Add(10 * time.Second)
	if !ready || ack == m.id {
		m.value = ""
	}
	if m.value != "" {
		return phoneSearchResult{State: "completed", ID: m.id, Value: m.value}
	}
	return phoneSearchResult{State: "waiting"}
}

func (m *phoneSearchManager) close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	m.ready = false
	m.lease, m.nonce, m.value = "", "", ""
	if m.server != nil {
		m.server.Close()
		m.server = nil
	}
}

func (m *phoneSearchManager) mobile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
	m.mu.Lock()
	defer m.mu.Unlock()
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	base := "/search/" + m.token
	if err != nil || (!numberInputPrivateIPv4(net.ParseIP(remote)) && !net.ParseIP(remote).IsLoopback()) || r.Host != m.host || m.closed || m.token == "" {
		http.NotFound(w, r)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+m.host || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == base {
		http.Redirect(w, r, base+"/", http.StatusTemporaryRedirect)
		return
	}
	if r.Method == http.MethodGet && (r.URL.Path == base+"/" || r.URL.Path == base+"/mobile.js") {
		asset, mime := "phone-search.html", "text/html; charset=utf-8"
		if r.URL.Path != base+"/" {
			asset, mime = "phone-search-page.js", "application/javascript; charset=utf-8"
		}
		body, e := uiFiles.ReadFile("ui/" + asset)
		if e != nil {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Write(body)
		return
	}
	if r.URL.Path != base+"/state" {
		http.NotFound(w, r)
		return
	}
	ready := m.ready && m.lease != "" && time.Now().Before(m.expires)
	if !ready {
		m.value = ""
	}
	if r.Method == http.MethodGet {
		value := map[string]any{"ready": ready, "pending": ready && m.value != ""}
		if ready {
			value["nonce"] = m.nonce
		}
		writeJSON(w, 200, value)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	if !ready {
		writeJSON(w, 409, map[string]any{"error": "TV_NOT_READY"})
		return
	}
	// A slow phone upload must not block TV navigation or keep an old lease alive.
	observed := m.lease
	m.mu.Unlock()
	var body struct {
		Nonce string `json:"nonce"`
		Query string `json:"query"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	validBody := d.Decode(&body) == nil && d.Decode(&struct{}{}) == io.EOF
	m.mu.Lock()
	if m.closed || !m.ready || m.lease != observed || !time.Now().Before(m.expires) {
		writeJSON(w, 409, map[string]any{"error": "TV_NOT_READY"})
		return
	}
	if !validBody {
		writeJSON(w, 400, map[string]any{"error": "INVALID_INPUT"})
		return
	}
	query, valid := normalizeSearchQuery(body.Query)
	if !valid {
		writeJSON(w, 400, map[string]any{"error": "INVALID_INPUT"})
		return
	}
	if body.Nonce == "" || body.Nonce != m.nonce {
		writeJSON(w, 409, map[string]any{"error": "STALE_FORM"})
		return
	}
	if m.value != "" {
		writeJSON(w, 409, map[string]any{"error": "PENDING_INPUT"})
		return
	}
	nonce := phoneSearchNonce()
	if nonce == "" {
		w.WriteHeader(503)
		return
	}
	m.nonce, m.value, m.id = nonce, query, m.id+1
	writeJSON(w, 200, map[string]any{"accepted": true})
}

func (s *server) phoneSearch(w http.ResponseWriter, r *http.Request) {
	if s.phoneSearches == nil {
		writeError(w, 503, "手机搜索暂不可用")
		return
	}
	if r.Method == http.MethodPost {
		result, err := s.phoneSearches.start()
		if err != nil {
			writeError(w, 503, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "data": result})
		return
	}
	if r.Method == http.MethodGet || r.Method == http.MethodDelete {
		ack, _ := strconv.Atoi(r.URL.Query().Get("ack"))
		value := s.phoneSearches.poll(r.URL.Query().Get("session"), ack, r.URL.Query().Get("ready") == "1", r.Method == http.MethodDelete)
		writeJSON(w, 200, map[string]any{"ok": true, "data": value})
		return
	}
	w.WriteHeader(http.StatusMethodNotAllowed)
}
