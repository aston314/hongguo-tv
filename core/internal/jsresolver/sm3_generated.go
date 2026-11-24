// Code generated from the existing standard SM3 primitive; DO NOT EDIT.
package jsresolver

import (
	"encoding/binary"
	"math/bits"
)

func sumSM3(data []byte) [32]byte {
	n := uint64(len(data)) * 8
	b := append([]byte(nil), data...)
	b = append(b, 0x80)
	for len(b)%64 != 56 {
		b = append(b, 0)
	}
	b = binary.BigEndian.AppendUint64(b, n)
	v := [8]uint32{0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e}
	p0 := func(x uint32) uint32 { return x ^ bits.RotateLeft32(x, 9) ^ bits.RotateLeft32(x, 17) }
	p1 := func(x uint32) uint32 { return x ^ bits.RotateLeft32(x, 15) ^ bits.RotateLeft32(x, 23) }
	for len(b) > 0 {
		var w [68]uint32
		for i := 0; i < 16; i++ {
			w[i] = binary.BigEndian.Uint32(b[i*4:])
		}
		for i := 16; i < 68; i++ {
			w[i] = p1(w[i-16]^w[i-9]^bits.RotateLeft32(w[i-3], 15)) ^ bits.RotateLeft32(w[i-13], 7) ^ w[i-6]
		}
		a, c, d, e, f, g, h, k := v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]
		for j := 0; j < 64; j++ {
			t := uint32(0x79cc4519)
			ff := a ^ c ^ d
			gg := f ^ g ^ h
			if j >= 16 {
				t = 0x7a879d8a
				ff = (a & c) | (a & d) | (c & d)
				gg = (f & g) | (^f & h)
			}
			s1 := bits.RotateLeft32(bits.RotateLeft32(a, 12)+f+bits.RotateLeft32(t, j), 7)
			s2 := s1 ^ bits.RotateLeft32(a, 12)
			u1 := ff + e + s2 + (w[j] ^ w[j+4])
			u2 := gg + k + s1 + w[j]
			e = d
			d = bits.RotateLeft32(c, 9)
			c = a
			a = u1
			k = h
			h = bits.RotateLeft32(g, 19)
			g = f
			f = p0(u2)
		}
		for i, x := range [8]uint32{a, c, d, e, f, g, h, k} {
			v[i] ^= x
		}
		b = b[64:]
	}
	var out [32]byte
	for i, x := range v {
		binary.BigEndian.PutUint32(out[i*4:], x)
	}
	return out
}
