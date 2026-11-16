package main

const (
	desktopExecutionSystemRequired  uintptr = 0x00000001
	desktopExecutionDisplayRequired uintptr = 0x00000002
	desktopExecutionContinuous      uintptr = 0x80000000
)

func desktopExecutionFlags(active bool) uintptr {
	if !active {
		return desktopExecutionContinuous
	}
	return desktopExecutionContinuous | desktopExecutionSystemRequired | desktopExecutionDisplayRequired
}
