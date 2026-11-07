package main

import (
	"sync"
	"testing"
)

type testMiniWindow struct {
	g                                   windowGeometry
	full, max, top                      bool
	minWidth, minHeight, centers, sizes int
	displayID                           string
	fullChecks                          int
	exitDelay                           int
	normal                              windowGeometry
}

func (w *testMiniWindow) geometry() windowGeometry     { return w.g }
func (w *testMiniWindow) setGeometry(g windowGeometry) { w.g = g; w.sizes++ }
func (w *testMiniWindow) setMinimum(x, y int)          { w.minWidth, w.minHeight = x, y }
func (w *testMiniWindow) setTopmost(v bool)            { w.top = v }
func (w *testMiniWindow) fullscreen() bool {
	if w.fullChecks > 0 {
		w.fullChecks--
		if w.fullChecks == 0 {
			w.full = false
			w.g = w.normal
		}
	}
	return w.full
}
func (w *testMiniWindow) setFullscreen(v bool) {
	if !v && w.exitDelay > 0 {
		w.fullChecks = w.exitDelay
		return
	}
	w.full = v
	if !v {
		w.g = w.normal
	}
}
func (w *testMiniWindow) maximised() bool { return w.max }
func (w *testMiniWindow) setMaximised(v bool) {
	w.max = v
	if !v {
		w.g = w.normal
	}
}
func (w *testMiniWindow) center()                     { w.centers++ }
func (w *testMiniWindow) display() (string, int, int) { return w.displayID, 1920, 1080 }
func newTestMiniWindow() *testMiniWindow {
	g := windowGeometry{100, 80, 1280, 800}
	return &testMiniWindow{g: g, normal: g, displayID: "screen-a"}
}
func TestMiniPlayerRetainsNormalAndUserResizedSmallGeometry(t *testing.T) {
	w := newTestMiniWindow()
	var m miniPlayerController
	if s := m.set(w, true, true); !s.Active || s.Error != "" {
		t.Fatal(s)
	}
	if w.g.Width != 320 || w.g.Height != 568 || !w.top || w.minWidth != 280 {
		t.Fatalf("small window: %+v", w)
	}
	w.g = windowGeometry{900, 200, 360, 600}
	if s := m.set(w, false, false); s.Active || s.Error != "" {
		t.Fatal(s)
	}
	if w.g != w.normal || w.top || w.minWidth != 960 || w.minHeight != 540 {
		t.Fatalf("normal window: %+v", w)
	}
	m.set(w, true, false)
	if w.g != (windowGeometry{900, 200, 360, 600}) || w.centers != 1 {
		t.Fatalf("small bounds were not remembered: %+v", w)
	}
}
func TestMiniPlayerRestoresFullscreenAndMaximisedModes(t *testing.T) {
	for _, mode := range []string{"fullscreen", "maximised"} {
		t.Run(mode, func(t *testing.T) {
			w := newTestMiniWindow()
			w.full = mode == "fullscreen"
			w.max = mode == "maximised"
			w.g = windowGeometry{0, 0, 1920, 1080}
			var m miniPlayerController
			m.set(w, true, false)
			if w.full || w.max || w.g.Width != 480 {
				t.Fatalf("did not leave native mode: %+v", w)
			}
			m.set(w, false, false)
			if w.g != w.normal || w.full != (mode == "fullscreen") || w.max != (mode == "maximised") {
				t.Fatalf("restore: %+v", w)
			}
		})
	}
}
func TestMiniPlayerDuplicateRequestsDoNotOverwriteSavedBounds(t *testing.T) {
	w := newTestMiniWindow()
	var m miniPlayerController
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); m.set(w, true, true) }()
	}
	wg.Wait()
	if w.sizes != 1 || !m.state().Active {
		t.Fatalf("repeated entry: %+v", w)
	}
	m.set(w, false, false)
	if w.g != w.normal {
		t.Fatal("duplicate entry lost normal geometry")
	}
}
func TestMiniPlayerRecentersAfterDisplayChanges(t *testing.T) {
	w := newTestMiniWindow()
	var m miniPlayerController
	m.set(w, true, false)
	w.displayID = "screen-b"
	m.set(w, false, false)
	if w.centers != 2 {
		t.Fatal("restored off-screen geometry after display change")
	}
}

func TestMiniPlayerWaitsForNativeFullscreenExitBeforeSavingNormalBounds(t *testing.T) {
	w := newTestMiniWindow()
	w.full, w.exitDelay = true, 3
	w.g = windowGeometry{0, 0, 1920, 1080}
	var m miniPlayerController
	if s := m.set(w, true, true); !s.Active || s.Error != "" {
		t.Fatal(s)
	}
	if m.normal != w.normal {
		t.Fatal("captured fullscreen bounds before the native exit completed")
	}
	m.set(w, false, false)
	if w.g != w.normal || !w.full {
		t.Fatalf("lost fullscreen or normal bounds: %+v", w)
	}
}
