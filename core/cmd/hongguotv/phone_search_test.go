package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func phoneSearchFixture(t *testing.T, dir string) (*phoneSearchManager, phoneSearchResult, string) {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
	}
	m := newPhoneSearchManager(dir)
	m.selectIP = func() (net.IP, error) { return net.ParseIP("127.0.0.1"), nil }
	t.Cleanup(m.close)
	result, err := m.start()
	if err != nil {
		t.Fatal(err)
	}
	return m, result, "http://" + m.host + "/search/" + m.token + "/"
}
func phoneSearchRequest(t *testing.T, method, target, body string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, target, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var data map[string]any
	json.NewDecoder(res.Body).Decode(&data)
	return res.StatusCode, data
}
func phoneSearchSend(t *testing.T, target, nonce, query string) int {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"nonce": nonce, "query": query})
	status, _ := phoneSearchRequest(t, "POST", target+"state", string(body))
	return status
}

func TestPhoneSearchRepeatedSearchAndAcknowledgement(t *testing.T) {
	m, start, target := phoneSearchFixture(t, "")
	for i, query := range []string{"  繁體 劇名  ", "另一部劇"} {
		status, state := phoneSearchRequest(t, "GET", target+"state", "")
		if status != 200 || state["ready"] != true {
			t.Fatal(status, state)
		}
		key := state["nonce"].(string)
		if phoneSearchSend(t, target, key, query) != 200 {
			t.Fatal("send failed")
		}
		if phoneSearchSend(t, target, key, query) != 409 {
			t.Fatal("duplicate accepted")
		}
		value := m.poll(start.Session, i, true, false)
		if value.State != "completed" || value.ID != i+1 || value.Value != strings.TrimSpace(query) {
			t.Fatal(value)
		}
		if retry := m.poll(start.Session, i, true, false); retry.ID != value.ID {
			t.Fatal("lost response dropped input")
		}
		if m.poll(start.Session, value.ID, true, false).State != "waiting" {
			t.Fatal("ack not applied")
		}
	}
	if info, err := os.Stat(filepath.Join(m.dir, "phone-search.json")); err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("unsafe persistent entry", err)
	}
}

func TestPhoneSearchLeaseIsolationAndExpiry(t *testing.T) {
	m, first, target := phoneSearchFixture(t, "")
	_, old := phoneSearchRequest(t, "GET", target+"state", "")
	m.poll(first.Session, 0, false, false)
	if phoneSearchSend(t, target, old["nonce"].(string), "旧搜索") != 409 {
		t.Fatal("inactive search accepted")
	}
	_, state := phoneSearchRequest(t, "GET", target+"state", "")
	if state["ready"] != false || state["nonce"] != nil {
		t.Fatal(state)
	}
	m.poll(first.Session, 0, true, true)
	next, err := m.start()
	if err != nil {
		t.Fatal(err)
	}
	if first.QR != next.QR || first.Session == next.Session {
		t.Fatal("bookmark or lease changed incorrectly")
	}
	if m.poll(first.Session, 0, true, true).State != "expired" {
		t.Fatal("old lease affected new page")
	}
	if phoneSearchSend(t, target, old["nonce"].(string), "旧页面") != 409 {
		t.Fatal("stale form accepted")
	}
	m.mu.Lock()
	m.expires = time.Now().Add(-time.Second)
	m.mu.Unlock()
	if m.poll(next.Session, 0, true, false).State != "expired" {
		t.Fatal("expired lease resurrected")
	}
	_, state = phoneSearchRequest(t, "GET", target+"state", "")
	if state["ready"] != false {
		t.Fatal(state)
	}
}

func TestPhoneSearchSlowSubmissionCannotDelayNavigation(t *testing.T) {
	m, first, _ := phoneSearchFixture(t, "")
	body, _ := json.Marshal(map[string]string{"nonce": m.nonce, "query": "旧页面搜索"})
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	req := httptest.NewRequest("POST", "http://"+m.host+"/search/"+m.token+"/state", reader)
	req.RemoteAddr = "192.168.2.1:1234"
	w := httptest.NewRecorder()
	finished := make(chan struct{})
	go func() { m.mobile(w, req); close(finished) }()
	if _, err := writer.Write(body[:1]); err != nil {
		t.Fatal(err)
	}
	stopped := make(chan phoneSearchResult, 1)
	go func() { stopped <- m.poll(first.Session, 0, false, true) }()
	select {
	case result := <-stopped:
		if result.State != "closed" {
			t.Fatal(result)
		}
	case <-time.After(time.Second):
		reader.Close()
		<-finished
		t.Fatal("phone upload blocked TV navigation")
	}
	next, err := m.start()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writer.Write(body[1:]); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	<-finished
	if w.Code != 409 || m.poll(next.Session, 0, true, false).State != "waiting" {
		t.Fatal("old upload reached the new page", w.Code)
	}
}

func TestPhoneSearchBookmarkSurvivesRestartAndPortConflict(t *testing.T) {
	dir := t.TempDir()
	m, first, target := phoneSearchFixture(t, dir)
	port := m.port
	m.close()
	n, next, restored := phoneSearchFixture(t, dir)
	if target != restored || first.QR != next.QR {
		t.Fatal("bookmark was not restored")
	}
	n.close()
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	r, _, replacement := phoneSearchFixture(t, dir)
	if r.port == port || r.token != m.token || replacement == target {
		t.Fatal("occupied port did not recover")
	}
}

func TestPhoneSearchBoundaryAndSharedAssets(t *testing.T) {
	m, _, target := phoneSearchFixture(t, "")
	for _, test := range []struct {
		path, host, origin, method string
		status                     int
	}{
		{"/api/v1/account", m.host, "", "GET", 404},
		{"/search/wrong/state", m.host, "", "GET", 404},
		{"/search/" + m.token + "/state", "attacker.invalid", "", "GET", 404},
		{"/search/" + m.token + "/state", m.host, "https://attacker.invalid", "POST", 403},
		{"/search/" + m.token + "/state", m.host, "", "DELETE", 405},
	} {
		req := httptest.NewRequest(test.method, "http://"+m.host+test.path, nil)
		req.RemoteAddr = "192.168.2.1:1234"
		req.Host = test.host
		req.Header.Set("Origin", test.origin)
		w := httptest.NewRecorder()
		m.mobile(w, req)
		if w.Code != test.status {
			t.Fatal(test, w.Code)
		}
	}
	_, state := phoneSearchRequest(t, "GET", target+"state", "")
	for _, query := range []string{"", strings.Repeat("字", 101), "剧\x00名"} {
		if phoneSearchSend(t, target, state["nonce"].(string), query) != 400 {
			t.Fatal("invalid query accepted")
		}
	}
	for _, asset := range []string{"", "mobile.js"} {
		res, err := http.Get(target + asset)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || len(body) < 100 || res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("asset unavailable or exposed")
		}
	}
	s := &server{phoneSearches: m}
	req := httptest.NewRequest("POST", "http://"+m.host+"/api/v1/search/phone", nil)
	req.RemoteAddr = "192.168.2.1:1234"
	w := httptest.NewRecorder()
	s.withCORS(http.HandlerFunc(s.phoneSearch)).ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatal("LAN activated private API")
	}
}
