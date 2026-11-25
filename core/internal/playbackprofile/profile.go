// SPDX-License-Identifier: GPL-3.0-only
// Data schema adapted from miaoxiaohu/hongguoTV 312e7f2 (PlaybackProfile.kt).
// This interpreter supplies values to fixed algorithms; it never executes code.
package playbackprofile

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const MaxBytes = 256 * 1024
const maxMessageBytes = 16 * 1024
const Version = "2026.11.25.1"

//go:embed builtin.json
var builtin []byte

func Builtin() []byte { return bytes.Clone(builtin) }

var ErrProfile = errors.New("PROFILE_REJECTED")

type Field struct {
	Tag     int             `json:"tag"`
	Type    string          `json:"type"`
	Value   json.RawMessage `json:"value"`
	ref     string
	literal any
}
type QueryField struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	When  string `json:"when"`
}
type Query struct {
	Fields []QueryField `json:"fields"`
}
type Gate struct {
	Host      string   `json:"host"`
	Hosts     []string `json:"hosts,omitempty"`
	Path      string   `json:"path"`
	UserAgent string   `json:"userAgent"`
}
type Medusa struct {
	Flags    string  `json:"flags"`
	Device   []Field `json:"device"`
	Env      []Field `json:"env"`
	EnvSub13 []Field `json:"envSub13"`
	Nested   []Field `json:"nested"`
	Message  []Field `json:"message"`
}
type V5 struct {
	Magic       string   `json:"magic"`
	License     string   `json:"license"`
	SignKey     string   `json:"signKey"`
	SBox        string   `json:"sbox"`
	Headers     []string `json:"headers"`
	DeviceLevel int      `json:"deviceLevel"`
	Medusa      Medusa   `json:"medusa"`
	Gates       struct {
		Model Gate `json:"model"`
		Tab   Gate `json:"tab"`
	} `json:"gates"`
	DeviceProfile Query  `json:"deviceProfile"`
	TabQuery      Query  `json:"tabQuery"`
	ModelBody     string `json:"modelBody"`
}
type Profile struct {
	Schema    int    `json:"schema"`
	Revision  int64  `json:"revision"`
	UpdatedAt string `json:"updatedAt"`
	Note      string `json:"note"`
	V5        V5     `json:"v5"`
}
type Process struct {
	Nonce        string
	Started, Now int64
	Launch, PID  uint32
}
type Pair struct{ Key, Value string }
type Signed struct {
	Query   string
	Headers map[string]string
}
type Request struct {
	Method, URL string
	Headers     map[string]string
	Body        []byte
}

var keyRE = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)
var idRE = regexp.MustCompile(`^[0-9]{1,32}$`)
var hostRE = regexp.MustCompile(`^(?:[a-z0-9-]+\.)*(?:fqnovel|snssdk)\.com$`)
var refs = map[string]string{"ts": "sint", "nowMs": "sint", "processStarted": "sint", "rand": "sint", "envLaunch": "sint", "envPid": "sint", "f13": "bytes", "query6": "bytes", "secToken": "string", "magic": "bytes", "license": "string", "flags": "bytes", "device": "bytes", "env": "bytes", "envSub13": "bytes", "nested": "bytes", "device_id": "string", "version_name": "string", "device_type": "string", "device_brand": "string", "os_version": "string", "channel": "string"}
var queryRefs = map[string]bool{"cdid": true, "iid": true, "device_id": true, "klink_egdi": true, "id": true, "device_level": true}

func ref(s string) string {
	if strings.HasPrefix(s, "${") && strings.HasSuffix(s, "}") {
		return s[2 : len(s)-1]
	}
	return ""
}
func strict(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	d.UseNumber()
	if e := d.Decode(v); e != nil {
		return ErrProfile
	}
	if d.Decode(new(any)) != io.EOF {
		return ErrProfile
	}
	return nil
}
func unhex(s string, n int) ([]byte, error) {
	b, e := hex.DecodeString(s)
	if e != nil || len(b) != n {
		return nil, ErrProfile
	}
	return b, nil
}

// Reject duplicate object keys as well as unknown fields, excessive nesting and size.
func uniqueJSON(b []byte) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 16 {
			return ErrProfile
		}
		t, e := d.Token()
		if e != nil {
			return ErrProfile
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		if delim == '{' {
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				s, ok := k.(string)
				if e != nil || !ok || seen[s] {
					return ErrProfile
				}
				seen[s] = true
				if e = walk(depth + 1); e != nil {
					return e
				}
			}
		} else if delim == '[' {
			for d.More() {
				if e = walk(depth + 1); e != nil {
					return e
				}
			}
		} else {
			return ErrProfile
		}
		_, e = d.Token()
		return e
	}
	if e := walk(0); e != nil {
		return ErrProfile
	}
	if _, e := d.Token(); e != io.EOF {
		return ErrProfile
	}
	return nil
}
func Parse(b []byte) (*Profile, error) { return ParseContext(context.Background(), b) }
func ParseContext(ctx context.Context, b []byte) (*Profile, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if len(b) == 0 || len(b) > MaxBytes || uniqueJSON(b) != nil {
		return nil, ErrProfile
	}
	var p Profile
	if strict(b, &p) != nil || p.Schema != 1 || p.Revision < 1 || p.Revision > 9007199254740991 {
		return nil, ErrProfile
	}
	v := &p.V5
	for _, x := range []struct {
		s string
		n int
	}{{v.Magic, 16}, {v.SignKey, 32}, {v.SBox, 1024}, {v.Medusa.Flags, 8}} {
		if _, e := unhex(x.s, x.n); e != nil {
			return nil, e
		}
	}
	if !regexp.MustCompile(`^[0-9]{1,20}$`).MatchString(v.License) || v.DeviceLevel < 0 || v.DeviceLevel > 5 || len(v.Headers) != 3 {
		return nil, ErrProfile
	}
	heads := map[string]bool{}
	for _, h := range v.Headers {
		if heads[h] || h != "x-khronos" && h != "x-helios" && h != "x-medusa" {
			return nil, ErrProfile
		}
		heads[h] = true
	}
	if len(v.Gates.Tab.Hosts) == 0 || len(v.Gates.Tab.Hosts) > 3 || len(v.Gates.Model.Hosts) != 0 || v.Gates.Model.Host == "" || v.Gates.Tab.Host != "" {
		return nil, ErrProfile
	}
	for _, g := range []Gate{v.Gates.Model, v.Gates.Tab} {
		hosts := g.Hosts
		if g.Host != "" {
			hosts = []string{g.Host}
		}
		for _, h := range hosts {
			if !hostRE.MatchString(h) {
				return nil, ErrProfile
			}
		}
		if len(g.UserAgent) == 0 || len(g.UserAgent) > 512 || strings.ContainsAny(g.UserAgent, "\r\n") {
			return nil, ErrProfile
		}
		if g.Path != "/novel/player/multi_video_model/player/v1" && g.Path != "/reading/bookapi/video_tab/multi_video_model/v1/" {
			return nil, ErrProfile
		}
	}
	if v.Gates.Model.Path != "/novel/player/multi_video_model/player/v1" || v.Gates.Tab.Path != "/reading/bookapi/video_tab/multi_video_model/v1/" {
		return nil, ErrProfile
	}
	device := map[string]bool{}
	for _, q := range []Query{v.DeviceProfile, v.TabQuery} {
		if len(q.Fields) == 0 || len(q.Fields) > 64 {
			return nil, ErrProfile
		}
		seen := map[string]bool{}
		for _, f := range q.Fields {
			if !keyRE.MatchString(f.Key) || f.Key == "_rticket" || seen[f.Key] || len(f.Value) > 1024 || strings.ContainsAny(f.Value, "\r\n") {
				return nil, ErrProfile
			}
			seen[f.Key] = true
			if f.When != "always" && f.When != "rom" && f.When != "nonEmpty" {
				return nil, ErrProfile
			}
			if r := ref(f.Value); r != "" {
				if !queryRefs[r] {
					return nil, ErrProfile
				}
			} else if strings.Contains(f.Value, "${") {
				return nil, ErrProfile
			}
		}
	}
	for _, f := range v.DeviceProfile.Fields {
		device[f.Key] = true
		if f.Key == "device_id" && f.Value != "${device_id}" || f.Key == "iid" && f.Value != "${iid}" || f.Key == "cdid" && f.Value != "${cdid}" {
			return nil, ErrProfile
		}
	}
	for _, name := range []string{"cdid", "iid", "device_id", "version_name", "device_type", "device_brand", "os_version", "channel"} {
		if !device[name] {
			return nil, ErrProfile
		}
	}
	tabID := false
	for _, f := range v.TabQuery.Fields {
		if device[f.Key] {
			return nil, ErrProfile
		}
		if f.Key == "video_id" && f.Value == "${id}" {
			tabID = true
		}
	}
	if !tabID {
		return nil, ErrProfile
	}
	available := map[string]bool{}
	for k := range refs {
		if k != "device" && k != "env" && k != "envSub13" && k != "nested" {
			available[k] = true
		}
	}
	tables := []struct {
		name   string
		fields *[]Field
	}{{"device", &v.Medusa.Device}, {"envSub13", &v.Medusa.EnvSub13}, {"env", &v.Medusa.Env}, {"nested", &v.Medusa.Nested}, {"message", &v.Medusa.Message}}
	for _, table := range tables {
		if len(*table.fields) == 0 || len(*table.fields) > 96 {
			return nil, ErrProfile
		}
		seen := map[int]bool{}
		for i := range *table.fields {
			f := &(*table.fields)[i]
			if f.Tag < 1 || f.Tag > 2047 || seen[f.Tag] {
				return nil, ErrProfile
			}
			seen[f.Tag] = true
			var value any
			d := json.NewDecoder(bytes.NewReader(f.Value))
			d.UseNumber()
			if d.Decode(&value) != nil {
				return nil, ErrProfile
			}
			if s, ok := value.(string); ok && ref(s) != "" {
				f.ref = ref(s)
				if refs[f.ref] != f.Type || !available[f.ref] {
					return nil, ErrProfile
				}
				continue
			}
			switch f.Type {
			case "sint":
				n, ok := value.(json.Number)
				if !ok {
					return nil, ErrProfile
				}
				x, e := n.Int64()
				if e != nil || x < -4503599627370495 || x > 4503599627370495 {
					return nil, ErrProfile
				}
				f.literal = x
			case "float":
				n, ok := value.(json.Number)
				if !ok {
					return nil, ErrProfile
				}
				x, e := n.Float64()
				if e != nil || math.IsInf(x, 0) || math.IsNaN(x) || math.Abs(x) > math.MaxFloat32 {
					return nil, ErrProfile
				}
				f.literal = x
			case "string":
				s, ok := value.(string)
				if !ok || len(s) > 4096 || strings.Contains(s, "${") {
					return nil, ErrProfile
				}
				f.literal = s
			case "bytes":
				s, ok := value.(string)
				if !ok || len(s) > 8192 {
					return nil, ErrProfile
				}
				x, e := hex.DecodeString(s)
				if e != nil {
					return nil, ErrProfile
				}
				f.literal = x
			default:
				return nil, ErrProfile
			}
		}
		available[table.name] = true
	}
	if len(v.ModelBody) > 8192 || !strings.Contains(v.ModelBody, "${id}") || !strings.Contains(v.ModelBody, "${device_level}") || !strings.Contains(v.ModelBody, "${content_type}") {
		return nil, ErrProfile
	}
	if _, e := p.Body("123", "1004"); e != nil {
		return nil, e
	}
	// Type/dependency checks above plus an actual dry signature cover every carrier.
	for i := int64(0); i < 4; i++ {
		stamp := int64(1800000000000) + i*1000
		for _, tab := range []bool{true, false} {
			values := p.Query(map[string]string{"device_id": "123", "iid": "456", "cdid": "synthetic"}, "789", tab)
			if _, e := p.Sign(ctx, values, nil, stamp, [4]uint32{1, 2, 3, 4}, Process{"ABBBBBBBBBBBBBBBBBBBBBBBB", stamp, stamp, 110, 11001}); e != nil {
				return nil, ErrProfile
			}
		}
	}
	return &p, nil
}
func (p *Profile) Query(identity map[string]string, id string, tab bool) []Pair {
	base := map[string]string{}
	for k, v := range identity {
		base[k] = v
	}
	base["id"] = id
	base["device_level"] = strconv.Itoa(p.V5.DeviceLevel)
	out := []Pair{}
	fields := append([]QueryField(nil), p.V5.DeviceProfile.Fields...)
	if tab {
		fields = append(fields, p.V5.TabQuery.Fields...)
	}
	for _, f := range fields {
		if f.When == "rom" && !tab {
			continue
		}
		value := f.Value
		if r := ref(value); r != "" {
			value = base[r]
		}
		if f.When == "nonEmpty" && value == "" {
			continue
		}
		out = append(out, Pair{f.Key, value})
	}
	return out
}
func (p *Profile) Body(id, content string) ([]byte, error) {
	if !idRE.MatchString(id) || !regexp.MustCompile(`^[0-9]{1,16}$`).MatchString(content) {
		return nil, ErrProfile
	}
	s := strings.NewReplacer("${id}", id, "${content_type}", content, "${device_level}", strconv.Itoa(p.V5.DeviceLevel)).Replace(p.V5.ModelBody)
	var body map[string]json.RawMessage
	if strings.Contains(s, "${") || uniqueJSON([]byte(s)) != nil || json.Unmarshal([]byte(s), &body) != nil {
		return nil, ErrProfile
	}
	var ids map[string][]string
	if json.Unmarshal(body["mixed_video_id_map"], &ids) != nil || len(ids) != 1 || len(ids[content]) != 1 || ids[content][0] != id {
		return nil, ErrProfile
	}
	return []byte(s), nil
}
func varint(out []byte, n uint64) []byte {
	for n > 127 {
		out = append(out, byte(n)|128)
		n >>= 7
	}
	return append(out, byte(n))
}
func encode(fields []Field, values map[string]any) ([]byte, error) {
	out := []byte{}
	for _, f := range fields {
		v := f.literal
		if f.ref != "" {
			v = values[f.ref]
		}
		switch f.Type {
		case "sint":
			n, ok := v.(int64)
			if !ok {
				return nil, ErrProfile
			}
			out = varint(out, uint64(f.Tag<<3))
			out = varint(out, uint64(n<<1)^uint64(n>>63))
		case "float":
			n, ok := v.(float64)
			if !ok {
				return nil, ErrProfile
			}
			out = varint(out, uint64(f.Tag<<3|5))
			out = binary.LittleEndian.AppendUint32(out, math.Float32bits(float32(n)))
		case "string", "bytes":
			var b []byte
			if f.Type == "bytes" {
				var ok bool
				b, ok = v.([]byte)
				if !ok {
					return nil, ErrProfile
				}
			} else {
				s, ok := v.(string)
				if !ok {
					return nil, ErrProfile
				}
				b = []byte(s)
			}
			if len(b) > maxMessageBytes-len(out)-8 {
				return nil, ErrProfile
			}
			if len(b) > 0 {
				out = varint(out, uint64(f.Tag<<3|2))
				out = varint(out, uint64(len(b)))
				out = append(out, b...)
			}
		}
		if len(out) > maxMessageBytes {
			return nil, ErrProfile
		}
	}
	return out, nil
}
func escape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(s), "+", "%20"), "%2A", "*")
}
func (p *Profile) Sign(ctx context.Context, pairs []Pair, body []byte, stamp int64, n [4]uint32, process Process) (Signed, error) {
	ts := uint32(stamp / 1000)
	m := md5.Sum(body)
	var q [32]byte
	query := ""
	matched := false
	for offset := int64(0); offset < 1024; offset++ {
		if ctx.Err() != nil {
			return Signed{}, ctx.Err()
		}
		parts := make([]string, 0, len(pairs)+1)
		for _, v := range pairs {
			parts = append(parts, v.Key+"="+escape(v.Value))
		}
		parts = append(parts, "_rticket="+strconv.FormatInt(stamp+offset, 10))
		query = strings.Join(parts, "&")
		q = passportSM3([]byte(query))
		iv := passportIV(protocolLE(ts), passportIV(m[:], passportIV(q[:], 0x20230928)))
		if iv&15 == 12 {
			matched = true
			break
		}
	}
	if !matched {
		return Signed{}, ErrProfile
	}
	spec := p.V5
	magic, _ := hex.DecodeString(spec.Magic)
	flags, _ := hex.DecodeString(spec.Medusa.Flags)
	key, _ := hex.DecodeString(spec.SignKey)
	sbox, _ := hex.DecodeString(spec.SBox)
	f13 := playbackV5F13(q, m, ts)
	token := process.Nonce
	if len(token) != 25 || token[0] != 'A' {
		token = "A" + (token + strings.Repeat("A", 24))[:24]
	}
	values := map[string]any{}
	for _, pair := range pairs {
		values[pair.Key] = pair.Value
	}
	for k, v := range map[string]any{"ts": int64(ts), "nowMs": process.Now, "processStarted": process.Started, "rand": int64(n[0]), "envLaunch": int64(process.Launch), "envPid": int64(process.PID), "f13": f13, "query6": q[:6], "secToken": token, "magic": magic, "license": spec.License, "flags": flags} {
		values[k] = v
	}
	for _, t := range []struct {
		name   string
		fields []Field
	}{{"device", spec.Medusa.Device}, {"envSub13", spec.Medusa.EnvSub13}, {"env", spec.Medusa.Env}, {"nested", spec.Medusa.Nested}, {"message", spec.Medusa.Message}} {
		b, e := encode(t.fields, values)
		if e != nil {
			return Signed{}, e
		}
		values[t.name] = b
	}
	message := values["message"].([]byte)
	if len(message) < 4 {
		return Signed{}, ErrProfile
	}
	hash := passportSM3(append(append(append([]byte(nil), key...), protocolLE(n[1])...), key...))
	high := (n[1] >> 16) & 255
	seed := protocolLE(^(((high << 11) | (n[1] >> 24)) ^ (high >> 5) ^ high))
	transformed := append(append([]byte(nil), flags...), passportXMXOR(message, hash[:])...)
	for i, j := 0, len(transformed)-1; i < j; i, j = i+1, j-1 {
		transformed[i], transformed[j] = transformed[j], transformed[i]
	}
	for i := range transformed {
		transformed[i] ^= seed[(^i)&3]
	}
	check := uint32(0x18000001) | (uint32(q[0]&63) << 14) | (uint32(f13[0]&63) << 8)
	packed := append(append(append([]byte{0xca}, protocolLE(n[2])...), protocolLE(check)...), transformed...)
	packed = append(packed, protocolLE(n[1])[2:]...)
	a, iv := md5.Sum(key[:16]), md5.Sum(key[16:])
	encrypted, e := playbackV5AES(packed, ts, a[:], iv[:], sbox)
	if e != nil {
		return Signed{}, ErrProfile
	}
	prefix := append(protocolLE(5), magic...)
	for i := range prefix {
		prefix[i] ^= protocolLE(ts)[i&3]
	}
	prefix = append(prefix, byte(n[1]), byte(n[1]>>8), 0, 1)
	return Signed{query, map[string]string{"X-Khronos": strconv.FormatUint(uint64(ts), 10), "X-Helios": playbackV5Helios(ts, n[3], spec.License), "X-Medusa": base64.StdEncoding.EncodeToString(append(prefix, encrypted...))}}, nil
}
func Random() ([4]uint32, error) {
	var b [16]byte
	_, e := rand.Read(b[:])
	var n [4]uint32
	for i := range n {
		n[i] = binary.LittleEndian.Uint32(b[i*4:])
	}
	return n, e
}
func NewProcess() (Process, error) {
	var b [18]byte
	_, e := rand.Read(b[:])
	return Process{Nonce: base64.RawURLEncoding.EncodeToString(b[:]), Started: time.Now().UnixMilli()}, e
}
func (p *Profile) String() string { return fmt.Sprintf("playback-profile schema=%d", p.Schema) }
