// SPDX-License-Identifier: GPL-3.0-only
// v5 protocol port from N3urda/hongguoTV commit 18c37c2 (Signer.kt,
// AesV3.kt, V5Constants.kt), itself derived from drpys 22261ad.
// Playback-only: never change the passport/account signing profile here.
package main

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/bits"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const playbackV5License = "646637794"

// Unlike the old passport profile this is the F13 branch with low nibble 12.
func playbackV5F13(q [32]byte, m [16]byte, ts uint32) []byte {
	const seed uint32 = 0x9d4a97c2
	count := seed + ts
	data := append(append(append([]byte(nil), q[:]...), m[:]...), protocolLE(ts)...)
	for _, x := range []byte{0xfa, 0x45, 0x61, 0xd7} {
		data = append(data, byte((uint16(x)*257)>>((count+2)&7)))
	}
	data = append(data, 0, 0, 0, 0, 0, 0, 1, 0xa0)
	var words [128]uint32
	for i := 0; i < 16; i++ {
		words[i] = binary.BigEndian.Uint32(data[i*4:])
	}
	for i := 0; i < 112; i++ {
		x, y := words[i+1], words[i+14]
		words[i+16] = words[i] + words[i+9] + (bits.RotateLeft32(x, 14) ^ bits.RotateLeft32(x, 25) ^ (x >> 3)) + (bits.RotateLeft32(y, 13) ^ bits.RotateLeft32(y, 15) ^ (y >> 10))
	}
	initial := [8]uint32{0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f, 984304912, 3005047866, 2874125293, 2152413264}
	for i := range initial {
		initial[i] = bits.RotateLeft32(initial[i], -int(count&31))
	}
	d := initial
	for i := uint32(0); i < 96; i++ {
		base := seed + i
		n1 := ((d[4] ^ d[0]) & d[1]) ^ d[4]
		n2 := bits.RotateLeft32(d[1], 26) ^ bits.RotateLeft32(d[1], 21) ^ bits.RotateLeft32(d[1], 7)
		n4 := words[base&127] + n1 + n2 + bits.RotateLeft32(playbackV5HashTable[base&63], -int((count+1)&31)) + d[6]
		n5 := bits.RotateLeft32(d[3], 30) ^ bits.RotateLeft32(d[3], 19) ^ bits.RotateLeft32(d[3], 10)
		n6 := (d[3] & d[5]) | ((d[3] | d[5]) & d[2])
		old := d[7]
		for j := 7; j > 0; j-- {
			d[j] = d[j-1]
		}
		d[7] = n5 + n6 + n4
		d[0] = old + n4
	}
	var ret [32]byte
	for i := range d {
		binary.BigEndian.PutUint32(ret[i*4:], d[i]+initial[i])
	}
	out := make([]byte, 16, 20)
	for i := range out {
		out[i] = ret[i] ^ ret[i+16]
	}
	check := uint32(0x20220420)
	for i, x := range out[:12] {
		if i&1 == 0 {
			check = (check >> 3) ^ check ^ uint32(x) ^ (check << 7)
		} else {
			check = (check >> 5) ^ check ^ ^(uint32(x) | (check << 11))
		}
	}
	return append(out, protocolLE(((check|4)^0x1000000)|0x20)...)
}

type playbackV5Process struct {
	nonce   string
	started int64
}

var playbackV5ProcessOnce = sync.OnceValues(func() (playbackV5Process, error) {
	var nonce [18]byte
	_, err := rand.Read(nonce[:])
	return playbackV5Process{nonce: base64.RawURLEncoding.EncodeToString(nonce[:]), started: time.Now().UnixMilli()}, err
})

func playbackV5Proto(values url.Values, ts, nonce uint32, q [32]byte, f13 []byte, process playbackV5Process) []byte {
	var device, env, count, p protocolProto
	device.sint(1, 1)
	device.sint(2, 2)
	device.text(3, "8662")
	device.text(4, values.Get("device_id"))
	device.text(5, process.nonce)
	device.text(6, "!noperm!")
	device.text(12, "Asia/Shanghai,8")
	device.text(13, "zh_CN")
	device.text(22, values.Get("os_version"))
	device.sint(25, process.started)
	device.text(30, values.Get("device_type"))
	device.text(31, "HONOR")
	device.text(32, values.Get("device_type"))
	device.text(34, "HONOR")
	env.text(6, "v04.10.03.04-bugfix")
	env.text(8, values.Get("channel"))
	env.blob(12, device)
	env.text(14, values.Get("version_name"))
	for _, f := range []int{1, 2, 3, 5} {
		count.sint(f, 1)
	}
	p.blob(1, playbackV5Magic)
	p.sint(2, 5)
	p.sint(3, int64(nonce))
	p.text(4, "8662")
	p.text(5, values.Get("device_id"))
	p.text(6, playbackV5License)
	p.text(7, values.Get("version_name"))
	p.text(8, "v04.10.03-ml-android")
	p.sint(9, 0x040a0300)
	p.blob(10, make([]byte, 8))
	p.sint(12, int64(ts))
	p.blob(13, f13)
	p.blob(14, q[:6])
	p.blob(15, count)
	p.sint(17, int64(ts))
	p.text(20, "none")
	// v04.10.03 expects wire value 738; the former 754 returns HTTP 200 / an empty body.
	p.sint(21, 369)
	p.blob(23, env)
	p.text(24, `{"cmr":16777216,"cmr2":16777216,"un_h":11,"vpn":0,"kd":0,"dyn":"","do":1,"tk":true}`)
	return p
}

func playbackV5Medusa(values url.Values, ts uint32, q [32]byte, m [16]byte, n [3]uint32, process playbackV5Process) (string, error) {
	f13 := playbackV5F13(q, m, ts)
	message := playbackV5Proto(values, ts, n[0], q, f13, process)
	key := passportSM3(append(append(append([]byte(nil), playbackV5Key...), protocolLE(n[1])...), playbackV5Key...))
	high := (n[1] >> 16) & 255
	seed := protocolLE(^(((high << 11) | (n[1] >> 24)) ^ (high >> 5) ^ high))
	p := append(make([]byte, 8), passportXMXOR(message, key[:])...)
	for i, j := 0, len(p)-1; i < j; i, j = i+1, j-1 {
		p[i], p[j] = p[j], p[i]
	}
	for i := range p {
		p[i] ^= seed[(^i)&3]
	}
	check := uint32(0x18000001) | (uint32(q[0]&63) << 14) | (uint32(f13[0]&63) << 8)
	packed := append(append(append([]byte{0xca}, protocolLE(n[2])...), protocolLE(check)...), p...)
	packed = append(packed, protocolLE(n[1])[2:]...)
	aesKey, iv := md5.Sum(playbackV5Key[:16]), md5.Sum(playbackV5Key[16:])
	encrypted, err := playbackV5AES(packed, ts, aesKey[:], iv[:])
	if err != nil {
		return "", err
	}
	header := append(protocolLE(5), playbackV5Magic...)
	for i := range header {
		header[i] ^= protocolLE(ts)[i&3]
	}
	header = append(header, byte(n[1]), byte(n[1]>>8), 0, 1)
	return base64.StdEncoding.EncodeToString(append(header, encrypted...)), nil
}

// Helios' 64-bit rounds are unchanged, but the v5 license is not the account license.
func playbackV5Helios(ts, nonce uint32) string {
	key := md5.Sum(append(protocolLE(nonce), []byte("8662")...))
	raw := []byte(hex.EncodeToString(key[:]))
	k := binary.LittleEndian.Uint64(raw)
	pending := [3]uint64{binary.LittleEndian.Uint64(raw[8:]), binary.LittleEndian.Uint64(raw[16:]), binary.LittleEndian.Uint64(raw[24:])}
	var rounds [34]uint64
	for i := range rounds {
		rounds[i] = k
		x := (bits.RotateLeft64(pending[0], -8) + k) ^ uint64(i)
		pending = [3]uint64{pending[1], pending[2], x}
		k = x ^ bits.RotateLeft64(k, 3)
	}
	plain := playbackPad([]byte(strconv.FormatUint(uint64(ts), 10) + "-" + playbackV5License + "-8662"))
	out := protocolLE(nonce)
	for at := 0; at < len(plain); at += 16 {
		a, b := binary.LittleEndian.Uint64(plain[at:]), binary.LittleEndian.Uint64(plain[at+8:])
		for _, r := range rounds {
			b = r ^ (a + bits.RotateLeft64(b, -8))
			a = b ^ bits.RotateLeft64(a, 3)
		}
		out = binary.LittleEndian.AppendUint64(out, a)
		out = binary.LittleEndian.AppendUint64(out, b)
	}
	return base64.StdEncoding.EncodeToString(out)
}

// The ordered query matches the mobile request. Only _rticket may be tuned;
// the final query and the exact compressed body are signed together.
func playbackV5Tune(values url.Values, body []byte, stamp int64) (string, [32]byte, [16]byte, error) {
	keys := []string{"aid", "app_name", "version_code", "version_name", "manifest_version_code", "channel", "device_platform", "device_type", "os_version", "update_version_code", "iid", "cdid", "device_id", "_rticket"}
	return playbackV5TuneKeys(values, body, stamp, keys)
}

// playbackV5TuneKeys signs an explicitly ordered query. The video_tab
// recovery request uses a larger Android query than the v5 POST; signing the
// exact ordered bytes keeps its business parameters inside the signature.
func playbackV5TuneKeys(values url.Values, body []byte, stamp int64, keys []string) (string, [32]byte, [16]byte, error) {
	for offset := int64(0); offset < 1024; offset++ {
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			value := values.Get(key)
			if key == "_rticket" {
				value = strconv.FormatInt(stamp+offset, 10)
			}
			parts = append(parts, key+"="+strings.ReplaceAll(url.QueryEscape(value), "+", "%20"))
		}
		query := strings.Join(parts, "&")
		iv, q, m := passportBranch(query, body, uint32(stamp/1000))
		if iv&15 == 12 {
			return query, q, m, nil
		}
	}
	return "", [32]byte{}, [16]byte{}, errors.New("unable to select v5 signature branch")
}

func signPlaybackV5(values url.Values, body []byte, stamp int64) (string, http.Header, error) {
	keys := []string{"aid", "app_name", "version_code", "version_name", "manifest_version_code", "channel", "device_platform", "device_type", "os_version", "update_version_code", "iid", "cdid", "device_id", "_rticket"}
	return signPlaybackV5Keys(values, body, stamp, keys)
}

func signPlaybackV5Keys(values url.Values, body []byte, stamp int64, keys []string) (string, http.Header, error) {
	query, q, m, err := playbackV5TuneKeys(values, body, stamp, keys)
	if err != nil {
		return "", nil, err
	}
	process, err := playbackV5ProcessOnce()
	if err != nil {
		return "", nil, err
	}
	var n [4]uint32
	for i := range n {
		n[i], err = protocolRandom()
		if err != nil {
			return "", nil, err
		}
	}
	ts := uint32(stamp / 1000)
	medusa, err := playbackV5Medusa(values, ts, q, m, [3]uint32{n[0], n[1], n[2]}, process)
	if err != nil {
		return "", nil, err
	}
	h := make(http.Header)
	h.Set("X-Khronos", strconv.FormatUint(uint64(ts), 10))
	h.Set("X-Helios", playbackV5Helios(ts, n[3]))
	h.Set("X-Medusa", medusa)
	h.Set("X-SS-STUB", strings.ToUpper(hex.EncodeToString(m[:])))
	return query, h, nil
}
