package jsupdate

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

type Config struct {
	Dir, ManifestURL                             string
	PublicKey                                    ed25519.PublicKey
	Embedded                                     []byte
	EmbeddedVersion                              string
	Vectors                                      []byte
	VectorCount                                  uint32
	Transport                                    jsresolver.Transport
	Client                                       *http.Client
	AllowedURL                                   func(string) bool
	Routes                                       func(string) []string
	Now                                          func() time.Time
	RouteTimeout, UpdateTimeout, ValidateTimeout time.Duration
	// Optional data-only runtime. Defaults retain the existing JS wire contract.
	Product, Extension string
	MaxArtifact        int
	Loader             func(context.Context, []byte, string) (Runtime, error)
}
type Runtime interface {
	Resolve(context.Context, resolverwire.Request) ([]resolverwire.Option, error)
	Close(context.Context) error
}
type diskState struct {
	ActiveVerified bool      `json:"active_verified"`
	Schema         int       `json:"schema"`
	Control        *Envelope `json:"control"`
	Active         *Envelope `json:"active"`
	Previous       *Envelope `json:"previous"`
	Quarantine     []string  `json:"quarantine"`
}
type Status struct {
	Automatic         bool   `json:"automatic,omitempty"`
	Format            string `json:"format,omitempty"`
	ActiveRevision    uint64 `json:"active_revision"`
	Source            string `json:"source"`
	Version           string `json:"version"`
	SHA256            string `json:"sha256"`
	Revision          uint64 `json:"revision"`
	Enabled           bool   `json:"enabled"`
	Event             string `json:"event"`
	VerifiedByResolve bool   `json:"verified_by_resolve"`
}
type Manager struct {
	cfg           Config
	life          context.Context
	cancel        context.CancelFunc
	gate, updater chan struct{}
	runtime       Runtime   // only gate owner may use/close it
	state         diskState // only gate owner may read/write it
	status        atomic.Value
}

func acquire(ctx context.Context, gate chan struct{}) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-gate:
		return nil
	}
}
func release(gate chan struct{}) { gate <- struct{}{} }

func New(ctx context.Context, cfg Config) (*Manager, error) {
	if cfg.Dir == "" || len(cfg.PublicKey) != ed25519.PublicKeySize || len(cfg.Embedded) == 0 || cfg.EmbeddedVersion == "" || cfg.Loader == nil && (cfg.VectorCount == 0 || len(cfg.Vectors) == 0 || cfg.Transport == nil) {
		return nil, errors.New("invalid_update_config")
	}
	if cfg.Product == "" {
		cfg.Product = Product
	}
	if cfg.Extension == "" {
		cfg.Extension = ".js"
	}
	if cfg.MaxArtifact == 0 {
		cfg.MaxArtifact = jsresolver.MaxScript
	}
	if cfg.Product != Product && cfg.Product != ProfileProduct || cfg.Extension != ".js" && cfg.Extension != ".json" || cfg.MaxArtifact < 1 || cfg.MaxArtifact > jsresolver.MaxScript {
		return nil, errors.New("invalid_artifact_policy")
	}
	if cfg.Product == ProfileProduct && (cfg.Loader == nil || cfg.Extension != ".json" || cfg.MaxArtifact > MaxProfile) {
		return nil, errors.New("invalid_profile_policy")
	}
	cfg.PublicKey = append(ed25519.PublicKey(nil), cfg.PublicKey...)
	cfg.Embedded = append([]byte(nil), cfg.Embedded...)
	cfg.Vectors = append([]byte(nil), cfg.Vectors...)
	if cfg.Client == nil {
		cfg.Client = defaultClient()
	}
	if cfg.AllowedURL == nil {
		cfg.AllowedURL = OfficialURL
	}
	if cfg.Routes == nil {
		cfg.Routes = Routes
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.RouteTimeout == 0 {
		cfg.RouteTimeout = 4 * time.Second
	}
	if cfg.UpdateTimeout == 0 {
		cfg.UpdateTimeout = 60 * time.Second
	}
	if cfg.ValidateTimeout == 0 {
		cfg.ValidateTimeout = 3 * time.Second
	}
	if !cfg.AllowedURL(cfg.ManifestURL) {
		return nil, errors.New("manifest_url_rejected")
	}
	if e := os.MkdirAll(cfg.Dir, 0700); e != nil {
		return nil, errors.New("update_storage_unavailable")
	}
	life, cancel := context.WithCancel(context.Background())
	m := &Manager{cfg: cfg, life: life, cancel: cancel, gate: make(chan struct{}, 1), updater: make(chan struct{}, 1), state: diskState{Schema: 1}}
	release(m.gate)
	release(m.updater)
	r, e := m.load(ctx, cfg.Embedded, cfg.EmbeddedVersion)
	if e != nil {
		cancel()
		return nil, e
	}
	m.runtime = r
	m.setStatus("embedded_ready")
	m.restore(ctx)
	m.prune()
	return m, nil
}
func (m *Manager) load(ctx context.Context, b []byte, version string) (Runtime, error) {
	check, stop := context.WithTimeout(ctx, m.cfg.ValidateTimeout)
	defer stop()
	if len(b) > m.cfg.MaxArtifact {
		return nil, errors.New("artifact_size_rejected")
	}
	if m.cfg.Loader != nil {
		return m.cfg.Loader(check, b, version)
	}
	// Neither top-level code, metadata nor self-test may make network requests.
	var live, attempted atomic.Bool
	do := func(ctx context.Context, in resolverwire.HTTPRequest) (resolverwire.HTTPResponse, error) {
		if !live.Load() {
			attempted.Store(true)
			return resolverwire.HTTPResponse{}, errors.New("validation_http_disabled")
		}
		return m.cfg.Transport(ctx, in)
	}
	r, e := jsresolver.New(check, b, do)
	if e != nil {
		return nil, errors.New("script_load_failed")
	}
	valid := false
	defer func() {
		if !valid {
			r.Close(context.Background())
		}
	}()
	md, e := r.Metadata(check)
	if e != nil || md.Name != "hongguo-playback-resolver" || md.Version != version || md.Protocol != 1 || !md.NativeSM3 {
		return nil, errors.New("script_metadata_rejected")
	}
	count, e := r.SelfTest(check, m.cfg.Vectors)
	if e != nil || count != m.cfg.VectorCount || attempted.Load() {
		return nil, errors.New("script_selftest_failed")
	}
	live.Store(true)
	valid = true
	return r, nil
}
func (m *Manager) Status() Status { return m.status.Load().(Status) }
func (m *Manager) setStatus(event string) {
	s := Status{VerifiedByResolve: m.state.ActiveVerified, Source: "embedded", Version: m.cfg.EmbeddedVersion, SHA256: digest(m.cfg.Embedded), Event: event}
	if m.cfg.Product == ProfileProduct {
		s.Automatic = true
		s.Format = "json"
	}
	if m.state.Control != nil {
		c, _ := m.verify(*m.state.Control, false)
		s.Revision = c.Revision
		s.Enabled = c.Enabled
	}
	if m.state.Active != nil {
		a, _ := m.verify(*m.state.Active, false)
		if a.Module != nil {
			s.Source = "downloaded"
			s.ActiveRevision = a.Revision
			s.Version = a.Module.Version
			s.SHA256 = a.Module.SHA256
		}
	}
	m.status.Store(s)
}
func (m *Manager) Resolve(ctx context.Context, in resolverwire.Request) ([]resolverwire.Option, error) {
	if e := acquire(ctx, m.gate); e != nil {
		return nil, e
	}
	defer release(m.gate)
	if m.life.Err() != nil {
		return nil, errors.New("manager_closed")
	}
	out, e := m.runtime.Resolve(ctx, in)
	var upstream *jsresolver.Error
	// A typed business/upstream failure, cancellation, or timeout is NOT evidence
	// that the script is broken. Only host-observed ABI/execution violations roll back.
	if e != nil && ctx.Err() == nil && !errors.Is(e, context.Canceled) && !errors.Is(e, context.DeadlineExceeded) && (!errors.As(e, &upstream) || upstream.Code == "RESOLVER_SCRIPT_FAILED") && !errors.Is(e, jsresolver.ErrRequest) && m.state.Active != nil {
		repair, stop := context.WithTimeout(m.life, m.cfg.ValidateTimeout)
		m.rollback(repair)
		stop()
	}
	if e == nil && m.state.Active != nil && !m.state.ActiveVerified {
		s := m.state
		s.ActiveVerified = true
		if m.persist(s) == nil {
			m.state = s
			m.setStatus("resolve_verified")
		} else {
			m.setStatus("verification_storage_failed")
		}
	}
	return out, e // Never silently retry a request with a second algorithm.
}
func (m *Manager) Close(ctx context.Context) error {
	m.cancel()
	if e := acquire(ctx, m.updater); e != nil {
		return e
	}
	defer release(m.updater)
	if e := acquire(ctx, m.gate); e != nil {
		return e
	}
	defer release(m.gate)
	if m.runtime == nil {
		return nil
	}
	e := m.runtime.Close(ctx)
	if e == nil {
		m.runtime = nil
	}
	return e
}
func (m *Manager) Check(ctx context.Context) error {
	if e := acquire(ctx, m.updater); e != nil {
		return e
	}
	defer release(m.updater)
	if m.life.Err() != nil {
		return errors.New("manager_closed")
	}
	job, stop := context.WithTimeout(ctx, m.cfg.UpdateTimeout)
	defer stop()
	unlink := context.AfterFunc(m.life, stop)
	defer unlink()
	var env Envelope
	var manifest Manifest
	_, e := m.fetch(job, m.cfg.ManifestURL, MaxManifest, func(b []byte) error {
		if strictJSON(b, &env) != nil {
			return errors.New("manifest_json_rejected")
		}
		var err error
		manifest, err = m.verify(env, true)
		return err
	})
	if e != nil {
		return m.event(job, "update_unavailable", e)
	}
	if e := acquire(job, m.gate); e != nil {
		return e
	}
	current := m.Status()
	if manifest.Revision < current.Revision {
		release(m.gate)
		return errors.New("revision_replayed")
	}
	if manifest.Revision == current.Revision {
		same := m.state.Control != nil && *m.state.Control == env
		release(m.gate)
		if !same {
			return errors.New("revision_conflict")
		}
		return nil
	}
	if manifest.Enabled {
		for _, sha := range m.state.Quarantine {
			if sha == manifest.Module.SHA256 {
				release(m.gate)
				return errors.New("module_quarantined")
			}
		}
		for _, old := range []*Envelope{m.state.Active, m.state.Previous} {
			if old != nil {
				p, _ := m.verify(*old, false)
				if p.Module != nil && p.Module.Version == manifest.Module.Version && p.Module.SHA256 != manifest.Module.SHA256 {
					release(m.gate)
					return errors.New("version_content_conflict")
				}
			}
		}
	}
	release(m.gate)
	var artifactBytes []byte
	if manifest.Enabled {
		a := manifest.Module
		b, err := m.fetch(job, a.URL, a.Size, func(b []byte) error {
			if len(b) != a.Size || digest(b) != a.SHA256 {
				return errors.New("script_digest_rejected")
			}
			return nil
		})
		if err != nil {
			return m.event(job, "script_download_failed", err)
		}
		artifactBytes = b
	}
	// This waits for the entire current Resolve, including any queued VM call.
	// No old runtime can be closed or mixed into a call already in progress.
	if e := acquire(job, m.gate); e != nil {
		return e
	}
	defer release(m.gate)
	if m.life.Err() != nil || job.Err() != nil {
		return errors.New("update_cancelled")
	}
	// Rollback may have run while bytes were downloading. Recheck the live
	// quarantine under the activation gate before compiling or persisting them.
	if manifest.Enabled {
		for _, bad := range m.state.Quarantine {
			if bad == manifest.Module.SHA256 {
				return errors.New("module_quarantined")
			}
		}
	}
	source, version := m.cfg.Embedded, m.cfg.EmbeddedVersion
	if manifest.Enabled {
		source, version = artifactBytes, manifest.Module.Version
	}
	next, err := m.load(job, source, version)
	if err != nil {
		m.setStatus("candidate_rejected")
		return err
	}
	defer func() {
		if next != nil {
			next.Close(context.Background())
		}
	}()
	state := m.state
	state.Control = &env
	event := "remote_disabled"
	if manifest.Enabled {
		if state.Active != nil && state.ActiveVerified {
			previous, _ := m.verify(*state.Active, false)
			if previous.Module == nil || previous.Module.SHA256 != manifest.Module.SHA256 {
				state.Previous = state.Active
			}
		}
		if state.Active == nil {
			state.ActiveVerified = false
		} else {
			p, _ := m.verify(*state.Active, false)
			if p.Module == nil || p.Module.SHA256 != manifest.Module.SHA256 {
				state.ActiveVerified = false
			}
		}
		state.Active = &env
		if e := atomicWrite(m.path(manifest.Module.SHA256), artifactBytes); e != nil {
			return errors.New("script_storage_failed")
		}
		event = "activated"
	} else {
		state.Active = nil
		state.Previous = nil
		state.ActiveVerified = false
	}
	if e := m.persist(state); e != nil {
		m.prune()
		return errors.New("activation_storage_failed")
	}
	old := m.runtime
	m.runtime = next
	next = nil
	m.state = state
	m.setStatus(event)
	old.Close(context.Background())
	m.prune()
	return nil
}
func (m *Manager) event(ctx context.Context, event string, err error) error {
	if acquire(ctx, m.gate) == nil {
		m.setStatus(event)
		release(m.gate)
	}
	return err
}
func (m *Manager) path(sha string) string { return filepath.Join(m.cfg.Dir, sha+m.cfg.Extension) }
func (m *Manager) verify(env Envelope, incoming bool) (Manifest, error) {
	return verifyPolicy(env, m.cfg.PublicKey, m.cfg.Now(), incoming, m.cfg.AllowedURL, m.cfg.Product, m.cfg.MaxArtifact)
}
func (m *Manager) persist(s diskState) error {
	b, e := json.Marshal(s)
	if e != nil {
		return e
	}
	return atomicWrite(filepath.Join(m.cfg.Dir, "state.json"), b)
}
func atomicWrite(path string, b []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".staged-*")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, path); e != nil {
		return e
	}
	// The rename is the commit point. A post-rename directory-sync failure must
	// not leave memory using a different committed state from disk.
	if d, e := os.Open(filepath.Dir(path)); e == nil {
		d.Sync()
		d.Close()
	}
	return nil
}
