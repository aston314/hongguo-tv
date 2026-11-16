package main

import "testing"

func TestDesktopExecutionFlags(t *testing.T) {
	if got := desktopExecutionFlags(true); got != desktopExecutionContinuous|desktopExecutionSystemRequired|desktopExecutionDisplayRequired {
		t.Fatalf("active playback flags = %#x", got)
	}
	if got := desktopExecutionFlags(false); got != desktopExecutionContinuous {
		t.Fatalf("released playback flags = %#x", got)
	}
}
