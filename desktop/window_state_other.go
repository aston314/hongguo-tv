//go:build !darwin

package main

import (
	"context"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func desktopWindowHidden(ctx context.Context) bool           { return wruntime.WindowIsMinimised(ctx) }
func desktopObserveWindow()                                  {}
func desktopWindowTransitioning() bool                       { return false }
func desktopFullscreenRestore() (windowGeometry, bool, bool) { return windowGeometry{}, false, false }
func desktopKeepMiniWindowVisible()                          {}
