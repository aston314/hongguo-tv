package main

import (
	"errors"
	"os"
	"path/filepath"
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
	transitionChecks                    int
	zoomedInFullscreen                  bool
	restoreMax                          bool
	hasRestore                          bool
	titlebarHidden                      bool
	titlebarCalls                       []bool
	failHide, failRestore               bool
}

func (w *testMiniWindow) geometry() windowGeometry     { return w.g }
func (w *testMiniWindow) setGeometry(g windowGeometry) { w.g = g; w.sizes++ }
func (w *testMiniWindow) setMinimum(x, y int)          { w.minWidth, w.minHeight = x, y }
func (w *testMiniWindow) setTopmost(v bool)            { w.top = v }
func (w *testMiniWindow) setTitlebarHidden(v bool) error {
	w.titlebarCalls = append(w.titlebarCalls, v)
	if v && w.failHide || !v && w.failRestore {
		return errors.New("native style failure")
	}
	w.titlebarHidden = v
	return nil
}
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
		if w.transitionChecks == 0 {
			w.g = w.normal
		}
	}
}
func (w *testMiniWindow) maximised() bool { return w.max || w.full && w.zoomedInFullscreen }
func (w *testMiniWindow) setMaximised(v bool) {
	w.max = v
	if !v {
		w.g = w.normal
	}
}
func (w *testMiniWindow) center()      { w.centers++ }
func (w *testMiniWindow) keepVisible() {}
func (w *testMiniWindow) fullscreenRestore() (windowGeometry, bool, bool) {
	return w.normal, w.restoreMax, w.hasRestore
}
func (w *testMiniWindow) transitioning() bool {
	if w.transitionChecks > 0 && !w.full {
		w.transitionChecks--
		if w.transitionChecks == 0 {
			w.g = w.normal
		}
		return true
	}
	return false
}
func (w *testMiniWindow) display() (string, int, int) { return w.displayID, 1920, 1080 }
func newTestMiniWindow() *testMiniWindow {
	g := windowGeometry{100, 80, 1280, 800}
	return &testMiniWindow{g: g, normal: g, displayID: "screen-a"}
}
func TestMiniPlayerRetainsNormalAndUserResizedSmallGeometry(t *testing.T) {
	w := newTestMiniWindow()
	var m miniPlayerController
	if s := m.set(w, true, true, false); !s.Active || s.Error != "" {
		t.Fatal(s)
	}
	if w.g.Width != 320 || w.g.Height != 568 || !w.top || w.minWidth != 280 {
		t.Fatalf("small window: %+v", w)
	}
	w.g = windowGeometry{900, 200, 360, 600}
	if s := m.set(w, false, false, false); s.Active || s.Error != "" {
		t.Fatal(s)
	}
	if w.g != w.normal || w.top || w.minWidth != 960 || w.minHeight != 540 {
		t.Fatalf("normal window: %+v", w)
	}
	m.set(w, true, false, false)
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
			m.set(w, true, false, false)
			if w.full || w.max || w.g.Width != 480 {
				t.Fatalf("did not leave native mode: %+v", w)
			}
			m.set(w, false, false, false)
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
		go func() { defer wg.Done(); m.set(w, true, true, false) }()
	}
	wg.Wait()
	if w.sizes != 1 || !m.state().Active {
		t.Fatalf("repeated entry: %+v", w)
	}
	m.set(w, false, false, false)
	if w.g != w.normal {
		t.Fatal("duplicate entry lost normal geometry")
	}
}
func TestMiniPlayerRecentersAfterDisplayChanges(t *testing.T) {
	w := newTestMiniWindow()
	var m miniPlayerController
	m.set(w, true, false, false)
	w.displayID = "screen-b"
	m.set(w, false, false, false)
	if w.centers != 2 {
		t.Fatal("restored off-screen geometry after display change")
	}
}

func TestMiniPlayerWaitsForNativeFullscreenExitBeforeSavingNormalBounds(t *testing.T) {
	w := newTestMiniWindow()
	w.full, w.exitDelay = true, 3
	w.g = windowGeometry{0, 0, 1920, 1080}
	var m miniPlayerController
	if s := m.set(w, true, true, false); !s.Active || s.Error != "" {
		t.Fatal(s)
	}
	if m.normal != w.normal {
		t.Fatal("captured fullscreen bounds before the native exit completed")
	}
	m.set(w, false, false, false)
	if w.g != w.normal || !w.full {
		t.Fatalf("lost fullscreen or normal bounds: %+v", w)
	}
}

func TestMiniPlayerFullscreenDoesNotBecomeMaximisedOnRestore(t *testing.T) {
	w := newTestMiniWindow()
	w.full, w.zoomedInFullscreen, w.hasRestore = true, true, true
	w.g = windowGeometry{0, 0, 1920, 1080}
	var m miniPlayerController
	if s := m.set(w, true, false, false); !s.Active || s.Error != "" {
		t.Fatal(s)
	}
	if m.wasMaximised {
		t.Fatal("fullscreen's isZoomed flag overwrote the pre-fullscreen ordinary state")
	}
	m.set(w, false, false, false)
	if !w.full || w.max {
		t.Fatal("returning to fullscreen must not first maximise the ordinary window")
	}
	w.setFullscreen(false) // Esc after returning from the mini player.
	if w.g != w.normal || w.max {
		t.Fatalf("Esc did not restore ordinary window: %+v", w)
	}
}

func TestMiniPlayerWaitsPastStyleMaskChange(t *testing.T) {
	w := newTestMiniWindow()
	w.full, w.transitionChecks = true, 3
	// The fullscreen flag clears first; native DidExit restores the frame later.
	w.normal = windowGeometry{210, 140, 1100, 700}
	var m miniPlayerController
	m.set(w, true, false, false)
	if m.normal != w.normal || w.transitionChecks != 0 {
		t.Fatalf("saved bounds during Space animation: %+v", m.normal)
	}
}

func TestMiniPlayerRemembersGeometryAcrossProcesses(t *testing.T) {
	for _, quitInMini := range []bool{false, true} {
		t.Run(map[bool]string{false: "return-then-quit", true: "quit-in-mini"}[quitInMini], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "profile", "mini-player-window.json")
			w := newTestMiniWindow()
			var first miniPlayerController
			first.load(path)
			first.set(w, true, true, false)
			want := windowGeometry{900, 240, 380, 600}
			w.g = want
			if quitInMini {
				first.save(w)
			} else {
				first.set(w, false, false, false)
				// Quitting in the main window must not overwrite mini geometry.
				w.g = windowGeometry{0, 0, 1600, 900}
				first.save(w)
			}
			var restarted miniPlayerController
			restarted.load(path)
			w = newTestMiniWindow()
			restarted.set(w, true, false, false)
			if w.g != want || w.centers != 0 {
				t.Fatalf("restart lost user bounds: %+v", w)
			}
			// Exercise replacement of an already existing settings file too.
			w.g.Width = 420
			restarted.save(w)
			var again miniPlayerController
			again.load(path)
			if again.small.Width != 420 {
				t.Fatal("could not replace existing saved geometry")
			}
		})
	}
}

func TestMiniPlayerStoredBoundsFallbacks(t *testing.T) {
	for _, content := range []string{`{`, `{"geometry":{"Width":-1,"Height":600}}`, `{"geometry":{"X":2147483647,"Width":480,"Height":300}}`} {
		path := filepath.Join(t.TempDir(), "mini.json")
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		var m miniPlayerController
		m.load(path)
		w := newTestMiniWindow()
		m.set(w, true, false, false)
		if w.g.Width != 480 || w.g.Height != 300 || w.centers != 1 {
			t.Fatalf("bad settings did not fall back: %+v", w)
		}
	}
	path := filepath.Join(t.TempDir(), "mini.json")
	if err := writeMiniPlayerGeometry(path, windowGeometry{2000, 0, 3000, 2000}, "old-screen"); err != nil {
		t.Fatal(err)
	}
	var m miniPlayerController
	m.load(path)
	w := newTestMiniWindow()
	m.set(w, true, true, false)
	if w.centers != 1 || w.g.Width != 320 || w.g.Height != 568 {
		t.Fatalf("changed display reused off-screen geometry: %+v", w)
	}
}

func TestMiniPlayerSaveDoesNotPersistFullscreenBounds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mini.json")
	w := newTestMiniWindow()
	var m miniPlayerController
	m.load(path)
	m.set(w, true, false, false)
	w.normal = windowGeometry{300, 200, 500, 320}
	w.g, w.full, w.hasRestore = windowGeometry{0, 0, 1920, 1080}, true, true
	m.save(w)
	var restarted miniPlayerController
	restarted.load(path)
	if restarted.small != w.normal {
		t.Fatalf("saved fullscreen frame instead of the small frame: %+v", restarted.small)
	}
}

func TestMiniTitlebarDefaultPreservesExistingWindow(t *testing.T) {
	w := newTestMiniWindow()
	var m miniPlayerController
	m.set(w, true, true, false)
	m.set(w, false, false, false)
	if len(w.titlebarCalls) != 0 || w.g != w.normal {
		t.Fatalf("default changed titlebar: %+v", w)
	}
}

func TestMiniTitlebarRoundTripRestoresNormalWindow(t *testing.T) {
	for _, mode := range []string{"ordinary", "maximised", "fullscreen"} {
		t.Run(mode, func(t *testing.T) {
			w := newTestMiniWindow()
			w.full = mode == "fullscreen"
			w.max = mode == "maximised"
			var m miniPlayerController
			result := m.set(w, true, true, true)
			if !result.Active || !result.TitlebarHidden || !w.titlebarHidden {
				t.Fatal(result)
			}
			result = m.set(w, false, false, false)
			if result.Active || result.TitlebarHidden || w.titlebarHidden || w.g != w.normal || w.full != (mode == "fullscreen") || w.max != (mode == "maximised") {
				t.Fatalf("restore: %+v %+v", result, w)
			}
		})
	}
}

func TestMiniTitlebarFailureFallsBackWithoutLosingMiniMode(t *testing.T) {
	w := newTestMiniWindow()
	w.failHide = true
	var m miniPlayerController
	result := m.set(w, true, true, true)
	if !result.Active || !result.TitlebarFallback || result.TitlebarHidden || result.Error != "" || !w.top {
		t.Fatalf("fallback: %+v %+v", result, w)
	}
	if len(w.titlebarCalls) != 2 || !w.titlebarCalls[0] || w.titlebarCalls[1] {
		t.Fatal(w.titlebarCalls)
	}
	m.set(w, false, false, false)
	if w.g != w.normal {
		t.Fatal(w.g)
	}
}

func TestMiniTitlebarCanBeRestoredWithoutReloadingOrResizing(t *testing.T) {
	w := newTestMiniWindow()
	var m miniPlayerController
	m.set(w, true, true, true)
	geometry, sizes := w.g, w.sizes
	result := m.setTitlebar(w, false)
	if !result.Active || result.TitlebarHidden || w.g != geometry || w.sizes != sizes || !w.top {
		t.Fatalf("recovery: %+v %+v", result, w)
	}
}

func TestMiniTitlebarRestorationFailureRetainsRetryableMiniMode(t *testing.T) {
	w := newTestMiniWindow()
	var m miniPlayerController
	m.set(w, true, true, true)
	w.failRestore = true
	result := m.set(w, false, false, false)
	if !result.Active || !result.TitlebarHidden || result.Error == "" || !w.top {
		t.Fatal(result)
	}
	w.failRestore = false
	result = m.set(w, false, false, false)
	if result.Active || result.TitlebarHidden || result.Error != "" || w.g != w.normal {
		t.Fatal(result)
	}
}

func TestMiniTitlebarPartialFailureKeepsRecoveryAvailable(t *testing.T) {
	w := newTestMiniWindow()
	w.failHide, w.failRestore = true, true
	var m miniPlayerController
	result := m.set(w, true, true, true)
	if !result.Active || !result.TitlebarHidden || result.Error == "" {
		t.Fatal(result)
	}
	w.failRestore = false
	if result = m.setTitlebar(w, false); result.TitlebarHidden || result.Error != "" {
		t.Fatal(result)
	}
}
