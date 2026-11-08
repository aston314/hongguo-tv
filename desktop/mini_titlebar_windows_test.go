//go:build windows

package main

import (
	"runtime"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

type miniWindowClass struct {
	style                              uint32
	procedure                          uintptr
	classExtra, windowExtra            int32
	instance, icon, cursor, background uintptr
	menu, name                         *uint16
}

func TestNativeMiniTitlebarWindows(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	instance, _, _ := kernel.NewProc("GetModuleHandleW").Call(0)
	def := miniUser32.NewProc("DefWindowProcW")
	class := miniWindowClass{instance: instance, name: windows.StringToUTF16Ptr("winc_Form"), procedure: syscall.NewCallback(func(hwnd uintptr, msg uint32, wparam, lparam uintptr) uintptr {
		result, _, _ := def.Call(hwnd, uintptr(msg), wparam, lparam)
		return result
	})}
	registered, _, err := miniUser32.NewProc("RegisterClassW").Call(uintptr(unsafe.Pointer(&class)))
	if registered == 0 {
		t.Fatal(err)
	}
	defer miniUser32.NewProc("UnregisterClassW").Call(uintptr(unsafe.Pointer(class.name)), instance)
	hwnd, _, err := miniUser32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class.name)), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Mini titlebar test"))), 0x00CF0000, 100, 100, 480, 300, 0, 0, instance, 0)
	if hwnd == 0 {
		t.Fatal(err)
	}
	defer miniUser32.NewProc("DestroyWindow").Call(hwnd)
	child, _, _ := miniUser32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("STATIC"))), 0, 0x40000000, 0, 0, 100, 100, hwnd, 0, instance, 0)
	if child == 0 {
		t.Fatal("could not create retained content child")
	}
	type rect struct{ left, top, right, bottom int32 }
	getRect := func() rect {
		var r rect
		miniUser32.NewProc("GetWindowRect").Call(hwnd, uintptr(unsafe.Pointer(&r)))
		return r
	}
	originalRect := getRect()
	index := int32(-16)
	original, _, _ := miniGetStyle.Call(hwnd, uintptr(index))
	for i := 0; i < 3; i++ {
		if err := desktopSetMiniTitlebarHidden(true); err != nil {
			t.Fatal(err)
		}
		style, _, _ := miniGetStyle.Call(hwnd, uintptr(index))
		if style&0x00C00000 != 0 || style&0x00040000 == 0 {
			t.Fatalf("caption/resize style: %x", style)
		}
		if getRect() != originalRect {
			t.Fatal("titlebar change moved/resized the window")
		}
		if err := desktopSetMiniTitlebarHidden(false); err != nil {
			t.Fatal(err)
		}
		style, _, _ = miniGetStyle.Call(hwnd, uintptr(index))
		if style != original || getRect() != originalRect {
			t.Fatal("window style or frame not restored")
		}
		parent, _, _ := miniUser32.NewProc("GetParent").Call(child)
		if parent != hwnd {
			t.Fatal("content child was replaced")
		}
	}
}
