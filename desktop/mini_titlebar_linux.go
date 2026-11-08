//go:build linux

package main

/*
#cgo linux pkg-config: gtk+-3.0
#include "mini_titlebar_linux.h"
*/
import "C"

import "errors"

func desktopSetMiniTitlebarHidden(hidden bool) error {
	var value C.int
	if hidden {
		value = 1
	}
	if C.set_mini_titlebar_hidden(value) == 0 {
		return errors.New("window titlebar change failed")
	}
	return nil
}
