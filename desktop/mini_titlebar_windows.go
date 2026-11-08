//go:build windows

package main

import (
	"errors"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var miniUser32 = windows.NewLazySystemDLL("user32.dll")
var miniEnumWindows = miniUser32.NewProc("EnumWindows")
var miniGetPID = miniUser32.NewProc("GetWindowThreadProcessId")
var miniGetClass = miniUser32.NewProc("GetClassNameW")
var miniGetStyle = miniUser32.NewProc("GetWindowLongW")
var miniSetStyle = miniUser32.NewProc("SetWindowLongW")
var miniSetWindowPos = miniUser32.NewProc("SetWindowPos")
var miniTitlebarHWND, miniTitlebarStyle uintptr
var miniWindowFound uintptr
var miniWindowCallback = syscall.NewCallback(func(hwnd, unused uintptr) uintptr {
	var pid uint32
	miniGetPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == uint32(os.Getpid()) {
		var name [64]uint16
		miniGetClass.Call(hwnd, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
		if windows.UTF16ToString(name[:]) == "winc_Form" {
			miniWindowFound = hwnd
			return 0
		}
	}
	return 1
})

func miniWindowHandle() uintptr {
	miniWindowFound = 0
	miniEnumWindows.Call(miniWindowCallback, 0)
	return miniWindowFound
}

func desktopSetMiniTitlebarHidden(hidden bool) error {
	if !hidden && miniTitlebarHWND == 0 {
		return nil
	}
	hwnd := miniWindowHandle()
	if hwnd == 0 || miniTitlebarHWND != 0 && miniTitlebarHWND != hwnd {
		return errors.New("desktop window unavailable")
	}
	index := int32(-16) // GWL_STYLE
	style, _, _ := miniGetStyle.Call(hwnd, uintptr(index))
	if style == 0 {
		return errors.New("window style unavailable")
	}
	if hidden && miniTitlebarHWND == 0 {
		miniTitlebarHWND, miniTitlebarStyle = hwnd, style
	}
	target := miniTitlebarStyle
	if hidden {
		// Preserve WS_THICKFRAME so native edge resizing remains available.
		target = style &^ uintptr(0x00C00000) // WS_CAPTION
	}
	miniSetStyle.Call(hwnd, uintptr(index), target)
	// Recalculate only the non-client frame. Preserve position, size, activation,
	// z-order and the existing WebView throughout this operation.
	ok, _, _ := miniSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, 0x0027|0x0010) // FRAMECHANGED|NOMOVE|NOSIZE|NOZORDER|NOACTIVATE
	actual, _, _ := miniGetStyle.Call(hwnd, uintptr(index))
	if ok == 0 || actual != target {
		return errors.New("window titlebar change failed")
	}
	if !hidden {
		miniTitlebarHWND, miniTitlebarStyle = 0, 0
	}
	return nil
}
