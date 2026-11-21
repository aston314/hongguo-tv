//go:build windows

package main

import (
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var miniGetProcedure = miniUser32.NewProc("GetWindowLongPtrW")
var miniSetProcedure = miniUser32.NewProc("SetWindowLongPtrW")
var miniCallProcedure = miniUser32.NewProc("CallWindowProcW")
var miniDefaultProcedure = miniUser32.NewProc("DefWindowProcW")
var miniGetWindowRect = miniUser32.NewProc("GetWindowRect")
var miniGetClientRect = miniUser32.NewProc("GetClientRect")
var miniCopyMemory = windows.NewLazySystemDLL("kernel32.dll").NewProc("RtlMoveMemory")
var miniAspectWindows atomic.Pointer[miniWindowsAspect]
var miniAspectProcedure uintptr
var miniAspectProcedureOnce sync.Once

const miniAspectApplyMessage = 0x8000 + 0x3a1

type miniNativeRect struct{ Left, Top, Right, Bottom int32 }

// LPARAM points at native memory, not a Go allocation. Copy across the syscall
// boundary instead of converting an untracked uintptr into a Go pointer.
func miniReadNativeRect(address uintptr) (rect miniNativeRect) {
	miniCopyMemory.Call(uintptr(unsafe.Pointer(&rect)), address, unsafe.Sizeof(rect))
	return
}
func miniWriteNativeRect(address uintptr, rect *miniNativeRect) {
	miniCopyMemory.Call(address, uintptr(unsafe.Pointer(rect)), unsafe.Sizeof(*rect))
}

type miniWindowsAspect struct {
	hwnd, previous             uintptr
	aspect                     miniAspect
	active, fitting, suspended atomic.Bool
}

func miniAspectCanResize(hwnd uintptr) bool {
	zoomed, _, _ := miniUser32.NewProc("IsZoomed").Call(hwnd)
	iconic, _, _ := miniUser32.NewProc("IsIconic").Call(hwnd)
	index := int32(-16)
	style, _, _ := miniGetStyle.Call(hwnd, uintptr(index))
	// Wails fullscreen removes WS_THICKFRAME. Hidden titlebars retain it.
	return zoomed == 0 && iconic == 0 && style&0x00040000 != 0
}

func miniWindowsContent(hwnd uintptr) (frame miniNativeRect, cw, ch, dw, dh int, work miniNativeRect, scale float64, ok bool) {
	var client miniNativeRect
	a, _, _ := miniGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&frame)))
	b, _, _ := miniGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	if a == 0 || b == 0 {
		return
	}
	cw, ch = int(client.Right-client.Left), int(client.Bottom-client.Top)
	dw, dh = max(0, int(frame.Right-frame.Left)-cw), max(0, int(frame.Bottom-frame.Top)-ch)
	monitor, _, _ := miniUser32.NewProc("MonitorFromWindow").Call(hwnd, 2)
	info := struct {
		Size          uint32
		Monitor, Work miniNativeRect
		Flags         uint32
	}{}
	info.Size = uint32(unsafe.Sizeof(info))
	got, _, _ := miniUser32.NewProc("GetMonitorInfoW").Call(monitor, uintptr(unsafe.Pointer(&info)))
	if got == 0 || cw <= 0 || ch <= 0 {
		return
	}
	work, scale = info.Work, 1
	dpiProc := miniUser32.NewProc("GetDpiForWindow")
	if dpiProc.Find() == nil {
		if dpi, _, _ := dpiProc.Call(hwnd); dpi > 0 {
			scale = float64(dpi) / 96
		}
	}
	ok = true
	return
}

func miniWindowsFit(s *miniWindowsAspect) bool {
	if !s.active.Load() {
		return true
	}
	if !miniAspectCanResize(s.hwnd) {
		s.suspended.Store(true)
		return true
	}
	if !s.fitting.CompareAndSwap(false, true) {
		return true
	}
	defer s.fitting.Store(false)
	frame, cw, ch, dw, dh, work, scale, ok := miniWindowsContent(s.hwnd)
	if !ok {
		return false
	}
	longest := max(cw, ch)
	w, h := fitMiniContent(longest, longest, s.aspect,
		max(1, int(math.Round(280*scale))-dw), max(1, int(math.Round(200*scale))-dh),
		int(work.Right-work.Left)-dw-int(24*scale), int(work.Bottom-work.Top)-dh-int(24*scale), s.aspect.Width < s.aspect.Height)
	w, h = w+dw, h+dh
	x := max(int(work.Left), min(int(frame.Left), int(work.Right)-w))
	y := max(int(work.Top), min(int(frame.Top), int(work.Bottom)-h))
	if !s.active.Load() {
		return true
	}
	if x == int(frame.Left) && y == int(frame.Top) && w == int(frame.Right-frame.Left) && h == int(frame.Bottom-frame.Top) {
		return true
	}
	result, _, _ := miniSetWindowPos.Call(s.hwnd, 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h), 0x0014)
	return result != 0
}

func miniConstrainSizing(s *miniWindowsAspect, edge uintptr, rect *miniNativeRect) {
	_, cw, ch, dw, dh, work, scale, ok := miniWindowsContent(s.hwnd)
	if !ok || edge < 1 || edge > 8 {
		return
	}
	w, h := int(rect.Right-rect.Left)-dw, int(rect.Bottom-rect.Top)-dh
	heightDriven := edge == 3 || edge == 6
	if edge == 4 || edge == 5 || edge == 7 || edge == 8 {
		heightDriven = math.Abs(float64(h-ch)) > math.Abs(float64(w-cw))*float64(s.aspect.Height)/float64(s.aspect.Width)
	}
	w, h = fitMiniContent(w, h, s.aspect, max(1, int(280*scale)-dw), max(1, int(200*scale)-dh),
		int(work.Right-work.Left)-dw, int(work.Bottom-work.Top)-dh, heightDriven)
	w, h = w+dw, h+dh
	if edge == 1 || edge == 4 || edge == 7 {
		rect.Left = rect.Right - int32(w)
	} else {
		rect.Right = rect.Left + int32(w)
	}
	if edge == 3 || edge == 4 || edge == 5 {
		rect.Top = rect.Bottom - int32(h)
	} else {
		rect.Bottom = rect.Top + int32(h)
	}
}

func miniAspectWindowProcedure(hwnd uintptr, msg uint32, wp, lp uintptr) uintptr {
	s := miniAspectWindows.Load()
	if s == nil || s.hwnd != hwnd {
		result, _, _ := miniDefaultProcedure.Call(hwnd, uintptr(msg), wp, lp)
		return result
	}
	if msg == miniAspectApplyMessage {
		if wp == 0 || miniWindowsFit(s) {
			return 1
		}
		return 0
	}
	result, _, _ := miniCallProcedure.Call(s.previous, hwnd, uintptr(msg), wp, lp)
	if msg == 0x0082 { // WM_NCDESTROY
		s.active.Store(false)
		miniAspectWindows.CompareAndSwap(s, nil)
		return result
	}
	if !s.active.Load() {
		return result
	}
	if msg == 0x0214 && lp != 0 && miniAspectCanResize(hwnd) { // WM_SIZING: constrain the drag rectangle, not a later WM_SIZE correction.
		rect := miniReadNativeRect(lp)
		miniConstrainSizing(s, wp, &rect)
		miniWriteNativeRect(lp, &rect)
		return 1
	}
	if msg == 0x0005 { // WM_SIZE, including native maximise/restore/fullscreen.
		if !miniAspectCanResize(hwnd) {
			s.suspended.Store(true)
		} else if s.suspended.Swap(false) {
			miniWindowsFit(s)
		}
	}
	if msg == 0x02e0 {
		miniWindowsFit(s)
	} // Framework has applied the DPI-suggested rectangle.
	return result
}

func desktopSetMiniAspect(width, height int, refit bool) error {
	old := miniAspectWindows.Load()
	index := int32(-4) // GWLP_WNDPROC
	if width == 0 && height == 0 {
		if old == nil {
			return nil
		}
		old.active.Store(false)
		current, _, _ := miniGetProcedure.Call(old.hwnd, uintptr(index))
		if current == miniAspectProcedure {
			miniSetProcedure.Call(old.hwnd, uintptr(index), old.previous)
			actual, _, _ := miniGetProcedure.Call(old.hwnd, uintptr(index))
			if actual != old.previous {
				return errors.New("cannot restore window procedure")
			}
		}
		// Keep the inactive chain target alive if another subclass wraps ours.
		return nil
	}
	aspect := videoMiniAspect(width, height)
	if !aspect.valid() {
		return errors.New("invalid video aspect")
	}
	hwnd := miniWindowHandle()
	if hwnd == 0 || old != nil && old.hwnd != hwnd && old.active.Load() {
		return errors.New("desktop window unavailable")
	}
	miniAspectProcedureOnce.Do(func() { miniAspectProcedure = syscall.NewCallback(miniAspectWindowProcedure) })
	previous, _, _ := miniGetProcedure.Call(hwnd, uintptr(index))
	if previous == 0 {
		return errors.New("window procedure unavailable")
	}
	if old != nil && old.hwnd == hwnd && previous != miniAspectProcedure && previous != old.previous {
		return errors.New("window procedure changed") // do not wrap a foreign chain back into ourselves
	}
	if previous == miniAspectProcedure {
		if old == nil {
			return errors.New("window aspect chain unavailable")
		}
		previous = old.previous
	}
	s := &miniWindowsAspect{hwnd: hwnd, previous: previous, aspect: aspect}
	s.active.Store(true)
	if old != nil {
		old.active.Store(false)
	}
	miniAspectWindows.Store(s)
	current, _, _ := miniGetProcedure.Call(hwnd, uintptr(index))
	if current != miniAspectProcedure {
		miniSetProcedure.Call(hwnd, uintptr(index), miniAspectProcedure)
		actual, _, _ := miniGetProcedure.Call(hwnd, uintptr(index))
		if actual != miniAspectProcedure {
			s.active.Store(false)
			return errors.New("window aspect hook failed")
		}
	}
	var answer uintptr
	fit := uintptr(0)
	if refit {
		fit = 1
	}
	ok, _, _ := miniUser32.NewProc("SendMessageTimeoutW").Call(hwnd, miniAspectApplyMessage, fit, 0, 2, 2000, uintptr(unsafe.Pointer(&answer)))
	if ok == 0 || answer != 1 {
		s.active.Store(false)
		return errors.New("window aspect update failed")
	}
	return nil
}
