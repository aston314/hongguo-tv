package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aston314/hongguo-tv/core/internal/jsresolver"
	"github.com/aston314/hongguo-tv/core/internal/jsupdate"
	"github.com/aston314/hongguo-tv/core/internal/resolverwire"
)

type repairRuntime interface {
	Resolve(context.Context, resolverwire.Request) ([]resolverwire.Option, error)
	Check(context.Context) error
	Close(context.Context) error
	Status() jsupdate.Status
}
type playbackRepairStatus struct {
	NativeProfile *nativeProfileStatus `json:"native_profile,omitempty"`
	Revision      uint64               `json:"revision"`
	Supported     bool                 `json:"supported"`
	Enabled       bool                 `json:"enabled"`
	Checking      bool                 `json:"checking"`
	Source        string               `json:"source"`
	Version       string               `json:"version,omitempty"`
	LastChecked   int64                `json:"last_checked,omitempty"`
	LastUpdated   int64                `json:"last_updated,omitempty"`
	Event         string               `json:"event"`
	Change        uint64               `json:"change"`
}
type playbackRepairService struct {
	mu                        sync.Mutex
	gate                      chan struct{}
	life                      context.Context
	cancel                    context.CancelFunc
	dir                       string
	enabled, checking, closed bool
	generation                uint64
	manager                   repairRuntime
	retired                   []repairRuntime
	checkCancel               context.CancelFunc
	lastChecked, lastUpdated  int64
	event                     string
	change                    uint64
	factory                   func(context.Context) (repairRuntime, error)
}

var defaultPlaybackRepair atomic.Pointer[playbackRepairService]

func newPlaybackRepairService(dir string) *playbackRepairService {
	life, cancel := context.WithCancel(context.Background())
	s := &playbackRepairService{dir: dir, life: life, cancel: cancel, gate: make(chan struct{}, 1), event: "native"}
	s.gate <- struct{}{}
	s.factory = func(ctx context.Context) (repairRuntime, error) {
		return jsupdate.New(ctx, jsupdate.Config{Dir: filepath.Join(dir, "playback-repair", "modules"), ManifestURL: jsupdate.ManifestURL, PublicKey: jsupdate.PublicKey(), Embedded: jsresolver.Source(), EmbeddedVersion: jsresolver.Version, Vectors: jsresolver.SigningVectors(), VectorCount: jsresolver.SigningVectorCount, Transport: jsresolver.HTTPTransport(&http.Client{Timeout: 8 * time.Second})})
	}
	var pref struct {
		Enabled bool `json:"enabled"`
	}
	if b, e := os.ReadFile(s.preferencePath()); e == nil && len(b) < 1024 && json.Unmarshal(b, &pref) == nil {
		s.enabled = pref.Enabled
	}
	return s
}
func (s *playbackRepairService) preferencePath() string {
	return filepath.Join(s.dir, "playback-repair", "preference.json")
}
func (s *playbackRepairService) status() playbackRepairStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}
func (s *playbackRepairService) statusLocked() playbackRepairStatus {
	out := playbackRepairStatus{Supported: true, Enabled: s.enabled, Checking: s.checking, Source: "native", LastChecked: s.lastChecked, LastUpdated: s.lastUpdated, Event: s.event, Change: s.change}
	if automatic := defaultNativeProfile.Load(); automatic != nil {
		state := automatic.status()
		out.NativeProfile = &state
	}
	if s.enabled && s.manager != nil {
		current := s.manager.Status()
		out.Revision = current.ActiveRevision
		if current.Enabled && current.Source == "downloaded" {
			out.Source = "repair"
			out.Version = current.Version
		}
		if current.Event == "rolled_back" {
			out.Event = "rolled_back"
		}
		if !current.Enabled && current.Revision > 0 {
			out.Event = "remote_disabled"
		}
	}
	return out
}
func (s *playbackRepairService) savePreference(enabled bool) error {
	path := s.preferencePath()
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	b, _ := json.Marshal(struct {
		Enabled bool `json:"enabled"`
	}{enabled})
	f, e := os.CreateTemp(filepath.Dir(path), ".preference-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
func (s *playbackRepairService) setEnabled(enabled bool) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.New("repair_closed")
	}
	if s.enabled == enabled {
		s.mu.Unlock()
		if enabled {
			s.check()
		}
		return nil
	}
	// Persist before announcing success. Failed writes retain the old choice.
	if e := s.savePreference(enabled); e != nil {
		s.mu.Unlock()
		return errors.New("repair_preference_failed")
	}
	s.enabled = enabled
	s.generation++
	s.change++
	s.event = "native"
	if !enabled {
		if s.checkCancel != nil {
			s.checkCancel()
			s.checkCancel = nil
		}
		s.checking = false
		if s.manager != nil {
			s.retired = append(s.retired, s.manager)
			s.manager = nil
		}
	}
	s.mu.Unlock()
	if enabled {
		s.check()
	} else {
		go s.cleanupRetired()
	}
	return nil
}
func (s *playbackRepairService) cleanupRetired() {
	<-s.gate
	defer func() { s.gate <- struct{}{} }()
	s.drainRetired()
}
func (s *playbackRepairService) drainRetired() error {
	s.mu.Lock()
	old := s.retired
	s.retired = nil
	s.mu.Unlock()
	for i, m := range old {
		ctx, stop := context.WithTimeout(context.Background(), 35*time.Second)
		e := m.Close(ctx)
		stop()
		if e != nil {
			s.mu.Lock()
			s.retired = append(old[i:], s.retired...)
			s.mu.Unlock()
			return e
		}
	}
	return nil
}
func (s *playbackRepairService) check() {
	s.mu.Lock()
	if s.closed || !s.enabled || s.checking {
		s.mu.Unlock()
		return
	}
	job, stop := context.WithTimeout(s.life, 70*time.Second)
	s.checkCancel = stop
	s.checking = true
	s.event = "checking"
	s.change++
	generation := s.generation
	s.mu.Unlock()
	go func() {
		defer stop()
		var err error
		var updated bool
		select {
		case <-job.Done():
			err = job.Err()
		case <-s.gate:
			defer func() { s.gate <- struct{}{} }()
			err = s.drainRetired()
			s.mu.Lock()
			valid := !s.closed && s.enabled && generation == s.generation
			m := s.manager
			s.mu.Unlock()
			if err == nil && valid && job.Err() == nil {
				if m == nil {
					m, err = s.factory(job)
					if err == nil {
						s.mu.Lock()
						valid = !s.closed && s.enabled && generation == s.generation
						if valid {
							s.manager = m
						} else {
							s.retired = append(s.retired, m)
						}
						s.mu.Unlock()
					}
				}
				if err == nil && valid {
					before := m.Status()
					err = m.Check(job)
					after := m.Status()
					updated = err == nil && after.Enabled && after.Source == "downloaded" && after.SHA256 != before.SHA256
				}
			}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if generation != s.generation || !s.enabled || s.closed {
			return
		}
		s.checking = false
		s.checkCancel = nil
		s.lastChecked = time.Now().UnixMilli()
		s.change++
		if err != nil {
			s.event = "check_failed"
			return
		}
		s.event = "up_to_date"
		if s.manager != nil {
			current := s.manager.Status()
			if updated {
				s.lastUpdated = s.lastChecked
				s.event = "updated"
			}
			if !current.Enabled && current.Revision > 0 {
				s.event = "remote_disabled"
			}
		}
	}()
}
func (s *playbackRepairService) resolve(ctx context.Context, vid, mode, contentType string) ([]miniReelOption, error) {
	s.mu.Lock()
	m := s.manager
	enabled := s.enabled && !s.closed
	s.mu.Unlock()
	if !enabled || m == nil {
		return nil, nil
	}
	status := m.Status()
	if !status.Enabled || status.Source != "downloaded" {
		return nil, nil
	}
	out, e := m.Resolve(ctx, resolverwire.Request{VID: vid, CodecMode: mode, ContentType: contentType})
	after := m.Status()
	if after.SHA256 != status.SHA256 || after.ActiveRevision != status.ActiveRevision {
		s.mu.Lock()
		if s.manager == m {
			s.change++
			if after.Event == "rolled_back" {
				s.event = "rolled_back"
			}
		}
		s.mu.Unlock()
	}
	if e != nil {
		return nil, e
	}
	opts := make([]miniReelOption, 0, len(out))
	for _, o := range out {
		if miniReelIsByteVC2(o.Codec) {
			continue
		}
		opts = append(opts, miniReelOption(o))
	}
	return opts, nil
}
func (s *playbackRepairService) close(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	s.generation++
	s.cancel()
	if s.checkCancel != nil {
		s.checkCancel()
	}
	if s.manager != nil {
		s.retired = append(s.retired, s.manager)
		s.manager = nil
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.gate:
		defer func() { s.gate <- struct{}{} }()
		return s.drainRetired()
	}
}
func (s *server) playbackRepair(w http.ResponseWriter, r *http.Request) {
	if s.repair == nil {
		writeJSON(w, 200, map[string]any{"ok": true, "data": playbackRepairStatus{Source: "native", Event: "unsupported"}})
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]any{"ok": true, "data": s.repair.status()})
	case http.MethodPost:
		var in struct {
			Action string `json:"action"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&in) != nil || decoder.Decode(new(any)) != io.EOF {
			writeError(w, 400, "invalid repair action")
			return
		}
		var err error
		switch in.Action {
		case "enable":
			err = s.repair.setEnabled(true)
		case "disable", "restore":
			err = s.repair.setEnabled(false)
		case "check":
			if automatic := defaultNativeProfile.Load(); automatic != nil {
				automatic.check()
			}
			s.repair.check()
		default:
			writeError(w, 400, "invalid repair action")
			return
		}
		if err != nil {
			writeJSON(w, 500, map[string]any{"ok": false, "error": "REPAIR_PREFERENCE_FAILED"})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "data": s.repair.status()})
	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, 405, "method not allowed")
	}
}
