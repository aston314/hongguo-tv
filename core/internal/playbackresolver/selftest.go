package playbackresolver

import (
	_ "embed"
	"encoding/hex"
	"encoding/json"
)

//go:embed testdata/signing-v5-wire.json
var wireVectors []byte

// SelfTest checks the same four independent Kotlin vectors inside the guest.
func SelfTest() uint32 {
	var rows []struct {
		Query, Body, Medusa, Helios string
		TS                          uint32
	}
	if json.Unmarshal(wireVectors, &rows) != nil || len(rows) != 4 {
		return 0
	}
	for _, row := range rows {
		body, err := hex.DecodeString(row.Body)
		if err != nil {
			return 0
		}
		values := miniReelMobileV5Query(miniReelDevice{deviceID: "123", installID: "456", cdid: "synthetic"})
		query, q, m, err := playbackV5Tune(values, body, int64(row.TS)*1000)
		if err != nil || query != row.Query {
			return 1
		}
		medusa, err := playbackV5Medusa(values, row.TS, q, m, [3]uint32{0x80000000, 0x80000000, 0x80000000}, playbackV5Process{nonce: "synthetic", started: 1800000000000})
		if err != nil || medusa != row.Medusa || playbackV5Helios(row.TS, 0x80000000) != row.Helios {
			return 2
		}
	}
	return 4
}
