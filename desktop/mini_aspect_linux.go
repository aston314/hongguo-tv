//go:build linux

package main

/*
#cgo linux pkg-config: gtk+-3.0
#cgo linux LDFLAGS: -lm
#include "mini_aspect_linux.h"
*/
import "C"
import "errors"

func desktopSetMiniAspect(width, height int, refit bool) error {
	var fit C.int
	if refit {
		fit = 1
	}
	if C.set_mini_aspect(C.int(width), C.int(height), fit) == 0 {
		return errors.New("window aspect change failed")
	}
	return nil
}
