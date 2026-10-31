package main

import (
	"log"
	"os"
	"runtime"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

func desktopLinuxOptions() *linux.Options {
	if runtime.GOOS != "linux" {
		return nil
	}
	policy := linuxWebviewGpuPolicy(os.Getenv("HONGGUO_WEBKIT_GPU_POLICY"))
	log.Printf("Linux WebView GPU policy: %d (0=always, 1=on-demand, 2=never)", policy)
	return &linux.Options{WebviewGpuPolicy: policy}
}

func linuxWebviewGpuPolicy(value string) linux.WebviewGpuPolicy {
	// A nil Linux options object makes Wails 2.11 disable compositing. Allow
	// WebKit to accelerate video on demand, with the old path as an explicit
	// escape hatch for incompatible graphics drivers. Do not change decoding.
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "1", "on-demand", "ondemand":
		return linux.WebviewGpuPolicyOnDemand
	case "2", "never":
		return linux.WebviewGpuPolicyNever
	case "0", "always":
		return linux.WebviewGpuPolicyAlways
	default:
		log.Printf("Invalid HONGGUO_WEBKIT_GPU_POLICY; using on-demand")
		return linux.WebviewGpuPolicyOnDemand
	}
}
