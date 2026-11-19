package playbackresolver

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

func TestIndependentDeviceCipherAndWireVectors(t *testing.T) {
	if SelfTest() != 4 {
		t.Fatal("wire vectors differ")
	}
	var v struct {
		Seed, DerivedKey, Plain, Ciphertext string `json:"-"`
	}
	// Decode explicit JSON keys because the independent fixture uses snake case.
	raw, err := os.ReadFile("testdata/passport-device-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var row map[string]string
	if json.Unmarshal(raw, &row) != nil {
		t.Fatal("vector JSON")
	}
	v.Seed = row["seed"]
	v.DerivedKey = row["derived_key"]
	v.Plain = row["plain"]
	v.Ciphertext = row["ciphertext"]
	seed, _ := hex.DecodeString(v.Seed)
	derived := passportDeviceKey(seed)
	if hex.EncodeToString(derived[:]) != v.DerivedKey {
		t.Fatal("derived key differs")
	}
	ciphertext, _ := base64.StdEncoding.DecodeString(v.Ciphertext)
	plain, err := passportTTDecrypt(ciphertext)
	if err != nil || string(plain) != v.Plain {
		t.Fatal("independent encrypted device response differs")
	}
}

func TestInvalidRequestsNeverRegister(t *testing.T) {
	r := New(func(context.Context, resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		t.Fatal("invalid input made HTTP request")
		return resolverwire.HTTPResponse{}, nil
	})
	for _, request := range []resolverwire.Request{{VID: "bad"}, {VID: "123", CodecMode: "unknown"}, {VID: "123", ContentType: "bad"}} {
		if _, err := r.Resolve(context.Background(), request); err == nil {
			t.Fatal("invalid request accepted")
		}
	}
}

func TestRegistrationCancellationStopsBeforeModel(t *testing.T) {
	models := 0
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := New(func(_ context.Context, request resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		if !strings.Contains(request.URL, "/device_register/") {
			models++
		}
		cancel()
		return resolverwire.HTTPResponse{Status: 200, Body: []byte(`{"device_id_str":"1234567891234567","install_id_str":"2345678912345678"}`)}, nil
	})
	_, err := r.Resolve(ctx, resolverwire.Request{VID: "123"})
	if !errors.Is(err, context.Canceled) || models != 0 {
		t.Fatalf("must cancel before model request: %v calls=%d", err, models)
	}
}

func TestCodecFallbackKeepsSignedQueryAndRejectsWrongEpisode(t *testing.T) {
	const raw = "https://api.fqnovel.com/fallback?sig=a%2fb%2BC&same=1&same=2&codec_type=4&force_codec=old&token=x%3D"
	model := func(codec, id string, duration int) map[string]any {
		return map[string]any{"video_id": id, "video_duration": duration, "video_list": []any{map[string]any{"codec_type": codec, "main_url": "https://media.example.test/episode.mp4", "vheight": 1080}}}
	}
	var calls []string
	r := New(func(_ context.Context, request resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		calls = append(calls, request.URL)
		parsed, _ := url.Parse(request.URL)
		codec := parsed.Query().Get("codec_type")
		candidate := model("bytevc2", "same", 90)
		switch codec {
		case "1":
			candidate = model("h265", "wrong", 90)
		case "0":
			candidate = model("h264", "same", 95)
		case "3":
			candidate = model("bytevc1", "same", 90)
		}
		data, _ := json.Marshal(map[string]any{"code": 0, "video_info": map[string]any{"code": 0, "data": candidate}})
		return resolverwire.HTTPResponse{Status: 200, Body: data}, nil
	})
	initial := model("bytevc2", "same", 90)
	initial["fallback_api"] = raw
	compatible, err := r.compatible(context.Background(), initial)
	if err != nil {
		t.Fatal(err)
	}
	options := miniReelOptionsFromModel(compatible)
	if len(options) != 1 || options[0].Codec != "bytevc1" {
		t.Fatal("wrong episode/duration accepted or codec3 skipped")
	}
	want := []string{raw, "https://api.fqnovel.com/fallback?sig=a%2fb%2BC&same=1&same=2&token=x%3D&codec_type=1", "https://api.fqnovel.com/fallback?sig=a%2fb%2BC&same=1&same=2&token=x%3D&codec_type=0&force_codec=h264", "https://api.fqnovel.com/fallback?sig=a%2fb%2BC&same=1&same=2&token=x%3D&codec_type=3"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatal("signed query bytes or fallback order changed")
	}
}
