package jsupdate

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
)

func readBounded(path string, limit int) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if e != nil || len(b) > limit {
		return nil, errors.New("saved_file_rejected")
	}
	return b, nil
}

type jsLoaded struct{ runtime *jsresolver.Resolver }

func (m *Manager) saved(ctx context.Context, env *Envelope) (*jsLoaded, error) {
	if env == nil {
		return nil, errors.New("no_saved_module")
	}
	p, e := verify(*env, m.cfg.PublicKey, m.cfg.Now(), false, m.cfg.AllowedURL)
	if e != nil || !p.Enabled || p.Revision > m.Status().Revision {
		return nil, errors.New("saved_manifest_rejected")
	}
	for _, bad := range m.state.Quarantine {
		if bad == p.Module.SHA256 {
			return nil, errors.New("saved_module_quarantined")
		}
	}
	b, e := readBounded(m.path(p.Module.SHA256), p.Module.Size)
	if e != nil || len(b) != p.Module.Size || digest(b) != p.Module.SHA256 {
		return nil, errors.New("saved_digest_rejected")
	}
	r, e := m.load(ctx, b, p.Module.Version)
	if e != nil {
		return nil, e
	}
	return &jsLoaded{r}, nil
}
func (m *Manager) restore(ctx context.Context) {
	b, e := readBounded(filepath.Join(m.cfg.Dir, "state.json"), 4*MaxManifest)
	if os.IsNotExist(e) {
		return
	}
	var s diskState
	if e != nil || strictJSON(b, &s) != nil || s.Schema != 1 || s.Control == nil || len(s.Quarantine) > 8 {
		m.setStatus("state_rejected")
		return
	}
	c, e := verify(*s.Control, m.cfg.PublicKey, m.cfg.Now(), false, m.cfg.AllowedURL)
	if e != nil {
		m.setStatus("state_rejected")
		return
	}
	for _, sha := range s.Quarantine {
		if !digestRE.MatchString(sha) {
			m.setStatus("state_rejected")
			return
		}
	}
	m.state = s
	if !c.Enabled {
		m.state.Active = nil
		m.state.Previous = nil
		m.state.ActiveVerified = false
		m.setStatus("disabled_restored")
		return
	}
	m.setStatus("restoring")
	if loaded, e := m.saved(ctx, s.Active); e == nil {
		old := m.runtime
		m.runtime = loaded.runtime
		old.Close(context.Background())
		m.setStatus("restored")
		return
	}
	// Preserve the signed control/high-water revision even when the active bytes
	// were damaged. Fall back to the previous verified module, then embedded.
	m.rollback(ctx)
}
func (m *Manager) rollback(ctx context.Context) {
	s := m.state
	if s.Active != nil {
		a, e := verify(*s.Active, m.cfg.PublicKey, m.cfg.Now(), false, m.cfg.AllowedURL)
		if e == nil && a.Module != nil {
			s.Quarantine = append(append([]string(nil), s.Quarantine...), a.Module.SHA256)
			if len(s.Quarantine) > 8 {
				s.Quarantine = s.Quarantine[len(s.Quarantine)-8:]
			}
		}
	}
	s.Active = nil
	s.ActiveVerified = false
	s.Previous = nil
	var next *jsresolver.Resolver
	previous := m.state.Previous
	if previous != nil && m.state.Active != nil {
		a, ae := verify(*m.state.Active, m.cfg.PublicKey, m.cfg.Now(), false, m.cfg.AllowedURL)
		p, pe := verify(*previous, m.cfg.PublicKey, m.cfg.Now(), false, m.cfg.AllowedURL)
		if ae == nil && pe == nil && a.Module != nil && p.Module != nil && a.Module.SHA256 == p.Module.SHA256 {
			previous = nil
		}
	}
	if old, e := m.saved(ctx, previous); e == nil {
		next = old.runtime
		s.Active = previous
		s.ActiveVerified = true
	}
	if next == nil {
		r, e := m.load(ctx, m.cfg.Embedded, m.cfg.EmbeddedVersion)
		if e != nil {
			m.setStatus("rollback_load_failed")
			return
		}
		next = r
	}
	if e := m.persist(s); e != nil {
		next.Close(context.Background())
		m.setStatus("rollback_storage_failed")
		return
	}
	old := m.runtime
	m.runtime = next
	m.state = s
	old.Close(context.Background())
	m.setStatus("rolled_back")
	m.prune()
}
func (m *Manager) prune() {
	keep := map[string]bool{}
	for _, env := range []*Envelope{m.state.Active, m.state.Previous} {
		if env != nil {
			p, e := verify(*env, m.cfg.PublicKey, m.cfg.Now(), false, m.cfg.AllowedURL)
			if e == nil && p.Module != nil {
				keep[p.Module.SHA256+".js"] = true
			}
		}
	}
	entries, _ := os.ReadDir(m.cfg.Dir)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && (strings.HasPrefix(name, ".staged-") || strings.HasSuffix(name, ".js") && digestRE.MatchString(strings.TrimSuffix(name, ".js")) && !keep[name]) {
			os.Remove(filepath.Join(m.cfg.Dir, name))
		}
	}
}
