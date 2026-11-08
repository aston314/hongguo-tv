package main

import (
	"context"
	"encoding/json"
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
func (w runtimeMiniWindow) fullscreen() bool        { return wruntime.WindowIsFullscreen(w.ctx) }
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

func (a *desktopApp) SetMiniPlayer(enabled, portrait bool) string {
	state := a.mini.set(runtimeMiniWindow{a.ctx}, enabled, portrait)
	b, _ := json.Marshal(state)
	return string(b)
}
