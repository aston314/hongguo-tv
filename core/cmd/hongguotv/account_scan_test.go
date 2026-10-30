package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type qrFixtureTransport func(*http.Request) (*http.Response, error)

func (f qrFixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Keep production HTTPS URLs and cookie domain rules while sending only to a fixture.
func useQRFixture(t *testing.T, m *accountManager, handler http.HandlerFunc) {
	t.Helper()
	remote := httptest.NewServer(handler)
	t.Cleanup(remote.Close)
	target, _ := url.Parse(remote.URL)
	m.qrPollEvery = time.Millisecond
	m.newQRClient = func() *qrPassportClient {
		c := newQRPassportClient()
		c.http.Transport = qrFixtureTransport(func(r *http.Request) (*http.Response, error) {
			if !validQRRedirect(r.URL) {
				return nil, errors.New("unexpected fixture destination")
			}
			next := r.Clone(r.Context())
			u := *r.URL
			next.URL = &u
			next.URL.Scheme = target.Scheme
			next.URL.Host = target.Host
			return remote.Client().Transport.RoundTrip(next)
		})
		return c
	}
	t.Cleanup(func() { m.mu.Lock(); m.generation++; m.cancelQRLocked(); m.mu.Unlock() })
}
func waitQR(t *testing.T, m *accountManager, state string) accountStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s := m.status()
		if s.QRLogin != nil && s.QRLogin.State == state {
			return s
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("QR did not reach %s (status: %+v)", state, m.status().QRLogin)
	return accountStatus{}
}
func qrFixtureStart(w http.ResponseWriter, expiry int) {
	_ = json.NewEncoder(w).Encode(map[string]any{"message": "success", "data": map[string]any{"token": "fixture-private-qr-token", "qrcode": smsQRDataURL("1060000", "ONLY-FIXTURE"), "expire_time": expiry}})
}
func qrFixtureProfile(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("sessionid"); err != nil || cookie.Value != "fixture-qr-session" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	// A website profile can refresh the session; only final verified cookies persist.
	http.SetCookie(w, &http.Cookie{Name: "sessionid", Value: "fixture-qr-session", Path: "/", Secure: true})
	ioJSON(w, `{"message":"success","data":{"user_id_str":"123456789","user_id":123456789,"screen_name":"扫码用户"}}`)
}
func TestQRLoginPersistsVerifiedAccountAndUsesExistingFavoriteWrite(t *testing.T) {
	var writes atomic.Int32
	m := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/service/2/device_register/" {
			if r.Header.Get("Cookie") != "" {
				t.Error("website credentials sent to anonymous registration")
			}
			accountFixtureResponse(w, r.URL.Path, false)
			return
		}
		if r.URL.Path != "/reading/bookapi/bookshelf/video/update/v" || r.Method != http.MethodPost {
			t.Error("unexpected App operation")
			w.WriteHeader(404)
			return
		}
		cookie, err := r.Cookie("sessionid")
		if err != nil || cookie.Value != "fixture-qr-session" {
			t.Error("shared App request lost QR session")
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || len(body["update_bookshelf_video_list"].([]any)) != 1 {
			t.Error("favorite wire contract changed")
		}
		writes.Add(1)
		ioJSON(w, `{"code":0,"data":{}}`)
	})
	var polls atomic.Int32
	useQRFixture(t, m, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("aid") != "513755" && strings.HasPrefix(r.URL.Path, "/passport/") {
			t.Error("wrong website app id")
		}
		switch r.URL.Path {
		case "/passport/web/get_qrcode/":
			qrFixtureStart(w, 180)
		case "/passport/web/check_qrconnect/":
			if r.URL.Query().Get("token") != "fixture-private-qr-token" {
				t.Error("QR token lost")
			}
			switch polls.Add(1) {
			case 1:
				ioJSON(w, `{"message":"success","data":{"status":"new"}}`)
				return
			case 2:
				ioJSON(w, `{"message":"success","data":{"status":2}}`)
				return
			}
			ioJSON(w, `{"message":"success","data":{"status":3,"redirect_url":"/fixture-confirm"}}`)
		case "/fixture-confirm":
			http.SetCookie(w, &http.Cookie{Name: "sessionid", Value: "fixture-qr-session", Path: "/", Secure: true})
			http.SetCookie(w, &http.Cookie{Name: "install_id", Value: "website-install", Path: "/", Secure: true})
			http.Redirect(w, r, "/fixture-done", http.StatusFound)
		case "/fixture-done":
			w.WriteHeader(200)
		case "/passport/account/info/v2/":
			qrFixtureProfile(w, r)
		default:
			t.Error("unexpected website operation")
			w.WriteHeader(404)
		}
	})
	guestOwner := ""
	yes := true
	if _, err := m.changeLibrary(LibraryChange{OwnerID: &guestOwner, Action: "favorite", Drama: Drama{SeriesID: "999997", Title: "游客收藏"}, Value: &yes}); err != nil {
		t.Fatal(err)
	}
	initial, err := m.startQR()
	if err != nil {
		t.Fatal(err)
	}
	if initial.QRLogin == nil || initial.QRLogin.State != "preparing" || len(initial.QRLogin.ID) != 32 {
		t.Fatal("missing stable local QR id")
	}
	status := waitQR(t, m, "signed_in")
	if !status.LoggedIn || status.Profile.UID != "123456789" || status.Profile.Phone != "" || status.LoginMethod != "qr" {
		t.Fatal("QR did not commit shared account")
	}
	b, _ := json.Marshal(status)
	for _, secret := range []string{"fixture-private-qr-token", "fixture-qr-session", "website-install", "redirect_url", "cookies", "data:image"} {
		if bytes.Contains(b, []byte(secret)) {
			t.Fatal("private QR material leaked in account status")
		}
	}
	m.mu.Lock()
	session := cloneAccountSession(m.disk.Session)
	m.mu.Unlock()
	if !session.Registered || session.Cookies["sessionid"] != "fixture-qr-session" || session.Cookies["install_id"] == "website-install" {
		t.Fatal("QR session/device merge incorrect")
	}
	if err := m.newClient(session).uploadMutation(context.Background(), cloudMutation{Kind: "favorite", SeriesID: "999999", Value: true}); err != nil {
		t.Fatal(err)
	}
	if writes.Load() != 1 {
		t.Fatal("existing favorite API was not used exactly once")
	}
	info, err := os.Stat(filepath.Join(m.dir, "account.json"))
	if err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("account file not private")
	}
	reloaded, err := newAccountManager(m.dir, m.guest, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.status().LoggedIn || reloaded.status().LoginMethod != "qr" || reloaded.disk.Session.Cookies["sessionid"] != "fixture-qr-session" {
		t.Fatal("QR restore failed")
	}
	before, _ := os.ReadFile(filepath.Join(m.dir, "account.json"))
	if _, err = m.startQR(); err == nil {
		t.Fatal("QR replaced an existing account")
	}
	after, _ := os.ReadFile(filepath.Join(m.dir, "account.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("rejected QR changed account")
	}
	if err = m.logout(); err != nil {
		t.Fatal(err)
	}
	if got := m.librarySnapshot(); len(got.Entries) != 1 || got.Entries[0].Drama.SeriesID != "999997" {
		t.Fatal("QR logout lost guest state")
	}
	b, _ = os.ReadFile(filepath.Join(m.dir, "account.json"))
	if bytes.Contains(b, []byte("fixture-qr-session")) {
		t.Fatal("logout retained QR credentials")
	}
}
func TestQRRefreshAndCancelRejectLateCompletions(t *testing.T) {
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var registrations atomic.Int32
	m := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) {
		if registrations.Add(1) == 1 {
			close(entered)
			defer close(finished)
		}
		<-release
		accountFixtureResponse(w, r.URL.Path, false)
	})
	var starts atomic.Int32
	useQRFixture(t, m, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/passport/web/get_qrcode/":
			starts.Add(1)
			qrFixtureStart(w, 180)
		case "/passport/web/check_qrconnect/":
			http.SetCookie(w, &http.Cookie{Name: "sessionid", Value: "fixture-qr-session", Path: "/", Secure: true})
			ioJSON(w, `{"message":"success","data":{"status":3}}`)
		case "/passport/account/info/v2/":
			qrFixtureProfile(w, r)
		default:
			w.WriteHeader(404)
		}
	})
	// Release a blocked registration even if an assertion fails.
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	first, err := m.startQR()
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	oldGeneration := m.generation
	m.mu.Unlock()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("confirmation did not reach registration")
	}
	second, err := m.startQR()
	if err != nil {
		t.Fatal(err)
	}
	m.cancelQR(first.QRLogin.ID)
	if m.status().QRLogin.ID != second.QRLogin.ID || m.status().QRLogin.State == "cancelled" {
		t.Fatal("late old cancel killed fresh QR")
	}
	m.cancelQR(second.QRLogin.ID)
	close(release)
	<-finished
	status := waitQR(t, m, "cancelled")
	if status.LoggedIn {
		t.Fatal("cancelled confirmation committed account")
	}
	// The central transaction rejects a stale generation even if a transport ignores cancellation.
	if err = m.finishAccountSession(context.Background(), oldGeneration, accountSession{}, &accountProfile{UID: "123456789"}, "qr"); err == nil {
		t.Fatal("stale transaction succeeded")
	}
	if starts.Load() < 1 {
		t.Fatal("fixture did not run")
	}
}
func TestQRFailureAndExpiryNeverPersistAnAccount(t *testing.T) {
	for _, scenario := range []string{"deadline", "expired", "malformed", "missing-session", "invalid-profile", "unsafe-redirect"} {
		t.Run(scenario, func(t *testing.T) {
			m := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) {
				t.Error("invalid QR reached device registration")
				w.WriteHeader(500)
			})
			useQRFixture(t, m, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/passport/web/get_qrcode/":
					if scenario == "malformed" {
						ioJSON(w, `{"message":"success","data":{"token":"secret","qrcode":"invalid-image"}}`)
						return
					}
					expiry := 180
					if scenario == "deadline" {
						expiry = 0
					}
					qrFixtureStart(w, expiry)
				case "/passport/web/check_qrconnect/":
					if scenario == "expired" {
						ioJSON(w, `{"message":"success","data":{"status":5}}`)
						return
					}
					if scenario != "missing-session" {
						http.SetCookie(w, &http.Cookie{Name: "sessionid", Value: "fixture-qr-session", Path: "/", Secure: true})
					}
					if scenario == "unsafe-redirect" {
						ioJSON(w, `{"message":"success","data":{"status":3,"redirect_url":"https://hongguoduanju.com.evil.test/?secret=credential"}}`)
						return
					}
					ioJSON(w, `{"message":"success","data":{"status":3}}`)
				case "/passport/account/info/v2/":
					ioJSON(w, `{"message":"success","data":{"user_id_str":"0"}}`)
				default:
					t.Error("unexpected redirect followed")
					w.WriteHeader(500)
				}
			})
			if _, err := m.startQR(); err != nil {
				t.Fatal(err)
			}
			state := "failed"
			if scenario == "expired" || scenario == "deadline" {
				state = "expired"
			}
			s := waitQR(t, m, state)
			if s.LoggedIn || s.QRLogin.Image != "" {
				t.Fatal("failed QR retained image or account")
			}
			b, _ := os.ReadFile(filepath.Join(m.dir, "account.json"))
			if bytes.Contains(b, []byte("fixture-qr-session")) {
				t.Fatal("failed QR persisted cookies")
			}
		})
	}
}
func TestQRRedirectPolicyAndImageValidation(t *testing.T) {
	for _, raw := range []string{"http://hongguoduanju.com/", "https://hongguoduanju.com.evil.test/", "https://evil.test/", "https://user@hongguoduanju.com/", "https://hongguoduanju.com:444/", "https://hongguoduanju.com/#fragment", "https://localhost/"} {
		u, _ := url.Parse(raw)
		if validQRRedirect(u) {
			t.Fatalf("unsafe redirect accepted: %s", raw)
		}
	}
	for _, raw := range []string{qrPassportBase + "/", "https://sso.hongguoduanju.com/", "https://hongguoduanju.com:443/"} {
		u, _ := url.Parse(raw)
		if !validQRRedirect(u) {
			t.Fatal("valid redirect rejected")
		}
	}
	for _, raw := range []string{"", "https://example.test/qrcode.png", "data:image/svg+xml;base64,PHN2Zy8+", strings.Repeat("A", (1<<20)+1)} {
		if qrImage(raw) != "" {
			t.Fatal("invalid QR image accepted")
		}
	}
	image := smsQRDataURL("1060000", "ONLY-FIXTURE")
	if qrImage(image) != image {
		t.Fatal("valid PNG rejected")
	}
	c := newQRPassportClient()
	var requests atomic.Int32
	c.http.Transport = qrFixtureTransport(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"/loop"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
	})
	if err := c.redirect(context.Background(), qrPassportBase+"/loop"); err == nil || requests.Load() != 5 {
		t.Fatal("redirect loop was not bounded")
	}
	now := time.Unix(1800000000, 0)
	for _, value := range []any{nil, json.Number("180"), json.Number("1800000180"), json.Number("1800000180000")} {
		if got := qrExpiry(value, now).Sub(now); got != 180*time.Second {
			t.Fatalf("incorrect QR deadline: %v %s", value, got)
		}
	}
}
func TestQRHTTPRoutesAndLegacyPhoneAccount(t *testing.T) {
	m := fixtureAccount(t, func(w http.ResponseWriter, r *http.Request) { accountFixtureResponse(w, r.URL.Path, false) })
	useQRFixture(t, m, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "get_qrcode") {
			qrFixtureStart(w, 180)
		} else {
			ioJSON(w, `{"message":"success","data":{"status":1}}`)
		}
	})
	s := &server{accounts: m}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.account(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		return w
	}
	for _, input := range []struct {
		method, path, body string
		code               int
	}{
		{"GET", "/api/v1/account/qr/start", "", 405},
		{"POST", "/api/v1/account/qr/start", `{"token":"no"}`, 400},
		{"POST", "/api/v1/account/qr/start", `{} {}`, 400},
		{"POST", "/api/v1/account/qr/cancel", `{"id":"short"}`, 400},
		{"GET", "/api/v1/account/qr/status?id=stale", "", 409},
	} {
		if w := request(input.method, input.path, input.body); w.Code != input.code {
			t.Errorf("route %s: %d", input.path, w.Code)
		}
	}
	w := request("POST", "/api/v1/account/qr/start", `{}`)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("QR start HTTP failed")
	}
	first := m.status().QRLogin.ID
	// Entering the existing phone flow cancels QR without changing its wire protocol.
	if err := m.sendCode(context.Background(), "13800000000"); err != nil {
		t.Fatal(err)
	}
	if err := m.loginSMS(context.Background(), "13800000000", "123456"); err != nil {
		t.Fatal(err)
	}
	if !m.status().LoggedIn || m.status().LoginMethod != "phone" {
		t.Fatal("phone login regressed")
	}
	m.cancelQR(first)
	if !m.status().LoggedIn {
		t.Fatal("late QR cancel logged out phone account")
	}
	m.mu.Lock()
	m.disk.LoginMethod = ""
	err := m.saveDisk(m.disk)
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := newAccountManager(m.dir, m.guest, nil)
	if err != nil || reloaded.status().LoginMethod != "phone" {
		t.Fatal("legacy phone account compatibility failed")
	}
}
