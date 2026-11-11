package main

// Dedicated 7.3.5.32 playback envelope. Do not mix it with the account or
// legacy 551 profile: the environment and outer Argus framing differ.
import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"math/bits"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func singleRegisteredArgus(query string, body []byte, ts uint32, nonce uint32) string {
	var p, counters, env protocolProto
	for _, e := range [][2]uint32{{1, 1077940818}, {2, 2}, {3, nonce & 0x7fffffff}} {
		playbackVarint(&p, int(e[0]), e[1])
	}
	q, _ := url.ParseQuery(query)
	playbackText(&p, 4, "8662")
	playbackText(&p, 5, q.Get("device_id"))
	playbackText(&p, 6, playbackLicenseID)
	playbackText(&p, 7, "7.3.5.32")
	playbackText(&p, 8, "v04.07.01-ml-android")
	playbackVarint(&p, 9, 135135744)
	p.blob(10, make([]byte, 8))
	playbackVarint(&p, 11, 0)
	playbackVarint(&p, 12, ts<<1)
	m := md5.Sum(body)
	if body == nil {
		m = [16]byte{}
	}
	bh, qh := passportSM3(m[:]), passportSM3([]byte(query))
	p.blob(13, bh[:6])
	p.blob(14, qh[:6])
	for _, e := range [][2]uint32{{1, 1}, {2, 1}, {3, 1}, {7, 3348294860}} {
		playbackVarint(&counters, int(e[0]), e[1])
	}
	p.blob(15, counters)
	playbackText(&p, 16, "")
	playbackText(&p, 20, "none")
	playbackVarint(&p, 21, 738)
	playbackText(&env, 1, "25053RT47C")
	playbackText(&env, 2, "16")
	playbackText(&env, 3, "update_64")
	playbackVarint(&env, 4, 2147483648)
	p.blob(23, env)
	playbackVarint(&p, 25, 2)
	key, _ := hex.DecodeString("ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c")
	seed := append(append(append([]byte(nil), key...), 0x3c, 0xcc, 0x56, 0x7b), key...)
	raw := passportSM3(seed)
	var rounds [72]uint64
	for i := 0; i < 4; i++ {
		rounds[i] = binary.LittleEndian.Uint64(raw[i*8:])
	}
	for i := 4; i < len(rounds); i++ {
		x := bits.RotateLeft64(rounds[i-1], -3) ^ rounds[i-3]
		rounds[i] = ^rounds[i-4] ^ x ^ bits.RotateLeft64(x, -1) ^ ((uint64(0x3dc94c3a046d678b) >> ((i - 4) % 62)) & 1) ^ 3
	}
	plain := playbackPad(p)
	for at := 0; at < len(plain); at += 16 {
		a, b := binary.LittleEndian.Uint64(plain[at:]), binary.LittleEndian.Uint64(plain[at+8:])
		for _, k := range rounds {
			a, b = b, a^(bits.RotateLeft64(b, 1)&bits.RotateLeft64(b, 8))^bits.RotateLeft64(b, 2)^k
		}
		binary.LittleEndian.PutUint64(plain[at:], a)
		binary.LittleEndian.PutUint64(plain[at+8:], b)
	}
	mask := []byte{0xd0, 0x4f, 0xfd, 0xff, 0xd0, 0x4f, 0xfd, 0xff}
	for i := range plain {
		plain[i] ^= mask[i%8]
	}
	frame := append(mask, plain...)
	for i, j := 0, len(frame)-1; i < j; i, j = i+1, j-1 {
		frame[i], frame[j] = frame[j], frame[i]
	}
	frame = append([]byte{0xa6, 0xe7, 0x83, 0xee, 0x70, 1, 0x10, 9, 0x18}, frame...)
	frame = playbackPad(append(frame, 0x56, 0x7b))
	ak, iv := md5.Sum(key[:16]), md5.Sum(key[16:])
	block, _ := aes.NewCipher(ak[:])
	cipher.NewCBCEncrypter(block, iv[:]).CryptBlocks(frame, frame)
	return base64.StdEncoding.EncodeToString(append([]byte{0x3c, 0xcc}, frame...))
}
func singleRegisteredGorgon(query string, body []byte, ts uint32) string {
	var p [20]byte
	q := md5.Sum([]byte(query))
	copy(p[:4], q[:4])
	if body != nil {
		m := md5.Sum(body)
		copy(p[4:8], m[:4])
	}
	copy(p[12:16], []byte{0, 6, 11, 28})
	binary.BigEndian.PutUint32(p[16:], ts)
	key := []byte{0x44, 0xb9, 0xb9, 0xd9, 0xa4, 0xae, 0xf9, 0xfc, 0xa4, 0x93, 0xaa, 0x75, 0x7c, 0xa3, 0xc2, 0xc4, 0xa4, 0x96, 0x93, 0x8f}
	for i := range p {
		p[i] ^= key[i]
	}
	for i := range p {
		p[i] = bits.Reverse8(bits.RotateLeft8(p[i], 4)^p[(i+1)%20]) ^ 0xff ^ 20
	}
	return hex.EncodeToString(append([]byte{0x84, 4, 0x40, 0x1c, 0, 0}, p[:]...))
}
func signSingleRegistered(q url.Values, body []byte, stamp int64) (string, http.Header, error) {
	a, err := protocolRandom()
	if err != nil {
		return "", nil, err
	}
	l, err := protocolRandom()
	if err != nil {
		return "", nil, err
	}
	q.Set("_rticket", strconv.FormatInt(stamp, 10))
	query := q.Encode()
	ts := uint32(stamp / 1000)
	h := http.Header{"X-Khronos": {strconv.FormatUint(uint64(ts), 10)}, "X-SS-Req-Ticket": {strconv.FormatInt(stamp, 10)}, "X-Gorgon": {singleRegisteredGorgon(query, body, ts)}, "X-Argus": {singleRegisteredArgus(query, body, ts, a)}, "X-Ladon": {playbackLadon(ts, "8662", l)}}
	m := md5.Sum(body)
	h.Set("X-SS-STUB", strings.ToUpper(hex.EncodeToString(m[:])))
	return query, h, nil
}
