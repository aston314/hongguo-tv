//go:build !linux

package main

// AppKit/Win32 sizes are applied synchronously; retain their existing path.
func desktopSetMiniAspectGeometry(width, height int, refit bool, initialWidth, initialHeight int) error {
	return desktopSetMiniAspect(width, height, refit)
}
