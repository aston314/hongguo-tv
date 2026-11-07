package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

const normalMinWidth, normalMinHeight = 960, 540

type windowGeometry struct{ X, Y, Width, Height int }

// One window and one WebView retain ownership of playback in both modes.
// The small interface also lets tests exercise asynchronous fullscreen exits.
type miniPlayerWindow interface {
	geometry() windowGeometry
	setGeometry(windowGeometry)
	setMinimum(int, int)
	setTopmost(bool)
	fullscreen() bool
	setFullscreen(bool)
	maximised() bool
	setMaximised(bool)
	center()
	display() (string, int, int)
}

type miniPlayerWindowState struct {
	Active bool   `json:"active"`
	Error  string `json:"error,omitempty"`
}

type miniPlayerController struct {
	mu                          sync.Mutex
	active                      atomic.Bool
	normal, small               windowGeometry
	wasFullscreen, wasMaximised bool
	displayID, smallDisplayID   string
}

func (m *miniPlayerController) state() miniPlayerWindowState {
	return miniPlayerWindowState{Active: m.active.Load()}
}

func waitWindowChange(pending func() bool) error {
	deadline := time.Now().Add(3 * time.Second)
	for pending() {
		if time.Now().After(deadline) {
			return errors.New("window transition timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return nil
}

func (m *miniPlayerController) set(w miniPlayerWindow, enabled, portrait bool) miniPlayerWindowState {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active.Load() == enabled {
		return miniPlayerWindowState{Active: m.active.Load()}
	}
	if enabled {
		m.wasFullscreen, m.wasMaximised = w.fullscreen(), w.maximised()
		if m.wasFullscreen {
			w.setFullscreen(false)
			if err := waitWindowChange(w.fullscreen); err != nil {
				return miniPlayerWindowState{Error: err.Error()}
			}
		}
		if w.maximised() {
			m.wasMaximised = true
			w.setMaximised(false)
			if err := waitWindowChange(w.maximised); err != nil {
				if m.wasFullscreen {
					w.setFullscreen(true)
				}
				return miniPlayerWindowState{Error: err.Error()}
			}
		}
		m.normal = w.geometry()
		id, width, height := w.display()
		m.displayID = id
		small := m.small
		remembered := small.Width > 0 && m.smallDisplayID == id
		if !remembered {
			small = windowGeometry{Width: 480, Height: 300}
			if portrait {
				small.Width, small.Height = 320, 568
			}
		}
		if width > 0 && small.Width > width-40 {
			small.Width = width - 40
		}
		if height > 0 && small.Height > height-80 {
			small.Height = height - 80
		}
		w.setMinimum(280, 200)
		w.setGeometry(small)
		if !remembered {
			w.center()
		}
		w.setTopmost(true)
		m.active.Store(true)
	} else {
		// Native title-bar fullscreen/maximise can also be used in the small
		// window. Leave those states before restoring the saved normal bounds.
		if w.fullscreen() {
			w.setFullscreen(false)
			if err := waitWindowChange(w.fullscreen); err != nil {
				return miniPlayerWindowState{Active: true, Error: err.Error()}
			}
		}
		if w.maximised() {
			w.setMaximised(false)
			if err := waitWindowChange(w.maximised); err != nil {
				return miniPlayerWindowState{Active: true, Error: err.Error()}
			}
		}
		m.small = w.geometry()
		id, _, _ := w.display()
		m.smallDisplayID = id
		w.setTopmost(false)
		w.setMinimum(normalMinWidth, normalMinHeight)
		w.setGeometry(m.normal)
		if id != m.displayID {
			w.center()
		}
		m.active.Store(false)
		if m.wasMaximised {
			w.setMaximised(true)
		}
		if m.wasFullscreen {
			w.setFullscreen(true)
		}
	}
	return miniPlayerWindowState{Active: m.active.Load()}
}
