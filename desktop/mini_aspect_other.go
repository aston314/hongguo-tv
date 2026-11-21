//go:build !darwin && !windows && !linux

package main

import "errors"

func desktopSetMiniAspect(width, height int, refit bool) error {
	return errors.New("window aspect unavailable")
}
