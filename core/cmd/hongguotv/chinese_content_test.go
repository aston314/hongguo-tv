package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func TestChineseContentDictionaryIsEmbeddedWithItsLicense(t *testing.T) {
	data, err := uiFiles.ReadFile("ui/chinese-content/s2twp.bin")
	if err != nil {
		t.Fatal(err)
	}
	index, err := uiFiles.ReadFile("ui/chinese-content/index.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Config     string
		ByteLength int
		SHA256     string
	}
	if err := json.Unmarshal(index, &manifest); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if manifest.Config != "s2twp" || manifest.ByteLength != len(data) || manifest.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("embedded Chinese dictionary does not match its index")
	}
	for _, name := range []string{"LICENSE", "NOTICE"} {
		if contents, err := uiFiles.ReadFile("ui/chinese-content/" + name); err != nil || len(contents) == 0 {
			t.Fatalf("missing embedded attribution: %s", name)
		}
	}
}
