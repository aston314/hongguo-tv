//go:build windows

package main

import "golang.org/x/sys/windows"

var desktopKernel32 = windows.NewLazySystemDLL("kernel32.dll")
var desktopSetThreadExecutionState = desktopKernel32.NewProc("SetThreadExecutionState")

func desktopSetPlaybackAwake(active bool) {
	_, _, _ = desktopSetThreadExecutionState.Call(desktopExecutionFlags(active))
}
