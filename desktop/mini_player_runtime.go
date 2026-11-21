package main

import (
	"context"
	"encoding/json"
	"runtime"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type runtimeMiniWindow struct{ ctx context.Context }

func (w runtimeMiniWindow) geometry() windowGeometry {
	x, y := wruntime.WindowGetPosition(w.ctx)
	width, height := wruntime.WindowGetSize(w.ctx)
	return windowGeometry{x, y, width, height}
}
func (w runtimeMiniWindow) setGeometry(g windowGeometry) {
	wruntime.WindowSetSize(w.ctx, g.Width, g.Height)
	wruntime.WindowSetPosition(w.ctx, g.X, g.Y)
}
func (w runtimeMiniWindow) setMinimum(width, height int) {
	wruntime.WindowSetMinSize(w.ctx, width, height)
}
func (w runtimeMiniWindow) setTopmost(enabled bool) { wruntime.WindowSetAlwaysOnTop(w.ctx, enabled) }
func (w runtimeMiniWindow) setTitlebarHidden(hidden bool) error {
	return desktopSetMiniTitlebarHidden(hidden)
}
func (w runtimeMiniWindow) setAspect(aspect miniAspect, refit bool) error {
	err := desktopSetMiniAspect(aspect.Width, aspect.Height, refit)
	if err == nil && !aspect.valid() && runtime.GOOS == "linux" {
		// GTK geometry hints replace, rather than merge, Wails' min/max hints.
		// Restore the framework's own current mini constraints after clearing.
		wruntime.WindowSetMinSize(w.ctx, 280, 200)
	}
	return err
}
func (w runtimeMiniWindow) setAspectGeometry(aspect miniAspect, refit bool, initial windowGeometry) error {
	return desktopSetMiniAspectGeometry(aspect.Width, aspect.Height, refit, initial.Width, initial.Height)
}
func (w runtimeMiniWindow) fullscreen() bool { return wruntime.WindowIsFullscreen(w.ctx) }
func (w runtimeMiniWindow) setFullscreen(enabled bool) {
	if enabled {
		wruntime.WindowFullscreen(w.ctx)
	} else {
		wruntime.WindowUnfullscreen(w.ctx)
	}
}
func (w runtimeMiniWindow) maximised() bool { return wruntime.WindowIsMaximised(w.ctx) }
func (w runtimeMiniWindow) setMaximised(enabled bool) {
	if enabled {
		wruntime.WindowMaximise(w.ctx)
	} else {
		wruntime.WindowUnmaximise(w.ctx)
	}
}
func (w runtimeMiniWindow) center()             { wruntime.WindowCenter(w.ctx) }
func (w runtimeMiniWindow) transitioning() bool { return desktopWindowTransitioning() }
func (w runtimeMiniWindow) fullscreenRestore() (windowGeometry, bool, bool) {
	return desktopFullscreenRestore()
}
func (w runtimeMiniWindow) keepVisible() { desktopKeepMiniWindowVisible() }
func (w runtimeMiniWindow) display() (string, int, int) {
	screens, err := wruntime.ScreenGetAll(w.ctx)
	if err != nil {
		return "", 0, 0
	}
	b, _ := json.Marshal(screens)
	for _, screen := range screens {
		if screen.IsCurrent {
			return string(b), screen.Size.Width, screen.Size.Height
		}
	}
	return string(b), 0, 0
}

func (a *desktopApp) SetMiniPlayer(enabled, portrait, hideTitlebar bool) string {
	state := a.mini.set(runtimeMiniWindow{a.ctx}, enabled, portrait, hideTitlebar)
	b, _ := json.Marshal(state)
	return string(b)
}

func (a *desktopApp) SetMiniPlayerTitlebarHidden(hidden bool) string {
	state := a.mini.setTitlebar(runtimeMiniWindow{a.ctx}, hidden)
	b, _ := json.Marshal(state)
	return string(b)
}

func (a *desktopApp) SetMiniPlayerWithAspect(enabled, portrait, hidden bool, width, height int) string {
	state := a.mini.setWithAspect(runtimeMiniWindow{a.ctx}, enabled, portrait, hidden, width, height)
	b, _ := json.Marshal(state)
	return string(b)
}

func (a *desktopApp) UpdateMiniPlayerAspect(session uint64, width, height int) string {
	state := a.mini.updateAspect(runtimeMiniWindow{a.ctx}, session, width, height)
	b, _ := json.Marshal(state)
	return string(b)
}
