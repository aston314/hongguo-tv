//go:build darwin

package main

/*
#cgo LDFLAGS: -framework Cocoa
int hongguoWindowHidden(void);
void hongguoObserveWindow(void);
int hongguoWindowTransitioning(void);
int hongguoFullscreenRestore(int *x, int *y, int *width, int *height, int *maximised);
void hongguoKeepMiniWindowVisible(void);
int hongguoSetMiniTitlebarHidden(int hidden);
int hongguoSetMiniAspect(int width, int height, int refit);
*/
import "C"

import (
	"context"
	"errors"
)

func desktopWindowHidden(context.Context) bool { return C.hongguoWindowHidden() != 0 }
func desktopObserveWindow()                    { C.hongguoObserveWindow() }
func desktopWindowTransitioning() bool         { return C.hongguoWindowTransitioning() != 0 }
func desktopFullscreenRestore() (windowGeometry, bool, bool) {
	var x, y, width, height, maximised C.int
	ok := C.hongguoFullscreenRestore(&x, &y, &width, &height, &maximised) != 0
	return windowGeometry{int(x), int(y), int(width), int(height)}, maximised != 0, ok
}
func desktopKeepMiniWindowVisible() { C.hongguoKeepMiniWindowVisible() }

func desktopSetMiniTitlebarHidden(hidden bool) error {
	var value C.int
	if hidden {
		value = 1
	}
	if C.hongguoSetMiniTitlebarHidden(value) == 0 {
		return errors.New("window titlebar change failed")
	}
	return nil
}

func desktopSetMiniAspect(width, height int, refit bool) error {
	var fit C.int
	if refit {
		fit = 1
	}
	if C.hongguoSetMiniAspect(C.int(width), C.int(height), fit) == 0 {
		return errors.New("window aspect change failed")
	}
	return nil
}
