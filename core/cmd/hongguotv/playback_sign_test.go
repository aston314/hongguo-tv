package main

import (
	"encoding/json"
	"net/url"
	"os"
	"testing"
)

func TestPlaybackCompleteSignatureVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/playback-sign-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Query, Body, Argus, Ladon string
		TS, Nonce                 uint32
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		if got := playbackArgus(v.Query, []byte(v.Body), v.TS, v.Nonce); got != v.Argus {
			t.Fatal("Argus fixed vector mismatch")
		}
		q, _ := url.ParseQuery(v.Query)
		if got := playbackLadon(v.TS, firstNonEmpty(q.Get("aid"), "1967"), 0x04030201); got != v.Ladon {
			t.Fatal("Ladon fixed vector mismatch")
		}
		for _, got := range []string{
			playbackArgus(v.Query+"&device_id=changed", []byte(v.Body), v.TS, v.Nonce),
			playbackArgus(v.Query, []byte(v.Body+" "), v.TS, v.Nonce),
			playbackArgus(v.Query, []byte(v.Body), v.TS+1, v.Nonce),
			playbackArgus(v.Query, []byte(v.Body), v.TS, v.Nonce^1),
		} {
			if got == v.Argus {
				t.Fatal("Argus ignored query, body, timestamp or nonce")
			}
		}
	}
}
