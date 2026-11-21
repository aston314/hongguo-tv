package main

import "math"

type miniAspect struct{ Width, Height int }

func videoMiniAspect(width, height int) miniAspect {
	if width <= 0 || height <= 0 || width > 32768 || height > 32768 ||
		width > height*10 || height > width*10 {
		return miniAspect{}
	}
	a, b := width, height
	for b != 0 {
		a, b = b, a%b
	}
	return miniAspect{width / a, height / a}
}
func (a miniAspect) valid() bool { return a.Width > 0 && a.Height > 0 }

// Content dimensions only; native adapters account for their own titlebar/DPI.
// Use the longer side when the video orientation changes, so a portrait-to-
// landscape switch does not collapse the usable small-window size.
func fitMiniContent(width, height int, a miniAspect, minW, minH, maxW, maxH int, heightDriven bool) (int, int) {
	if !a.valid() {
		return max(1, width), max(1, height)
	}
	r := float64(a.Width) / float64(a.Height)
	w := float64(width)
	if heightDriven {
		w = float64(height) * r
	}
	lo := math.Max(float64(minW), float64(minH)*r)
	hi := math.Min(float64(maxW), float64(maxH)*r)
	if hi < 1 {
		hi = 1
	}
	lo = math.Min(lo, hi)
	w = math.Max(lo, math.Min(w, hi))
	return max(1, int(math.Round(w))), max(1, int(math.Round(w/r)))
}

type miniAspectWindow interface {
	setAspect(miniAspect, bool) error
}

type miniAspectGeometryWindow interface {
	setAspectGeometry(miniAspect, bool, windowGeometry) error
}

func (m *miniPlayerController) windowStateLocked() miniPlayerWindowState {
	s := miniPlayerWindowState{Active: m.active.Load(), TitlebarHidden: m.titlebarHidden,
		AspectApplied: m.aspectApplied, AspectFallback: m.aspectFallback}
	if s.Active {
		s.AspectSession = m.aspectSession
	}
	return s
}

func (m *miniPlayerController) clearAspectLocked(w miniPlayerWindow) error {
	if !m.aspectInstalled {
		return nil
	}
	if err := w.(miniAspectWindow).setAspect(miniAspect{}, false); err != nil {
		return err
	}
	m.aspectInstalled, m.aspectApplied = false, false
	return nil
}

func (m *miniPlayerController) applyAspectLocked(w miniPlayerWindow, aspect miniAspect, refit bool) {
	m.applyAspectAtSizeLocked(w, aspect, refit, windowGeometry{})
}

func (m *miniPlayerController) applyAspectAtSizeLocked(w miniPlayerWindow, aspect miniAspect, refit bool, initial windowGeometry) {
	if !aspect.valid() {
		return
	}
	if !refit && m.aspectApplied && m.aspect == aspect {
		return
	}
	m.aspect, m.aspectApplied, m.aspectFallback = aspect, false, false
	adapter, ok := w.(miniAspectWindow)
	if !ok {
		m.aspectFallback = true
		return
	}
	m.aspectInstalled = true // retain cleanup even after a partially failed call
	var err error
	if sized, ok := w.(miniAspectGeometryWindow); ok && initial.Width > 0 && initial.Height > 0 {
		err = sized.setAspectGeometry(aspect, true, initial)
	} else {
		err = adapter.setAspect(aspect, true)
	}
	if err != nil {
		m.aspectFallback = true
		_ = m.clearAspectLocked(w)
		return
	}
	m.aspectApplied = true
	if !w.transitioning() && !w.fullscreen() && !w.maximised() {
		m.small = w.geometry()
		m.smallDisplayID, _, _ = w.display()
	}
}

func (m *miniPlayerController) setWithAspect(w miniPlayerWindow, enabled, portrait, hidden bool, width, height int) miniPlayerWindowState {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := m.setLocked(w, enabled, portrait, hidden)
	if enabled && result.Active && result.Error == "" {
		m.applyAspectAtSizeLocked(w, videoMiniAspect(width, height), false, result.initialSize)
	}
	state := m.windowStateLocked()
	state.TitlebarFallback, state.Error = result.TitlebarFallback, result.Error
	return state
}

func (m *miniPlayerController) updateAspect(w miniPlayerWindow, session uint64, width, height int) miniPlayerWindowState {
	m.mu.Lock()
	defer m.mu.Unlock()
	// Late metadata from an exited mini session must never resize a normal
	// window, or the next small window after a rapid exit/re-entry.
	if m.active.Load() && session != 0 && session == m.aspectSession {
		m.applyAspectLocked(w, videoMiniAspect(width, height), false)
	}
	return m.windowStateLocked()
}
