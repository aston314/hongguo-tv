package main

// Playback-only 551 envelope. Account signing deliberately retains its own
// profile. Protocol interoperability is checked against PR #92's fixed vectors;
// no external signer, device identity, or runtime dependency is used.
import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"math/bits"
	"net/url"
	"strconv"
)

const playbackLicenseID = "1611921764"

func playbackPad(data []byte) []byte {
	n := aes.BlockSize - len(data)%aes.BlockSize
	return append(append([]byte(nil), data...), bytes.Repeat([]byte{byte(n)}, n)...)
}

func playbackVarint(p *protocolProto, field int, value uint32) {
	*p = binary.AppendUvarint(*p, uint64(field<<3))
	*p = binary.AppendUvarint(*p, uint64(value))
}

func playbackText(p *protocolProto, field int, value string) {
	*p = binary.AppendUvarint(*p, uint64(field<<3|2))
	*p = binary.AppendUvarint(*p, uint64(len(value)))
	*p = append(*p, value...)
}

func playbackSimonKeys() [72]uint64 {
	var keys [72]uint64
	raw, _ := hex.DecodeString("fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304")
	for i := 0; i < 4; i++ {
		keys[i] = binary.LittleEndian.Uint64(raw[i*8:])
	}
	const sequence uint64 = 0x3dc94c3a046d678b
	for i := 4; i < len(keys); i++ {
		x := bits.RotateLeft64(keys[i-1], -3) ^ keys[i-3]
		keys[i] = ^keys[i-4] ^ x ^ bits.RotateLeft64(x, -1) ^ ((sequence >> ((i - 4) % 62)) & 1) ^ 3
	}
	return keys
}

func playbackArgus(query string, body []byte, ts, nonce uint32) string {
	values, _ := url.ParseQuery(query)
	aid := firstNonEmpty(values.Get("aid"), "1967")
	var p, counters, device protocolProto
	for _, entry := range [][2]uint32{{1, 1077940818}, {2, 2}, {3, nonce}} {
		playbackVarint(&p, int(entry[0]), entry[1])
	}
	playbackText(&p, 4, aid)
	playbackText(&p, 5, values.Get("device_id"))
	playbackText(&p, 6, playbackLicenseID)
	playbackText(&p, 7, values.Get("version_name"))
	playbackText(&p, 8, "v04.04.05-ov-android")
	playbackVarint(&p, 9, 134744640)
	p.blob(10, make([]byte, 8))
	playbackVarint(&p, 11, 0)
	playbackVarint(&p, 12, ts<<1)
	m := [16]byte{}
	if len(body) > 0 {
		m = md5.Sum(body)
	}
	bodyHash := passportSM3(m[:])
	queryBytes := []byte(query)
	if query == "" {
		queryBytes = make([]byte, 16)
	}
	queryHash := passportSM3(queryBytes)
	p.blob(13, bodyHash[:6])
	p.blob(14, queryHash[:6])
	for _, entry := range [][2]uint32{{1, 1}, {2, 1}, {3, 1}, {7, 0xc792eccc}} {
		playbackVarint(&counters, int(entry[0]), entry[1])
	}
	p.blob(15, counters)
	playbackText(&p, 16, values.Get("iid"))
	p.text(20, "none")
	playbackVarint(&p, 21, 738)
	device.text(1, "NX551J")
	playbackVarint(&device, 2, 8196)
	playbackVarint(&device, 4, 0x80e0d800)
	p.blob(23, device)
	playbackVarint(&p, 25, 2)

	plain := playbackPad(p)
	keys := playbackSimonKeys()
	for at := 0; at < len(plain); at += 16 {
		a, b := binary.LittleEndian.Uint64(plain[at:]), binary.LittleEndian.Uint64(plain[at+8:])
		for _, key := range keys {
			a, b = b, a^(bits.RotateLeft64(b, 1)&bits.RotateLeft64(b, 8))^bits.RotateLeft64(b, 2)^key
		}
		binary.LittleEndian.PutUint64(plain[at:], a)
		binary.LittleEndian.PutUint64(plain[at+8:], b)
	}
	mask := []byte{0xf2, 0xf7, 0xfc, 0xff, 0xf2, 0xf7, 0xfc, 0xff}
	frame := append(append(append([]byte(nil), mask...), plain...), 0xea, 0xfb, 0x2c, 0xfe, 0x85, 0x68, 0x51, 0x91, 0x54)
	for i := len(mask); i < len(frame); i++ {
		frame[i] ^= mask[i%len(mask)]
	}
	for i, j := 0, len(frame)-1; i < j; i, j = i+1, j-1 {
		frame[i], frame[j] = frame[j], frame[i]
	}
	frame = playbackPad(append(frame, 0x61, 0x6f))
	key, _ := hex.DecodeString("d31e3718288a1027baab59f146a09a9c")
	iv, _ := hex.DecodeString("ea180a0336ed352fcd24e4d50018ae54")
	block, _ := aes.NewCipher(key)
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(frame, frame)
	return base64.StdEncoding.EncodeToString(append([]byte{0xf2, 0x81}, frame...))
}

func playbackLadon(ts uint32, aid string, nonce uint32) string {
	seed := protocolLE(nonce)
	digest := md5.Sum(append(append([]byte(nil), seed...), aid...))
	hexKey := []byte(hex.EncodeToString(digest[:]))
	var keys [34]uint64
	k := binary.LittleEndian.Uint64(hexKey)
	pending := [3]uint64{binary.LittleEndian.Uint64(hexKey[8:]), binary.LittleEndian.Uint64(hexKey[16:]), binary.LittleEndian.Uint64(hexKey[24:])}
	for i := range keys {
		keys[i] = k
		x := (bits.RotateLeft64(pending[0], -8) + k) ^ uint64(i)
		pending = [3]uint64{pending[1], pending[2], x}
		k = x ^ bits.RotateLeft64(k, 3)
	}
	plain := playbackPad([]byte(strconv.FormatUint(uint64(ts), 10) + "-" + playbackLicenseID + "-" + aid))
	for at := 0; at < len(plain); at += 16 {
		a, b := binary.LittleEndian.Uint64(plain[at:]), binary.LittleEndian.Uint64(plain[at+8:])
		for _, key := range keys {
			b = key ^ (a + bits.RotateLeft64(b, -8))
			a = b ^ bits.RotateLeft64(a, 3)
		}
		binary.LittleEndian.PutUint64(plain[at:], a)
		binary.LittleEndian.PutUint64(plain[at+8:], b)
	}
	return base64.StdEncoding.EncodeToString(append(seed, plain...))
}
