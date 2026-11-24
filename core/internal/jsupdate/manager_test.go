package jsupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

func script(version, body string) []byte {
	return []byte(fmt.Sprintf(`({metadata:function(){return {name:'hongguo-playback-resolver',version:%q,protocol:1,native_sm3:true}},selfTest:function(){return 4},resolve:function(){%s}})`, version, body))
}
func success(quality string) string {
	return fmt.Sprintf(`return JSON.stringify({options:[{url:'https://cdn.example/episode.mp4',codec:'h265',quality:%q,width:1920,height:1080}]})`, quality)
}

type lab struct {
	t                        *testing.T
	key                      ed25519.PrivateKey
	mu                       sync.Mutex
	env                      Envelope
	script                   []byte
	manifestMode, scriptMode string
	server                   *httptest.Server
	config                   Config
	m                        *Manager
}

func newLab(t *testing.T) *lab {
	t.Helper()
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	l := &lab{t: t, key: key}
	l.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("credentials leaked")
		}
		l.mu.Lock()
		defer l.mu.Unlock()
		mode := l.scriptMode
		if r.URL.Path == "/manifest" {
			mode = l.manifestMode
		}
		switch mode {
		case "html":
			w.Write([]byte("<html>proxy error</html>"))
			return
		case "redirect":
			http.Redirect(w, r, "/stolen", 302)
			return
		case "offline":
			w.WriteHeader(503)
			return
		case "short":
			w.Write([]byte("short"))
			return
		}
		if r.URL.Path == "/manifest" {
			json.NewEncoder(w).Encode(l.env)
		} else {
			w.Write(l.script)
		}
	}))
	l.config = Config{Dir: t.TempDir(), ManifestURL: l.server.URL + "/manifest", PublicKey: pub, Embedded: script("builtin", success("builtin")), EmbeddedVersion: "builtin", Vectors: []byte("[1,2,3,4]"), VectorCount: 4, Client: l.server.Client(), AllowedURL: func(u string) bool { return u == l.server.URL+"/manifest" || u == l.server.URL+"/script" }, Routes: func(s string) []string { return []string{s} }, Transport: func(context.Context, resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		return resolverwire.HTTPResponse{}, errors.New("unexpected HTTP")
	}}
	l.m = l.open()
	t.Cleanup(func() { l.m.Close(context.Background()); l.server.Close() })
	return l
}
func (l *lab) open() *Manager {
	l.t.Helper()
	m, e := New(context.Background(), l.config)
	if e != nil {
		l.t.Fatal(e)
	}
	return m
}
func (l *lab) offer(rev uint64, b []byte, version string) {
	l.t.Helper()
	a := &Artifact{Version: version, Protocol: 1, HostAPI: 1, URL: l.server.URL + "/script", Size: len(b), SHA256: digest(b)}
	p := Manifest{Schema: 1, Product: Product, Revision: rev, Enabled: true, IssuedAt: time.Now().Add(-time.Minute).Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix(), Module: a}
	env, e := Sign(p, l.key)
	if e != nil {
		l.t.Fatal(e)
	}
	l.mu.Lock()
	l.env = env
	l.script = b
	l.scriptMode = ""
	l.manifestMode = ""
	l.mu.Unlock()
}
func (l *lab) disable(rev uint64) {
	p := Manifest{Schema: 1, Product: Product, Revision: rev, IssuedAt: time.Now().Add(-time.Minute).Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	env, _ := Sign(p, l.key)
	l.mu.Lock()
	l.env = env
	l.mu.Unlock()
}
func (l *lab) check() {
	l.t.Helper()
	if e := l.m.Check(context.Background()); e != nil {
		l.t.Fatal(e)
	}
}
func (l *lab) quality(want string) {
	l.t.Helper()
	out, e := l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	if e != nil || len(out) != 1 || out[0].Quality != want {
		l.t.Fatalf("quality=%v err=%v want=%s", out, e, want)
	}
}
func (l *lab) restart() { l.t.Helper(); l.m.Close(context.Background()); l.m = l.open() }

func TestActivationRestoreDisableAndReplay(t *testing.T) {
	l := newLab(t)
	l.quality("builtin")
	l.offer(1, script("v1", success("v1")), "v1")
	l.check()
	l.quality("v1")
	original := l.env
	l.restart()
	l.quality("v1")
	if l.m.Status().Event != "restored" {
		t.Fatal(l.m.Status())
	}
	l.disable(2)
	l.check()
	l.quality("builtin")
	l.restart()
	l.quality("builtin")
	if l.m.Status().Enabled || l.m.Status().Revision != 2 {
		t.Fatal(l.m.Status())
	}
	l.mu.Lock()
	l.env = original
	l.mu.Unlock()
	if e := l.m.Check(context.Background()); e == nil {
		t.Fatal("old enabled manifest undid disable")
	}
	l.quality("builtin")
}
func TestBadUpdatesKeepWorkingModuleAndRetry(t *testing.T) {
	for _, bad := range []string{"signature", "tampered_disable", "digest", "short", "html", "redirect", "offline", "syntax", "metadata", "selftest", "undefined", "throwing_getter", "swallowed_validation_http", "infinite_load", "infinite_selftest", "network_validation", "expired", "future", "protocol", "same_version"} {
		t.Run(bad, func(t *testing.T) {
			l := newLab(t)
			l.offer(1, script("v1", success("v1")), "v1")
			l.check()
			b := script("v2", success("v2"))
			version := "v2"
			switch bad {
			case "undefined":
				b = []byte("undefined")
			case "throwing_getter":
				b = []byte("({get resolve(){throw new Error('secret source URL')}})")
			case "swallowed_validation_http":
				b = []byte(strings.ReplaceAll(string(b), "return 4", `try{__resolverHost.http('GET','https://api.fqnovel.com/test',{},Buffer.from(''))}catch(e){};return 4`))
			case "syntax":
				b = []byte("invalid ; ! syntax")
			case "metadata":
				version = "wrong"
			case "selftest":
				b = []byte(strings.ReplaceAll(string(b), "return 4", "return 0"))
			case "infinite_load":
				b = []byte("for(;;){}")
			case "infinite_selftest":
				b = []byte(strings.ReplaceAll(string(b), "return 4", "for(;;){}"))
			case "network_validation":
				b = []byte(strings.ReplaceAll(string(b), "return 4", `__resolverHost.http('GET','https://api.fqnovel.com/test',{},Buffer.from(''));return 4`))
			case "same_version":
				version = "v1"
				b = script("v1", success("different"))
			}
			l.offer(2, b, version)
			l.m.cfg.ValidateTimeout = 80 * time.Millisecond
			l.mu.Lock()
			switch bad {
			case "signature":
				l.env.Signature = strings.Repeat("A", 88)
			case "tampered_disable":
				var p Manifest
				p, _ = verify(l.env, l.config.PublicKey, time.Now(), true, l.config.AllowedURL)
				p.Enabled = false
				p.Module = nil
				fake, _ := Sign(p, l.key)
				l.env.Payload = fake.Payload
			case "digest":
				l.script = []byte(strings.Repeat("x", len(b)))
			case "short", "html", "redirect", "offline":
				l.scriptMode = bad
			case "expired", "future", "protocol":
				p, _ := verify(l.env, l.config.PublicKey, time.Now(), true, l.config.AllowedURL)
				if bad == "expired" {
					p.IssuedAt = time.Now().Add(-2 * time.Hour).Unix()
					p.ExpiresAt = time.Now().Add(-time.Hour).Unix()
				}
				if bad == "future" {
					p.IssuedAt = time.Now().Add(time.Hour).Unix()
					p.ExpiresAt = time.Now().Add(2 * time.Hour).Unix()
				}
				if bad == "protocol" {
					p.Module.Protocol = 2
				}
				l.env, _ = Sign(p, l.key)
			}
			l.mu.Unlock()
			if e := l.m.Check(context.Background()); e == nil {
				t.Fatal("bad update accepted")
			}
			l.quality("v1")
			l.restart()
			l.quality("v1")
			l.offer(2, script("v2", success("v2")), "v2")
			l.check()
			l.quality("v2")
		})
	}
}
func TestExecutionFaultRollsBackButUpstreamDoesNot(t *testing.T) {
	l := newLab(t)
	l.offer(1, script("good", success("good")), "good")
	l.check()
	l.quality("good")
	l.offer(2, script("upstream", `return JSON.stringify({error_code:'VIDEO_MODEL_EMPTY',error_stage:'video_tab'})`), "upstream")
	l.check()
	_, e := l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	var upstream *jsresolver.Error
	if !errors.As(e, &upstream) || l.m.Status().Version != "upstream" {
		t.Fatal("upstream incorrectly rolled back", e, l.m.Status())
	}
	// Use the known-good previous version as active again, then inject an ABI fault.
	l.offer(3, script("good", success("good")), "good")
	l.check()
	l.quality("good")
	l.offer(4, script("broken", `return 'not JSON'`), "broken")
	bad := l.env
	l.check()
	if _, e = l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"}); e == nil {
		t.Fatal("fault hidden")
	}
	l.quality("good")
	if l.m.Status().Event != "rolled_back" {
		t.Fatal(l.m.Status())
	}
	l.restart()
	l.quality("good")
	// A newer control revision cannot reactivate quarantined bytes.
	p, _ := verify(bad, l.config.PublicKey, time.Now(), true, l.config.AllowedURL)
	p.Revision = 5
	l.mu.Lock()
	l.env, _ = Sign(p, l.key)
	l.mu.Unlock()
	if l.m.Check(context.Background()) == nil {
		t.Fatal("quarantined module reactivated")
	}
}
func TestInterruptedWritesCorruptActiveAndStorageBudget(t *testing.T) {
	l := newLab(t)
	for i := 1; i <= 5; i++ {
		v := fmt.Sprint(i)
		l.offer(uint64(i), script(v, success(v)), v)
		l.check()
		l.quality(v)
	}
	os.WriteFile(filepath.Join(l.config.Dir, ".staged-interrupted"), []byte("short"), 0600)
	active := l.m.Status().SHA256
	os.WriteFile(l.m.path(active), []byte("corrupt"), 0600)
	l.restart()
	l.quality("4")
	if l.m.Status().Revision != 5 {
		t.Fatal("highwater lost", l.m.Status())
	}
	entries, _ := os.ReadDir(l.config.Dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".staged-") {
			t.Fatal("temporary file retained")
		}
	}
	if len(entries) > 3 {
		t.Fatal("unbounded module files", entries)
	}
	// A crash after script rename and before state rename leaves an orphan, not an activation.
	orphan := strings.Repeat("a", 64) + ".js"
	os.WriteFile(filepath.Join(l.config.Dir, orphan), script("orphan", success("orphan")), 0600)
	l.restart()
	l.quality("4")
	if _, e := os.Stat(filepath.Join(l.config.Dir, orphan)); !os.IsNotExist(e) {
		t.Fatal("orphan kept")
	}
}
func TestUpdateWaitsForResolveAndConcurrentChecks(t *testing.T) {
	l := newLab(t)
	entered := make(chan struct{})
	unblock := make(chan struct{})
	var once sync.Once
	l.m.cfg.Transport = func(ctx context.Context, _ resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		once.Do(func() { close(entered) })
		select {
		case <-unblock:
			return resolverwire.HTTPResponse{Status: 200}, nil
		case <-ctx.Done():
			return resolverwire.HTTPResponse{}, ctx.Err()
		}
	}
	l.offer(1, script("slow", `__resolverHost.http('GET','https://api.fqnovel.com/test',{},Buffer.from(''));`+success("slow")), "slow")
	l.check()
	resolved := make(chan error, 1)
	go func() {
		out, e := l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"})
		if e == nil && out[0].Quality != "slow" {
			e = errors.New("mixed versions")
		}
		resolved <- e
	}()
	<-entered
	l.offer(2, script("new", success("new")), "new")
	done := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { done <- l.m.Check(context.Background()) }()
	}
	select {
	case <-done:
		t.Fatal("activation closed an in-flight resolver")
	case <-time.After(40 * time.Millisecond):
	}
	close(unblock)
	if e := <-resolved; e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		if e := <-done; e != nil {
			t.Fatal(e)
		}
	}
	l.quality("new")
	l.m.Close(context.Background())
	if l.m.Check(context.Background()) == nil {
		t.Fatal("updated closed manager")
	}
	if _, e := l.m.Resolve(context.Background(), resolverwire.Request{}); e == nil {
		t.Fatal("resolved closed manager")
	}
}
func TestValidationOfRealOptimizedScript(t *testing.T) {
	l := newLab(t)
	l.config.Embedded = jsresolver.Source()
	l.config.EmbeddedVersion = jsresolver.Version
	l.config.Vectors = jsresolver.SigningVectors()
	l.config.VectorCount = jsresolver.SigningVectorCount
	m := l.open()
	defer m.Close(context.Background())
	if m.Status().Version != jsresolver.Version {
		t.Fatal(m.Status())
	}
}
func TestProxyValidationFallbackAndCredentialIsolation(t *testing.T) {
	l := newLab(t)
	// Use a bad route first to exercise validation fallback with TLS verification.
	l.m.cfg.Routes = func(raw string) []string { return []string{l.server.URL + "/bad", raw} }
	l.offer(1, script("v1", success("v1")), "v1")
	// /bad returns script bytes: invalid manifest on attempt 1, valid on attempt 2.
	l.check()
	l.quality("v1")
	if got := Routes(ManifestURL); len(got) != 5 || got[4] != ManifestURL || !strings.HasPrefix(got[0], Proxies[0]) {
		t.Fatal(got)
	}
	for _, u := range []string{"http://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/resolver-js/x.js", "https://raw.githubusercontent.com.evil/x", ManifestURL + "?token=secret", "https://raw.githubusercontent.com/aston314/hongguo-tv-releases/main/resolver-js/../x.js", ManifestURL + "#fragment"} {
		if OfficialURL(u) {
			t.Fatal("unsafe URL", u)
		}
	}
}

func TestActivationStorageFailureAndCancelledResolve(t *testing.T) {
	l := newLab(t)
	l.offer(1, script("v1", success("v1")), "v1")
	l.check()
	statePath := filepath.Join(l.config.Dir, "state.json")
	saved, e := os.ReadFile(statePath)
	if e != nil {
		t.Fatal(e)
	}
	os.Remove(statePath)
	os.Mkdir(statePath, 0700)
	l.offer(2, script("v2", success("v2")), "v2")
	if l.m.Check(context.Background()) == nil {
		t.Fatal("failed state write activated module")
	}
	l.quality("v1")
	os.Remove(statePath)
	os.WriteFile(statePath, saved, 0600)
	l.restart()
	l.quality("v1")
	entered := make(chan struct{})
	l.m.cfg.Transport = func(ctx context.Context, _ resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		close(entered)
		<-ctx.Done()
		return resolverwire.HTTPResponse{}, ctx.Err()
	}
	l.offer(2, script("slow", `__resolverHost.http('GET','https://api.fqnovel.com/test',{},Buffer.from(''));`+success("slow")), "slow")
	l.check()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, e := l.m.Resolve(ctx, resolverwire.Request{VID: "123"}); done <- e }()
	<-entered
	cancel()
	if !errors.Is(<-done, context.Canceled) || l.m.Status().Version != "slow" {
		t.Fatal("cancellation caused rollback", l.m.Status())
	}
}
func TestRepeatedRevisionKeepsDistinctRollback(t *testing.T) {
	l := newLab(t)
	l.offer(1, script("good", success("good")), "good")
	l.check()
	l.quality("good")
	broken := script("broken", `return 'invalid ABI'`)
	l.offer(2, broken, "broken")
	l.check()
	l.offer(3, broken, "broken")
	l.check()
	l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	l.quality("good")
}
func TestSignatureCoversEveryControlAndModuleField(t *testing.T) {
	l := newLab(t)
	l.offer(1, script("v1", success("v1")), "v1")

	decoded, _ := verify(l.env, l.config.PublicKey, time.Now(), true, l.config.AllowedURL)
	original, _ := json.Marshal(decoded)
	for _, field := range []string{"schema", "product", "revision", "enabled", "issued_at", "expires_at", "module"} {
		copy := map[string]any{}
		json.Unmarshal(original, &copy)
		copy[field] = nil
		changed, _ := json.Marshal(copy)
		env := l.env
		env.Payload = base64.StdEncoding.EncodeToString(changed)
		if _, e := verify(env, l.config.PublicKey, time.Now(), true, l.config.AllowedURL); e == nil {
			t.Fatal("unsigned field accepted", field)
		}
	}
}

func TestUnverifiedUpdatesDoNotDisplaceVerifiedFallback(t *testing.T) {
	l := newLab(t)
	l.offer(1, script("good", success("good")), "good")
	l.check()
	l.quality("good")
	for i := 2; i <= 5; i++ {
		v := fmt.Sprint(i)
		l.offer(uint64(i), script(v, `return 'invalid ABI'`), v)
		l.check()
	}
	l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	l.quality("good")
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestRollbackDuringDownloadCannotReactivateQuarantinedHash(t *testing.T) {
	l := newLab(t)
	l.offer(1, script("good", success("good")), "good")
	l.check()
	l.quality("good")
	broken := script("bad", `return 'invalid ABI'`)
	l.offer(2, broken, "bad")
	l.check()
	entered, unblock := make(chan struct{}), make(chan struct{})
	client := *l.m.cfg.Client
	base := client.Transport
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/script" {
			close(entered)
			select {
			case <-unblock:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		return base.RoundTrip(r)
	})
	l.m.cfg.Client = &client
	l.offer(3, broken, "bad")
	done := make(chan error, 1)
	go func() { done <- l.m.Check(context.Background()) }()
	<-entered
	l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	l.quality("good")
	close(unblock)
	if e := <-done; e == nil || e.Error() != "module_quarantined" {
		t.Fatal("race reactivated bad module", e)
	}
	l.quality("good")
}
func TestInvalidCallerInputCannotRollbackScript(t *testing.T) {
	l := newLab(t)
	l.offer(1, script("v1", success("v1")), "v1")
	l.check()
	_, e := l.m.Resolve(context.Background(), resolverwire.Request{VID: strings.Repeat("1", resolverwire.MaxRequest+1)})
	if !errors.Is(e, jsresolver.ErrRequest) || l.m.Status().Version != "v1" {
		t.Fatal(e, l.m.Status())
	}
}

func TestCloseCancelsUpdateWithoutAbortingCurrentResolve(t *testing.T) {
	l := newLab(t)
	entered, unblock := make(chan struct{}), make(chan struct{})
	l.m.cfg.Transport = func(ctx context.Context, _ resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		close(entered)
		select {
		case <-unblock:
			return resolverwire.HTTPResponse{Status: 200}, nil
		case <-ctx.Done():
			return resolverwire.HTTPResponse{}, ctx.Err()
		}
	}
	l.offer(1, script("slow", `__resolverHost.http('GET','https://api.fqnovel.com/test',{},Buffer.from(''));`+success("slow")), "slow")
	l.check()
	resolveDone := make(chan error, 1)
	go func() { _, e := l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"}); resolveDone <- e }()
	<-entered
	l.offer(2, script("v2", success("v2")), "v2")
	updateDone := make(chan error, 1)
	go func() { updateDone <- l.m.Check(context.Background()) }()
	// The updater may be fetching or waiting for the current Resolve. Either path
	// must be cancelled by Close; the existing playback request must finish intact.
	closeDone := make(chan error, 1)
	go func() { closeDone <- l.m.Close(context.Background()) }()
	select {
	case <-resolveDone:
		t.Fatal("Close aborted the current Resolve")
	case <-time.After(25 * time.Millisecond):
	}
	close(unblock)
	if e := <-resolveDone; e != nil {
		t.Fatal(e)
	}
	if e := <-closeDone; e != nil {
		t.Fatal(e)
	}
	if e := <-updateDone; e == nil {
		t.Fatal("update committed during shutdown")
	}
}

func TestRollbackReportsActualActiveRevisionForAnnouncementMatching(t *testing.T) {
	l := newLab(t)
	l.offer(1, script("good", success("good")), "good")
	l.check()
	l.quality("good")
	l.offer(2, script("bad", `return JSON.stringify({error_code:'RESOLVER_SCRIPT_FAILED',error_stage:'resolver_js'})`), "bad")
	l.check()
	l.m.Resolve(context.Background(), resolverwire.Request{VID: "123"})
	status := l.m.Status()
	if status.Revision != 2 || status.ActiveRevision != 1 {
		t.Fatal("control high-water mistaken for accepted rule", status)
	}
	l.quality("good")
}
