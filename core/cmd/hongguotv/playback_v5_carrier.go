// SPDX-License-Identifier: GPL-3.0-only
// v5 carrier; see playback_v5_sign.go for provenance. Not standard AES.
package main

import "errors"

func playbackV5AES(data []byte, ts uint32, key, iv []byte) ([]byte, error) {
	if len(data) < 248 || len(key) != 16 || len(iv) != 16 {
		return nil, errors.New("signature payload is too short")
	}
	i := int(ts & 3)
	box := playbackV5SBox[i*256 : (i+1)*256]
	con := [4][4]int{{2, 0, 3, 1}, {1, 3, 2, 0}, {3, 2, 1, 0}, {2, 3, 1, 0}}[i]
	order := [4][16]int{{0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11}, {0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7}, {0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7}, {0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7}}[i]
	init := [4]uint32{0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9}[i]
	var mk [48]byte
	for j := 0; j < 16; j++ {
		mk[j] = key[j] ^ byte(init>>((j%4)*8))
	}
	r := 8
	for j := 4; j < 12; j++ {
		prev := [4]byte{mk[j*4-4], mk[j*4-3], mk[j*4-2], mk[j*4-1]}
		if j%4 == 0 {
			prev = [4]byte{byte(init>>uint(r&24)) ^ box[prev[1]], box[prev[2]], box[prev[3]], box[prev[0]]}
		}
		r += 2
		for k := 0; k < 4; k++ {
			mk[j*4+k] = prev[k] ^ mk[j*4+k-16]
		}
	}
	block := func(src []byte) []byte {
		b := append([]byte(nil), src...)
		add := func(base int) {
			for j := range b {
				b[j] ^= mk[base+(j/4)*4+con[j%4]]
			}
		}
		add(0)
		for round := 1; round <= 2; round++ {
			prev := append([]byte(nil), b...)
			for j := range b {
				index := order[j]
				b[j] = box[prev[con[index/4]*4+index%4]]
			}
			if round == 1 {
				prev = append([]byte(nil), b...)
				for j := range b {
					b[j] = prev[(j/4)*4+con[j%4]]
				}
				xt := func(x byte) byte {
					if x&128 != 0 {
						return x<<1 ^ 0x1b
					}
					return x << 1
				}
				for col := 0; col < 4; col++ {
					a, c, d, e := b[col], b[4+col], b[8+col], b[12+col]
					t := a ^ c ^ d ^ e
					b[col] ^= t ^ xt(a^c)
					b[4+col] ^= t ^ xt(c^d)
					b[8+col] ^= t ^ xt(d^e)
					b[12+col] ^= t ^ xt(e^a)
				}
			}
			add(round * 16)
		}
		for j := range b {
			b[j] ^= mk[16+j]
		}
		return b
	}
	wire, compact := [8]uint{6, 5, 3, 4, 2, 7, 1, 0}, [8]uint{1, 7, 3, 6, 2, 0, 4, 5}
	plain := make([]byte, 32)
	for j := 0; j < 31; j++ {
		for k := 0; k < 8; k++ {
			plain[j] |= ((data[j*8+k] >> wire[k]) & 1) << compact[k]
		}
	}
	plain[31] = 1
	previous := append([]byte(nil), iv...)
	encrypted := make([]byte, 0, 32)
	for j := 0; j < 32; j += 16 {
		for k := 0; k < 16; k++ {
			plain[j+k] ^= previous[k]
		}
		previous = block(plain[j : j+16])
		encrypted = append(encrypted, previous...)
	}
	out := append([]byte{encrypted[31]}, data...)
	for j := 0; j < 31; j++ {
		for k := 0; k < 8; k++ {
			at := 1 + j*8 + k
			out[at] = (out[at] &^ (1 << wire[k])) | (((encrypted[j] >> compact[k]) & 1) << wire[k])
		}
	}
	return out, nil
}
