//go:build !linux && !windows

package main

func runDesktopDiagnosticMode() bool { return false }
