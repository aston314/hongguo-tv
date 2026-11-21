package main

import (
	"errors"
	"math"
	"sync"
	"testing"
)

type testAspectWindow struct {
	*testMiniWindow
	nativeAspect          miniAspect
	aspects               []miniAspect
	failAspect, failClear bool
}

func newTestAspectWindow() *testAspectWindow {
	return &testAspectWindow{testMiniWindow: newTestMiniWindow()}
}
func (w *testAspectWindow) setAspect(aspect miniAspect, refit bool) error {
	w.aspects = append(w.aspects, aspect)
	if !aspect.valid() {
		if w.failClear {
			return errors.New("cannot clear")
		}
		w.nativeAspect = miniAspect{}
		return nil
	}
	w.nativeAspect = aspect
	if w.failAspect {
		return errors.New("partial native failure")
	}
	if !refit || w.full || w.max {
		return nil
	}
	chrome := 28
	if w.titlebarHidden {
		chrome = 0
	}
	longest := max(w.g.Width, w.g.Height-chrome)
	width, height := fitMiniContent(longest, longest, aspect, 280, 200-chrome, 1880, 1000-chrome, aspect.Width < aspect.Height)
	w.g.Width, w.g.Height = width, height+chrome
	return nil
}
func TestMiniAspectValidationAndSizeBounds(t *testing.T) {
	if videoMiniAspect(1080, 1924) != (miniAspect{270, 481}) || videoMiniAspect(1920, 1080) != (miniAspect{16, 9}) {
		t.Fatal("lost real source aspect")
	}
	for _, a := range []miniAspect{{0, 0}, {0, 100}, {-1, 9}, {50000, 1}, {1, 50000}, {1, 100}} {
		if videoMiniAspect(a.Width, a.Height).valid() {
			t.Fatal(a)
		}
	}
	for _, a := range []miniAspect{{16, 9}, {9, 16}, {270, 481}, {481, 270}, {1, 1}, {10, 1}, {1, 10}} {
		for _, longest := range []int{10, 280, 480, 720, 20000} {
			w, h := fitMiniContent(longest, longest, a, 280, 200, 640, 360, a.Width < a.Height)
			if w < 1 || h < 1 || w > 640 || h > 360 || math.Abs(float64(w*a.Height-h*a.Width)) > float64(max(a.Width, a.Height)) {
				t.Fatalf("%+v -> %dx%d", a, w, h)
			}
		}
	}
}
func TestMiniAspectMetadataRefitsOnceWithoutOverwritingNormalGeometry(t *testing.T) {
	w := newTestAspectWindow()
	var m miniPlayerController
	s := m.setWithAspect(w, true, true, false, 1080, 1920)
	if !s.Active || !s.AspectApplied || s.AspectSession == 0 || w.nativeAspect != (miniAspect{9, 16}) {
		t.Fatal(s)
	}
	small := w.g
	calls := len(w.aspects)
	m.updateAspect(w, s.AspectSession, 720, 1280)
	if len(w.aspects) != calls || w.g != small {
		t.Fatal("same ratio resized the window")
	}
	m.updateAspect(w, s.AspectSession, 1920, 1080)
	if w.g.Width <= w.g.Height || m.normal != w.normal {
		t.Fatal("orientation change lost normal bounds")
	}
	m.set(w, false, false, false)
	if w.g != w.normal || w.nativeAspect.valid() || m.aspectInstalled {
		t.Fatal("normal window retained mini constraints")
	}
}
func TestMiniAspectUnknownDimensionsAndStaleSessionsCannotResizeNormalOrNextWindow(t *testing.T) {
	w := newTestAspectWindow()
	var m miniPlayerController
	s := m.setWithAspect(w, true, false, false, 0, 0)
	if !s.Active || s.AspectApplied || len(w.aspects) != 0 {
		t.Fatal(s)
	}
	m.updateAspect(w, s.AspectSession, 1080, 1924)
	if w.nativeAspect != (miniAspect{270, 481}) {
		t.Fatal("metadata did not apply")
	}
	m.set(w, false, false, false)
	normal := w.g
	calls := len(w.aspects)
	m.updateAspect(w, s.AspectSession, 1920, 1080)
	if w.g != normal || len(w.aspects) != calls {
		t.Fatal("late metadata resized normal window")
	}
	next := m.setWithAspect(w, true, false, false, 1920, 1080)
	small := w.g
	calls = len(w.aspects)
	m.updateAspect(w, s.AspectSession, 1080, 1920)
	if next.AspectSession == s.AspectSession || w.g != small || len(w.aspects) != calls {
		t.Fatal("old session resized new small window")
	}
}
func TestMiniAspectFailureRetainsWorkingMiniWindowAndClearFailureRetainsRecovery(t *testing.T) {
	w := newTestAspectWindow()
	w.failAspect = true
	var m miniPlayerController
	s := m.setWithAspect(w, true, true, false, 1080, 1920)
	if !s.Active || !s.AspectFallback || s.Error != "" || w.nativeAspect.valid() {
		t.Fatal(s)
	}
	w.failAspect = false
	m.updateAspect(w, s.AspectSession, 1920, 1080)
	w.failClear = true
	s = m.set(w, false, false, false)
	if !s.Active || s.Error == "" || w.g == w.normal || w.minWidth != 280 {
		t.Fatal("unsafe restore after native cleanup failure", s)
	}
	w.failClear = false
	s = m.set(w, false, false, false)
	if s.Active || w.g != w.normal || w.nativeAspect.valid() {
		t.Fatal("recovery failed", s)
	}
}
func TestMiniAspectDoesNotSuppressExistingTitlebarFallback(t *testing.T) {
	w := newTestAspectWindow()
	w.failHide = true
	var m miniPlayerController
	s := m.setWithAspect(w, true, false, true, 1920, 1080)
	if !s.Active || !s.TitlebarFallback || s.TitlebarHidden || !s.AspectApplied || s.AspectSession == 0 {
		t.Fatal("aspect enhancement lost the titlebar fallback", s)
	}
	w.failHide = false
	w.failAspect = true
	s = m.setTitlebar(w, true)
	if !s.Active || !s.TitlebarHidden || !s.AspectFallback || s.AspectApplied || s.AspectSession == 0 || w.nativeAspect.valid() {
		t.Fatal("titlebar change did not report aspect cleanup", s)
	}
}
func TestMiniAspectTitlebarAndFullscreenChangesDoNotPersistFullscreenBounds(t *testing.T) {
	w := newTestAspectWindow()
	var m miniPlayerController
	s := m.setWithAspect(w, true, true, true, 1080, 1920)
	if !s.AspectApplied || !s.TitlebarHidden {
		t.Fatal(s)
	}
	m.setTitlebar(w, false)
	if w.nativeAspect != (miniAspect{9, 16}) || w.titlebarHidden {
		t.Fatal("titlebar change lost aspect")
	}
	small := m.small
	w.full = true
	w.g = windowGeometry{0, 0, 1920, 1080}
	m.updateAspect(w, s.AspectSession, 1920, 1080)
	if m.small != small {
		t.Fatal("fullscreen replaced saved small geometry")
	}
	w.full = false
	w.g = small
	m.set(w, false, false, false)
	if w.g != w.normal || w.nativeAspect.valid() {
		t.Fatal("aspect leaked outside mini mode")
	}
}
func TestMiniAspectConcurrentMetadataAndExitAlwaysLeaveNormalWindowUnconstrained(t *testing.T) {
	w := newTestAspectWindow()
	var m miniPlayerController
	s := m.setWithAspect(w, true, true, false, 1080, 1920)
	var group sync.WaitGroup
	for i := 0; i < 20; i++ {
		group.Add(1)
		go func() { defer group.Done(); m.updateAspect(w, s.AspectSession, 1920, 1080) }()
	}
	group.Add(1)
	go func() { defer group.Done(); m.set(w, false, false, false) }()
	group.Wait()
	if m.active.Load() || w.g != w.normal || w.nativeAspect.valid() {
		t.Fatal("metadata raced window restoration")
	}
}

type delayedAspectWindow struct {
	*testAspectWindow
	requested []windowGeometry
	sizing    []windowGeometry
}

func (w *delayedAspectWindow) setGeometry(g windowGeometry) {
	// Like GTK, record the request without immediately updating actual bounds.
	w.requested = append(w.requested, g)
}
func (w *delayedAspectWindow) setAspectGeometry(a miniAspect, refit bool, initial windowGeometry) error {
	w.sizing = append(w.sizing, initial)
	w.g = initial
	return w.testAspectWindow.setAspect(a, refit)
}
func TestMiniAspectEntryUsesRequestedSizeWhileNativeConfigureIsPending(t *testing.T) {
	w := &delayedAspectWindow{testAspectWindow: newTestAspectWindow()}
	var m miniPlayerController
	s := m.setWithAspect(w, true, false, false, 1282, 720)
	if !s.AspectApplied || len(w.sizing) != 1 || w.sizing[0].Width != 480 || w.sizing[0].Height != 300 || w.g.Width >= 600 {
		t.Fatal("first aspect fit used stale fullscreen geometry", s, w.sizing, w.g)
	}
	// Subsequent source changes must follow a user's live resize, not the old
	// entry hint, otherwise changing orientation would reset their window size.
	w.g.Width, w.g.Height = 800, 460
	m.updateAspect(w, s.AspectSession, 1080, 1920)
	if len(w.sizing) != 1 || w.g.Height < 700 {
		t.Fatal("entry hint leaked into later metadata", w.sizing, w.g)
	}
}
