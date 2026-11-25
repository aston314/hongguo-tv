package jsupdate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/playbackprofile"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

type dataRuntime struct{ revision int64 }

func (r *dataRuntime) Resolve(context.Context, resolverwire.Request) ([]resolverwire.Option, error) {
	return []resolverwire.Option{{Quality: string(rune('0' + r.revision))}}, nil
}
func (r *dataRuntime) Close(context.Context) error { return nil }
func profileLab(t *testing.T) *lab {
	l := newLab(t)
	l.m.Close(context.Background())
	l.config.Product = ProfileProduct
	l.config.Extension = ".json"
	l.config.MaxArtifact = MaxProfile
	l.config.Embedded = playbackprofile.Builtin()
	l.config.EmbeddedVersion = playbackprofile.Version
	l.config.Loader = func(ctx context.Context, b []byte, _ string) (Runtime, error) {
		p, e := playbackprofile.Parse(b)
		if e != nil {
			return nil, e
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return &dataRuntime{p.Revision}, nil
	}
	// Any accidental JS transport invocation fails this fixture.
	l.config.Transport = func(context.Context, resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		t.Error("JSON created executable HTTP host")
		return resolverwire.HTTPResponse{}, errors.New("unexpected")
	}
	l.m = l.open()
	return l
}
func (l *lab) offerProfile(rev uint64, b []byte, enabled bool) {
	var a *Artifact
	if enabled {
		a = &Artifact{Version: "p" + string(rune('0'+rev)), Protocol: 1, HostAPI: 1, URL: l.server.URL + "/script", Size: len(b), SHA256: digest(b)}
	}
	m := Manifest{Schema: 1, Product: ProfileProduct, Revision: rev, Enabled: enabled, IssuedAt: time.Now().Add(-time.Minute).Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix(), Module: a}
	e, _ := Sign(m, l.key)
	l.mu.Lock()
	l.env = e
	l.script = b
	l.scriptMode = ""
	l.manifestMode = ""
	l.mu.Unlock()
}
func revisedProfile(rev int) []byte {
	return []byte(strings.Replace(string(playbackprofile.Builtin()), `"revision": 1`, `"revision": `+string(rune('0'+rev)), 1))
}
func TestProfileAutomaticDataActivationRestoreAndDisable(t *testing.T) {
	l := profileLab(t)
	l.quality("1") // no preference or JS enable required
	if _, ok := l.m.runtime.(*dataRuntime); !ok {
		t.Fatal("not native data runtime")
	}
	l.offerProfile(1, revisedProfile(2), true)
	l.check()
	l.quality("2")
	l.restart()
	l.quality("2")
	l.mu.Lock()
	l.manifestMode = "offline"
	l.mu.Unlock()
	if l.m.Check(context.Background()) == nil {
		t.Fatal("expected offline")
	}
	l.quality("2")
	l.offerProfile(2, nil, false)
	l.check()
	l.quality("1")
	l.restart()
	l.quality("1")
	l.offerProfile(1, revisedProfile(2), true)
	if l.m.Check(context.Background()) == nil {
		t.Fatal("accepted replay after disable")
	}
	l.quality("1")
}
func TestProfileRejectsInvalidCandidateAndCrossChannelControls(t *testing.T) {
	l := profileLab(t)
	l.offerProfile(1, revisedProfile(2), true)
	l.check()
	l.quality("2")
	invalid := []byte(strings.Replace(string(revisedProfile(3)), `"${magic}"`, `"${ts}"`, 1))
	l.offerProfile(2, invalid, true)
	if l.m.Check(context.Background()) == nil {
		t.Fatal("accepted invalid reference type")
	}
	l.quality("2")
	l.offerProfile(2, revisedProfile(3), true)
	l.mu.Lock()
	l.env.Signature = strings.Repeat("A", 88)
	l.mu.Unlock()
	if l.m.Check(context.Background()) == nil {
		t.Fatal("accepted bad signature")
	}
	l.quality("2")
	l.offerProfile(2, revisedProfile(3), true)
	l.mu.Lock()
	l.script = []byte("<html>bad proxy</html>")
	l.mu.Unlock()
	if l.m.Check(context.Background()) == nil {
		t.Fatal("accepted bad digest")
	}
	l.quality("2")
	l.offer(2, script("v2", success("bad")), "v2")
	if l.m.Check(context.Background()) == nil {
		t.Fatal("accepted JS manifest in JSON channel")
	}
	l.quality("2")
	l.offerProfile(3, revisedProfile(3), true)
	l.check()
	l.quality("3")
	l.offerProfile(4, nil, false)
	if _, e := VerifyStoredControl(l.env, l.config.PublicKey); e == nil {
		t.Fatal("JS accepted JSON disable")
	}
	if _, e := VerifyStoredProfileControl(l.env, l.config.PublicKey); e != nil {
		t.Fatal(e)
	}
}
func TestProfileURLAndProxyIsolation(t *testing.T) {
	good := ProfileRoot + "profiles/" + strings.Repeat("a", 64) + ".json"
	for _, u := range []string{ProfileManifestURL, good} {
		if !ProfileURL(u) {
			t.Fatal("rejected profile URL")
		}
		r := Routes(u)
		if len(r) != len(Proxies)+1 || r[len(r)-1] != u {
			t.Fatal("changed proxy fallback")
		}
		if OfficialURL(u) {
			t.Fatal("cross channel")
		}
	}
	for _, u := range []string{ManifestURL, good + "?x=1", good + "#x", strings.Replace(good, ".json", ".js", 1), ProfileRoot + "../manifest.json", ProfileRoot + "profiles/%61.json", "https://evil.example/manifest.json"} {
		if ProfileURL(u) {
			t.Fatal("accepted nonofficial URL")
		}
	}
}
