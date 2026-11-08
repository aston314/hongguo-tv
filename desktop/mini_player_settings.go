package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type miniPlayerSettings struct {
	Geometry windowGeometry `json:"geometry"`
	Display  string         `json:"display"`
}

func validSmallGeometry(g windowGeometry) bool {
	return g.Width >= 280 && g.Height >= 200 && g.Width <= 16384 && g.Height <= 16384 &&
		g.X >= -131072 && g.X <= 131072 && g.Y >= -131072 && g.Y <= 131072
}

func (m *miniPlayerController) load(path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stateFile = path
	b, err := os.ReadFile(path)
	var settings miniPlayerSettings
	if err == nil && len(b) <= 16384 && json.Unmarshal(b, &settings) == nil && validSmallGeometry(settings.Geometry) {
		m.small, m.smallDisplayID = settings.Geometry, settings.Display
	}
}

func writeMiniPlayerGeometry(path string, g windowGeometry, display string) error {
	b, err := json.Marshal(miniPlayerSettings{g, display})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	// Finish writing a temporary file before replacing the last saved geometry.
	f, err := os.CreateTemp(filepath.Dir(path), ".mini-player-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
