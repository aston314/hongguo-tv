package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image/png"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"
)

const qrPassportBase = "https://hongguoduanju.com"
const qrPassportUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

const qrPollInterval = 1800 * time.Millisecond

type qrLoginStatus struct {
	ID        string `json:"id"`
	State     string `json:"state"`
	Image     string `json:"image,omitempty"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
	Error     string `json:"error,omitempty"`
}
type qrLoginAttempt struct {
	status     qrLoginStatus
	generation uint64
	cancel     context.CancelFunc
}
type qrPassportClient struct{ http *http.Client }

func newQRPassportClient() *qrPassportClient {
	jar, _ := cookiejar.New(nil)
	return &qrPassportClient{http: &http.Client{Timeout: 12 * time.Second, Jar: jar,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func validQRRedirect(u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "hongguoduanju.com" || strings.HasSuffix(host, ".hongguoduanju.com")
}
func (c *qrPassportClient) request(ctx context.Context, target *url.URL) (*http.Response, error) {
	if !validQRRedirect(target) {
		return nil, errors.New("登录确认跳转地址无效")
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, errors.New("扫码请求地址无效")
	}
	r.Header.Set("User-Agent", qrPassportUA)
	r.Header.Set("Referer", qrPassportBase+"/")
	r.Header.Set("Origin", qrPassportBase)
	r.Header.Set("Accept", "application/json, text/javascript")
	response, err := c.http.Do(r)
	if err != nil {
		return nil, errors.New("扫码登录连接失败，请重试")
	}
	return response, nil
}
func (c *qrPassportClient) json(ctx context.Context, path string, params url.Values) (map[string]any, error) {
	target, _ := url.Parse(qrPassportBase + path)
	q := url.Values{"aid": {"513755"}, "passport_jssdk_version": {"3.4.10"}, "passport_jssdk_type": {"normal"}, "account_sdk_source": {"web"}, "is_from_ttaccountsdk": {"1"}, "language": {"zh"}}
	for k, v := range params {
		q[k] = v
	}
	target.RawQuery = q.Encode()
	response, err := c.request(ctx, target)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("扫码登录服务暂不可用，请重试")
	}
	b, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	if err != nil || len(b) > 2<<20 {
		return nil, errors.New("扫码登录响应读取失败")
	}
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.UseNumber()
	if decoder.Decode(&payload) != nil || decoder.Decode(&struct{}{}) != io.EOF || !passportSuccess(payload) {
		return nil, errors.New("扫码登录响应无效，请重新获取二维码")
	}
	if code := asString(payload["code"]); code != "" && code != "0" {
		return nil, errors.New("扫码登录请求未完成，请重试")
	}
	return passportData(payload), nil
}
func qrImage(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "data:image/png;base64,") {
		value = strings.TrimPrefix(value, "data:image/png;base64,")
	}
	if len(value) > 1<<20 {
		return ""
	}
	b, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return ""
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width < 32 || cfg.Height < 32 || cfg.Width > 2048 || cfg.Height > 2048 {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b)
}
func qrExpiry(value any, now time.Time) time.Time {
	seconds := accountEpoch(value)
	if seconds > 1_000_000_000_000 {
		seconds = seconds/1000 - now.Unix()
	} else if seconds > 1_000_000_000 {
		seconds -= now.Unix()
	}
	if seconds == 0 && (value == nil || asString(value) == "") {
		seconds = 180
	}
	if seconds < 0 {
		seconds = 0
	}
	if seconds > 600 {
		seconds = 600
	}
	return now.Add(time.Duration(seconds) * time.Second)
}
func (c *qrPassportClient) redirect(ctx context.Context, value string) error {
	target, err := url.Parse(value)
	base, _ := url.Parse(qrPassportBase + "/")
	if err != nil {
		return errors.New("登录确认跳转地址无效")
	}
	target = base.ResolveReference(target)
	for count := 0; count < 5; count++ {
		response, err := c.request(ctx, target)
		if err != nil {
			return err
		}
		response.Body.Close()
		switch response.StatusCode {
		case 301, 302, 303, 307, 308:
			next, parseErr := url.Parse(response.Header.Get("Location"))
			if parseErr != nil || response.Header.Get("Location") == "" {
				return errors.New("登录确认跳转地址无效")
			}
			target = target.ResolveReference(next)
		case http.StatusOK:
			return nil
		default:
			return errors.New("登录确认未完成，请重新扫码")
		}
	}
	return errors.New("登录确认跳转次数过多")
}
func (m *accountManager) cancelQRLocked() {
	if m.qrLogin == nil {
		return
	}
	m.qrLogin.cancel()
	if m.qrLogin.status.State != "signed_in" {
		m.qrLogin.status.State = "cancelled"
	}
	m.qrLogin.status.Image = ""
	m.qrLogin.status.Error = ""
}
func (m *accountManager) startQR() (accountStatus, error) {
	var key [16]byte
	if _, err := rand.Read(key[:]); err != nil {
		return accountStatus{}, errors.New("扫码会话创建失败")
	}
	m.mu.Lock()
	if m.disk.Profile != nil {
		m.mu.Unlock()
		return accountStatus{}, errors.New("请先退出当前账号")
	}
	m.cancelQRLocked()
	if m.login != nil && m.login.cancelRequest != nil {
		m.login.cancelRequest()
	}
	m.generation++
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	a := &qrLoginAttempt{status: qrLoginStatus{ID: hex.EncodeToString(key[:]), State: "preparing"}, generation: m.generation, cancel: cancel}
	m.qrLogin = a
	m.login = nil
	m.busy = false
	m.phase = "qr"
	m.lastError = ""
	m.smsState = ""
	m.appCodeAllowed = false
	status := m.statusLocked()
	m.mu.Unlock()
	go m.runQR(ctx, a)
	return status, nil
}
func (m *accountManager) updateQR(a *qrLoginAttempt, update func(*qrLoginStatus)) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.qrLogin != a || m.generation != a.generation || m.disk.Profile != nil || a.status.State == "cancelled" {
		return false
	}
	update(&a.status)
	return true
}
func (m *accountManager) qrFailure(a *qrLoginAttempt, state, message string) {
	m.updateQR(a, func(s *qrLoginStatus) { s.State = state; s.Image = ""; s.Error = message })
}
func (m *accountManager) runQR(ctx context.Context, a *qrLoginAttempt) {
	defer a.cancel()
	client := m.newQRClient()
	data, err := client.json(ctx, "/passport/web/get_qrcode/", url.Values{"next": {qrPassportBase + "/"}})
	if err != nil {
		m.qrFailure(a, "failed", "二维码获取失败，请重试")
		return
	}
	token, image := asString(data["token"]), qrImage(asString(data["qrcode"]))
	if token == "" || len(token) > 8192 || image == "" {
		m.qrFailure(a, "failed", "二维码响应无效，请重试")
		return
	}
	expires := qrExpiry(data["expire_time"], time.Now())
	if !m.updateQR(a, func(s *qrLoginStatus) { s.State = "pending"; s.Image = image; s.ExpiresAt = expires.UnixMilli() }) {
		return
	}
	pollCtx, cancel := context.WithDeadline(ctx, expires)
	defer cancel()
	interval := m.qrPollEvery
	if interval <= 0 {
		interval = qrPollInterval
	}
	for {
		timer := time.NewTimer(interval)
		select {
		case <-pollCtx.Done():
			timer.Stop()
			if ctx.Err() == nil {
				m.qrFailure(a, "expired", "")
			}
			return
		case <-timer.C:
		}
		data, err = client.json(pollCtx, "/passport/web/check_qrconnect/", url.Values{"next": {qrPassportBase + "/"}, "token": {token}})
		if err != nil {
			if !m.updateQR(a, func(s *qrLoginStatus) { s.Error = "连接暂时中断，正在重试" }) {
				return
			}
			continue
		}
		if !m.updateQR(a, func(s *qrLoginStatus) { s.Error = "" }) {
			return
		}
		switch asString(data["status"]) {
		case "1", "pending", "":
		case "2", "scanned":
			m.updateQR(a, func(s *qrLoginStatus) { s.State = "scanned" })
		case "4", "cancelled":
			m.qrFailure(a, "cancelled", "")
			return
		case "5", "expired":
			m.qrFailure(a, "expired", "")
			return
		case "3", "confirmed":
			if !m.updateQR(a, func(s *qrLoginStatus) { s.State = "processing" }) {
				return
			}
			// Once confirmed, allow a bounded completion even near the QR deadline.
			completeCtx, completeCancel := context.WithTimeout(ctx, 45*time.Second)
			err = m.completeQR(completeCtx, a, client, asString(data["redirect_url"]))
			completeCancel()
			if err != nil {
				m.qrFailure(a, "failed", err.Error())
			}
			return
		default:
			m.qrFailure(a, "failed", "扫码状态已变化，请重新获取二维码")
			return
		}
	}
}
func (m *accountManager) completeQR(ctx context.Context, a *qrLoginAttempt, client *qrPassportClient, redirect string) error {
	if redirect != "" {
		if err := client.redirect(ctx, redirect); err != nil {
			return err
		}
	}
	base, _ := url.Parse(qrPassportBase + "/")
	cookies := map[string]string{}
	for _, c := range client.http.Jar.Cookies(base) {
		cookies[c.Name] = c.Value
	}
	if cookies["sessionid"] == "" && cookies["sessionid_ss"] == "" {
		return errors.New("扫码确认未取得会话，请重新扫码")
	}
	data, err := client.json(ctx, "/passport/account/info/v2/", nil)
	if err != nil {
		return errors.New("扫码账号核验失败，请重新扫码")
	}
	uid, err := passportLoginUID(map[string]any{"message": "success", "data": data})
	if err != nil {
		return errors.New("扫码账号身份无效，请重新扫码")
	}
	device, err := newPassportDevice()
	if err != nil {
		return err
	}
	c := m.newClient(accountSession{DeviceID: miniReelRandomID(), InstallID: miniReelRandomID(), Cookies: map[string]string{}, Device: device})
	if err = c.registerDevice(ctx); err != nil {
		return errors.New("扫码账号设备初始化失败，请重试")
	}
	// Registration is anonymous; transfer the verified website session afterwards.
	for _, cookie := range client.http.Jar.Cookies(base) {
		if cookie.Name != "install_id" {
			c.session.Cookies[cookie.Name] = cookie.Value
		}
	}
	profile := &accountProfile{UID: uid, Name: strings.TrimSpace(firstNonEmpty(data["name"], data["screen_name"], data["username"])), Avatar: asString(data["avatar_url"])}
	if profile.Name == "" {
		profile.Name = "红果用户"
	}
	return m.finishAccountSession(ctx, a.generation, c.session, profile, "qr")
}
func (m *accountManager) cancelQR(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.qrLogin == nil || m.qrLogin.status.ID != id || m.disk.Profile != nil {
		return
	}
	m.generation++
	m.cancelQRLocked()
	m.phase = "phone"
	m.lastError = ""
}
func (s *server) accountQR(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/v1/account/qr/status" && r.Method == http.MethodGet {
		status := s.accounts.status()
		if status.QRLogin == nil || status.QRLogin.ID != r.URL.Query().Get("id") {
			writeError(w, 409, "扫码会话已失效")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "data": status})
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, 405, "method not allowed")
		return
	}
	var input struct {
		ID string `json:"id"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(&struct{}{}) != io.EOF {
		writeError(w, 400, "扫码请求无效")
		return
	}
	var err error
	switch r.URL.Path {
	case "/api/v1/account/qr/start":
		var status accountStatus
		status, err = s.accounts.startQR()
		if err == nil {
			writeJSON(w, 200, map[string]any{"ok": true, "data": status})
			return
		}
	case "/api/v1/account/qr/cancel":
		if len(input.ID) != 32 {
			writeError(w, 400, "扫码会话无效")
			return
		}
		s.accounts.cancelQR(input.ID)
	default:
		writeError(w, 404, "not found")
		return
	}
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "data": s.accounts.status()})
}
