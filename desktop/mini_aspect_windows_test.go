//go:build windows

package main

import (
	"math"
	"runtime"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestNativeMiniAspectWindows(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	instance, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	def := miniUser32.NewProc("DefWindowProcW")
	class := miniWindowClass{instance: instance, name: windows.StringToUTF16Ptr("winc_Form"), procedure: syscall.NewCallback(func(hwnd uintptr, msg uint32, wp, lp uintptr) uintptr {
		r, _, _ := def.Call(hwnd, uintptr(msg), wp, lp)
		return r
	})}
	registered, _, err := miniUser32.NewProc("RegisterClassW").Call(uintptr(unsafe.Pointer(&class)))
	if registered == 0 {
		t.Fatal(err)
	}
	defer miniUser32.NewProc("UnregisterClassW").Call(uintptr(unsafe.Pointer(class.name)), instance)
	hwnd, _, err := miniUser32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class.name)), uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("Mini aspect check"))), 0x00CF0000, 100, 100, 480, 300, 0, 0, instance, 0)
	if hwnd == 0 {
		t.Fatal(err)
	}
	defer miniUser32.NewProc("DestroyWindow").Call(hwnd)
	child, _, _ := miniUser32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("STATIC"))), 0, 0x40000000, 0, 0, 100, 100, hwnd, 0, instance, 0)
	if child == 0 {
		t.Fatal("missing retained content")
	}
	index := int32(-4)
	original, _, _ := miniGetProcedure.Call(hwnd, uintptr(index))
	defer desktopSetMiniAspect(0, 0, false)
	ptr, err := windows.VirtualAlloc(0, unsafe.Sizeof(miniNativeRect{}), windows.MEM_COMMIT|windows.MEM_RESERVE, windows.PAGE_READWRITE)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.VirtualFree(ptr, 0, windows.MEM_RELEASE)
	var proposal miniNativeRect
	for _, a := range []miniAspect{{16, 9}, {9, 16}, {270, 481}} {
		if err := desktopSetMiniAspect(a.Width, a.Height, true); err != nil {
			t.Fatal(err)
		}
		frame, cw, ch, dw, dh, _, _, ok := miniWindowsContent(hwnd)
		if !ok || math.Abs(float64(cw*a.Height-ch*a.Width)) > float64(max(a.Width, a.Height)) {
			t.Fatalf("content ratio %dx%d for %+v", cw, ch, a)
		}
		miniSetWindowPos.Call(hwnd, 0, 200, 200, 0, 0, 0x0015) // move only
		_, movedW, movedH, _, _, _, _, _ := miniWindowsContent(hwnd)
		if movedW != cw || movedH != ch {
			t.Fatal("moving window resized content")
		}
		for edge := uintptr(1); edge <= 8; edge++ {
			proposal = frame
			if edge == 1 || edge == 4 || edge == 7 {
				proposal.Left -= 90
			} else {
				proposal.Right += 90
			}
			if edge == 3 || edge == 4 || edge == 5 {
				proposal.Top -= 60
			} else {
				proposal.Bottom += 60
			}
			anchor := proposal
			miniWriteNativeRect(ptr, &proposal)
			miniUser32.NewProc("SendMessageW").Call(hwnd, 0x0214, edge, ptr)
			proposal = miniReadNativeRect(ptr)
			width, height := int(proposal.Right-proposal.Left)-dw, int(proposal.Bottom-proposal.Top)-dh
			if math.Abs(float64(width*a.Height-height*a.Width)) > float64(max(a.Width, a.Height)) {
				t.Fatalf("drag edge %d distorted content: %dx%d", edge, width, height)
			}
			if edge == 1 || edge == 4 || edge == 7 {
				if proposal.Right != anchor.Right {
					t.Fatal("right anchor moved")
				}
			} else if proposal.Left != anchor.Left {
				t.Fatal("left anchor moved")
			}
			if edge == 3 || edge == 4 || edge == 5 {
				if proposal.Bottom != anchor.Bottom {
					t.Fatal("bottom anchor moved")
				}
			} else if proposal.Top != anchor.Top {
				t.Fatal("top anchor moved")
			}
		}
		if err := desktopSetMiniTitlebarHidden(true); err != nil {
			t.Fatal(err)
		}
		if err := desktopSetMiniAspect(a.Width, a.Height, true); err != nil {
			t.Fatal(err)
		}
		_, cw, ch, _, _, _, _, _ = miniWindowsContent(hwnd)
		if math.Abs(float64(cw*a.Height-ch*a.Width)) > float64(max(a.Width, a.Height)) {
			t.Fatal("hidden titlebar changed content ratio")
		}
		if err := desktopSetMiniTitlebarHidden(false); err != nil {
			t.Fatal(err)
		}
	}
	if err := desktopSetMiniAspect(0, 0, false); err != nil {
		t.Fatal(err)
	}
	current, _, _ := miniGetProcedure.Call(hwnd, uintptr(index))
	if current != original {
		t.Fatal("original window procedure was not restored")
	}
	miniSetWindowPos.Call(hwnd, 0, 100, 100, 680, 460, 0x0014)
	frame, _, _, _, _, _, _, _ := miniWindowsContent(hwnd)
	if frame.Right-frame.Left != 680 || frame.Bottom-frame.Top != 460 {
		t.Fatal("normal bounds still constrained")
	}
	parent, _, _ := miniUser32.NewProc("GetParent").Call(child)
	if parent != hwnd {
		t.Fatal("native content replaced")
	}
}
