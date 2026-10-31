package main

// Anonymous device bootstrap, matched to the desktop device_register protocol.
// Registration never includes a phone number, login code, or account token.
import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

const passportDeviceAPI = "https://log.snssdk.com"

type passportDevice struct {
	CDID       string `json:"cdid"`
	ClientUDID string `json:"clientudid"`
	OpenUDID   string `json:"openudid"`
	Created    int64  `json:"created"`
}

func passportUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", errors.New("设备身份生成失败")
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

func newPassportDevice() (*passportDevice, error) {
	cdid, err := passportUUID()
	if err != nil {
		return nil, err
	}
	client, err := passportUUID()
	if err != nil {
		return nil, err
	}
	var open [8]byte
	if _, err := rand.Read(open[:]); err != nil {
		return nil, errors.New("设备身份生成失败")
	}
	return &passportDevice{CDID: cdid, ClientUDID: client, OpenUDID: hex.EncodeToString(open[:]), Created: time.Now().UnixMilli()}, nil
}

func passportDeviceKey(seed []byte) [64]byte {
	h := sha512.Sum512(seed)
	salt := mustProtocolHex("4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58")
	return sha512.Sum512(append(h[:], salt...))
}

func passportTTEncrypt(plain, seed []byte) ([]byte, error) {
	if len(seed) != 32 {
		return nil, errors.New("设备加密参数无效")
	}
	var out bytes.Buffer
	w, err := gzip.NewWriterLevel(&out, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err = w.Write(plain); err != nil {
		return nil, err
	}
	if err = w.Close(); err != nil {
		return nil, err
	}
	z := out.Bytes()
	// TTEncrypt V5 uses this deterministic ten-byte gzip header.
	copy(z, []byte{0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0})
	hash := sha512.Sum512(z)
	p := append(hash[:], z...)
	padding := aes.BlockSize - len(p)%aes.BlockSize
	p = append(p, bytes.Repeat([]byte{byte(padding)}, padding)...)
	key := passportDeviceKey(seed)
	block, err := aes.NewCipher(key[:16])
	if err != nil {
		return nil, err
	}
	cipher.NewCBCEncrypter(block, key[16:32]).CryptBlocks(p, p)
	b := append([]byte{0x74, 0x63, 5, 0x10, 0, 0}, seed...)
	return append(b, p...), nil
}

func passportTTDecrypt(b []byte) ([]byte, error) {
	if len(b) < 38+80 || !bytes.Equal(b[:6], []byte{0x74, 0x63, 5, 0x10, 0, 0}) || (len(b)-38)%16 != 0 {
		return nil, errors.New("设备注册加密响应无效")
	}
	key := passportDeviceKey(b[6:38])
	block, _ := aes.NewCipher(key[:16])
	p := append([]byte(nil), b[38:]...)
	cipher.NewCBCDecrypter(block, key[16:32]).CryptBlocks(p, p)
	padding := int(p[len(p)-1])
	if padding < 1 || padding > 16 || !bytes.Equal(p[len(p)-padding:], bytes.Repeat([]byte{byte(padding)}, padding)) {
		return nil, errors.New("设备注册加密响应无效")
	}
	p = p[:len(p)-padding]
	if len(p) < 64 {
		return nil, errors.New("设备注册加密响应无效")
	}
	hash := sha512.Sum512(p[64:])
	if !bytes.Equal(hash[:], p[:64]) {
		return nil, errors.New("设备注册响应校验失败")
	}
	g, err := gzip.NewReader(bytes.NewReader(p[64:]))
	if err != nil {
		return nil, errors.New("设备注册响应解压失败")
	}
	defer g.Close()
	out, err := io.ReadAll(io.LimitReader(g, (4<<20)+1))
	if err != nil || len(out) > 4<<20 {
		return nil, errors.New("设备注册响应解压失败")
	}
	return out, nil
}

func (d *passportDevice) payload(stamp int64) []byte {
	// Keep the same app/device profile as passportQuery and the Medusa signer.
	h := map[string]any{
		"aid": 8662, "access": "wifi", "app_version": "7.3.5.32", "app_version_minor": "", "channel": "update_64",
		"device_brand": "Redmi", "device_manufacturer": "Redmi", "device_model": "25053RT47C", "device_category": "phone", "device_platform": "android",
		"os": "Android", "os_api": 36, "os_version": "16", "density_dpi": 520, "display_density": "xxxhdpi", "resolution": "2772x1280",
		"language": "zh", "timezone": 8, "tz_name": "Asia/Shanghai", "tz_offset": 28800, "region": "CN", "package": "com.phoenix.read",
		"version_code": 73532, "manifest_version_code": 73532, "update_version_code": 73532, "apk_first_install_time": d.Created,
		"cdid": d.CDID, "clientudid": d.ClientUDID, "openudid": d.OpenUDID, "cpu_abi": "arm64-v8a", "display_name": "红果短剧",
		"sdk_version": "3.7.2", "sdk_target_version": 29, "sdk_flavor": "china", "guest_mode": 0, "is_system_app": 0, "not_request_sender": 0, "oaid_may_support": true,
		"ipv6_list": []string{}, "sim_serial_number": []string{},
		"custom": map[string]any{"is_android_fold": 0, "filter_warn": 0, "web_ua": "", "is_android_pad": 0, "client_ipv4": ""},
	}
	b, _ := json.Marshal(map[string]any{"magic_tag": "ss_app_log", "header": h, "_gen_time": stamp})
	return b
}

func (c *passportClient) registerDevice(ctx context.Context) (err error) {
	started := time.Now()
	diagnostic := playbackPreparationDiagnostic{Code: "DEVICE_REGISTER_FAILED", Stage: "device_register"}
	defer func() { err = finishPlaybackPreparation(err, diagnostic, started) }()
	if c.session.Registered && validID(c.session.DeviceID) && validID(c.session.InstallID) {
		return nil
	}
	if c.session.Device == nil {
		return errors.New("设备身份尚未准备")
	}
	now := time.Now()
	stamp := now.UnixMilli()
	var seed [32]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return errors.New("设备加密参数生成失败")
	}
	body, err := passportTTEncrypt(c.session.Device.payload(stamp), seed[:])
	if err != nil {
		return errors.New("设备注册请求生成失败")
	}
	q := passportQuery(c.session)
	q.Del("device_id")
	q.Del("iid")
	q.Set("tt_data", "a")
	q.Set("ts", strconv.FormatInt(now.Unix(), 10))
	q.Set("_rticket", strconv.FormatInt(stamp, 10))
	q.Set("package", "com.phoenix.read")
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, c.deviceBase+"/service/2/device_register/?"+q.Encode(), bytes.NewReader(body))
	if err != nil {
		return errors.New("设备注册地址无效")
	}
	for k, v := range map[string]string{
		"User-Agent": defaultHongguoUA, "Content-Type": "application/octet-stream;tt-data=a", "Accept": "application/json; charset=utf-8,application/x-protobuf",
		"Content-Encoding": "gzip", "X-Tt-Request-Tag": "t=0;n=1", "Log-Encode-Type": "gzip", "Lc": "102", "Sdk-Version": "2",
		"Passport-Sdk-Version": "60755", "Passport-Sdk-Settings": "device_transfer_s_0,device_transfer_ab_1", "X-SS-DP": "8662", "X-Vc-Bdturing-Sdk-Version": "4.0.3.cn",
		"X-Tt-Store-Region": "cn", "X-Tt-Store-Region-Src": "did", "X-Khronos": strconv.FormatInt(now.Unix(), 10),
		"X-Argus": base64.StdEncoding.EncodeToString(protocolLE(uint32(now.Unix()))), "X-SS-Req-Ticket": q.Get("_rticket"),
	} {
		r.Header.Set(k, v)
	}
	m := md5.Sum(body)
	r.Header.Set("X-SS-STUB", hex.EncodeToString(m[:]))
	nonce, err := protocolRandom()
	if err != nil {
		return errors.New("设备签名参数生成失败")
	}
	r.Header.Set("X-Gorgon", passportGorgon(q.Encode(), body, uint32(now.Unix()), uint16(nonce)))
	// No account cookies/token are sent to the registration host.
	resp, err := c.http.Do(r)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("设备注册连接失败，请稍后重试")
	}
	defer resp.Body.Close()
	diagnostic.HTTPStatus = &resp.StatusCode
	diagnostic.Code = "DEVICE_REGISTER_HTTP"
	if resp.StatusCode != 200 {
		return fmt.Errorf("设备注册返回 HTTP %d", resp.StatusCode)
	}
	diagnostic.Code = "DEVICE_REGISTER_READ"
	b, err := io.ReadAll(io.LimitReader(resp.Body, (4<<20)+1))
	if err != nil || len(b) > 4<<20 {
		return errors.New("设备注册响应读取失败")
	}
	responseBytes := len(b)
	diagnostic.ResponseBytes = &responseBytes
	diagnostic.Code = "DEVICE_REGISTER_INVALID"
	if bytes.HasPrefix(b, []byte{0x74, 0x63, 5, 0x10, 0, 0}) {
		b, err = passportTTDecrypt(b)
		if err != nil {
			return err
		}
	}
	var p map[string]any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if dec.Decode(&p) != nil || p == nil || dec.Decode(&struct{}{}) != io.EOF {
		return errors.New("设备注册响应无效")
	}
	getID := func(a, b string) string {
		x := asString(p[a])
		if x == "" {
			x = asString(p[b])
		}
		return x
	}
	did, iid := getID("device_id_str", "device_id"), getID("install_id_str", "install_id")
	if !validID(did) || !validID(iid) || did == "0" || iid == "0" {
		return errors.New("设备注册未返回有效身份")
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	c.session.DeviceID, c.session.InstallID, c.session.Registered = did, iid, true
	for _, cookie := range resp.Cookies() {
		switch cookie.Name {
		case "store-region", "store-region-src", "ttreq", "odin_tt":
			if cookie.MaxAge >= 0 {
				c.session.Cookies[cookie.Name] = cookie.Value
			}
		}
	}
	c.session.Cookies["install_id"] = iid
	return nil
}

type passportHTTPError struct{ Status, RetryAfter int }

func (e *passportHTTPError) Error() string {
	if e.Status == http.StatusForbidden {
		return "红果账号服务拒绝了请求（HTTP 403）"
	}
	return fmt.Sprintf("红果账号服务返回 HTTP %d", e.Status)
}
func newPassportHTTPError(r *http.Response) *passportHTTPError {
	e := &passportHTTPError{Status: r.StatusCode}
	if n, err := strconv.Atoi(r.Header.Get("Retry-After")); err == nil && n > 0 && n <= 3600 {
		e.RetryAfter = n
	}
	if stamp, err := http.ParseTime(r.Header.Get("Retry-After")); err == nil {
		n := int(time.Until(stamp).Seconds()) + 1
		if n > 0 && n <= 3600 {
			e.RetryAfter = n
		}
	}
	return e
}
