// resolver-publish creates static signed playback rules; no resolver server runs.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/jsupdate"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	out := flag.String("out", "", "output directory")
	version := flag.String("version", "", "module version")
	revision := flag.Uint64("revision", 0, "strictly increasing control revision")
	previous := flag.String("previous", "", "previous signed manifest, if any")
	disable := flag.Bool("disable", false, "publish a signed native-only control")
	flag.Parse()
	if *out == "" || *revision == 0 || !*disable && !regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`).MatchString(*version) {
		return errors.New("invalid publication arguments")
	}
	seed, e := base64.StdEncoding.DecodeString(os.Getenv("PLAYBACK_RESOLVER_SIGNING_SEED"))
	if e != nil || len(seed) != ed25519.SeedSize {
		return errors.New("missing or invalid signing seed")
	}
	key := ed25519.NewKeyFromSeed(seed)
	for i := range seed {
		seed[i] = 0
	}
	if !bytes.Equal(key.Public().(ed25519.PublicKey), jsupdate.PublicKey()) {
		return errors.New("signing key does not match application trust anchor")
	}
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	now := time.Now().Unix()
	m := jsupdate.Manifest{Schema: 1, Product: jsupdate.Product, Revision: *revision, Enabled: !*disable, IssuedAt: now - 30, ExpiresAt: now + int64((30*24*time.Hour)/time.Second) - 30}
	var script []byte
	if !*disable {
		script = jsresolver.Source()
		needle := []byte("version:'" + jsresolver.Version + "'")
		if bytes.Count(script, needle) != 1 {
			return errors.New("embedded module version is ambiguous")
		}
		script = bytes.Replace(script, needle, []byte("version:'"+*version+"'"), 1)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		r, err := jsresolver.New(ctx, script, func(context.Context, resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
			return resolverwire.HTTPResponse{}, errors.New("publication self-test cannot use HTTP")
		})
		if err != nil {
			return errors.New("candidate load failed")
		}
		defer r.Close(context.Background())
		md, err := r.Metadata(ctx)
		if err != nil || md.Version != *version || md.Protocol != 1 || !md.NativeSM3 || md.Name != "hongguo-playback-resolver" {
			return errors.New("candidate metadata failed")
		}
		n, err := r.SelfTest(ctx, jsresolver.SigningVectors())
		if err != nil || n != jsresolver.SigningVectorCount {
			return errors.New("candidate signing vectors failed")
		}
		hash := sha256.Sum256(script)
		sha := hex.EncodeToString(hash[:])
		m.Module = &jsupdate.Artifact{Version: *version, Protocol: 1, HostAPI: jsupdate.HostAPI, URL: jsupdate.ChannelRoot + "modules/" + sha + ".js", Size: len(script), SHA256: sha}
	}
	if *previous != "" {
		data, err := os.ReadFile(*previous)
		if err != nil || len(data) > jsupdate.MaxManifest {
			return errors.New("preceding control unavailable")
		}
		var envelope jsupdate.Envelope
		if json.Unmarshal(data, &envelope) != nil {
			return errors.New("invalid preceding control")
		}
		old, err := jsupdate.VerifyStoredControl(envelope, jsupdate.PublicKey())
		if err != nil {
			return errors.New("preceding control signature rejected")
		}
		if old.Revision >= m.Revision {
			return errors.New("control revision must increase")
		}
		if old.Module != nil && m.Module != nil && old.Module.Version == m.Module.Version && old.Module.SHA256 != m.Module.SHA256 {
			return errors.New("changed script needs a new module version")
		}
	}
	envelope, e := jsupdate.Sign(m, key)
	if e != nil {
		return errors.New("control signing failed")
	}
	if _, e = jsupdate.VerifyStoredControl(envelope, jsupdate.PublicKey()); e != nil {
		return errors.New("published control verification failed")
	}
	if e = os.MkdirAll(filepath.Join(*out, "modules"), 0755); e != nil {
		return e
	}
	if m.Module != nil {
		if e = os.WriteFile(filepath.Join(*out, "modules", m.Module.SHA256+".js"), script, 0644); e != nil {
			return e
		}
	}
	data, _ := json.Marshal(envelope)
	data = append(data, '\n')
	if e = os.WriteFile(filepath.Join(*out, "manifest.json"), data, 0644); e != nil {
		return e
	}
	fmt.Printf("Verified resolver control revision=%d enabled=%t\n", m.Revision, m.Enabled)
	return nil
}
