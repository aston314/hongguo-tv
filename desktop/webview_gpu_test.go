package main

import (
	"runtime"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

func TestLinuxWebviewGpuPolicy(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  linux.WebviewGpuPolicy
	}{
		{"", linux.WebviewGpuPolicyOnDemand},
		{"1", linux.WebviewGpuPolicyOnDemand},
		{"on-demand", linux.WebviewGpuPolicyOnDemand},
		{" OnDemand \n", linux.WebviewGpuPolicyOnDemand},
		{"2", linux.WebviewGpuPolicyNever},
		{" NEVER ", linux.WebviewGpuPolicyNever},
		{"0", linux.WebviewGpuPolicyAlways},
		{"Always", linux.WebviewGpuPolicyAlways},
		{"invalid", linux.WebviewGpuPolicyOnDemand},
		{"-1", linux.WebviewGpuPolicyOnDemand},
		{"3", linux.WebviewGpuPolicyOnDemand},
	} {
		t.Run(tc.value, func(t *testing.T) {
			if got := linuxWebviewGpuPolicy(tc.value); got != tc.want {
				t.Fatalf("policy(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestDesktopLinuxOptions(t *testing.T) {
	for _, value := range []string{"", "2", "0", "invalid"} {
		t.Setenv("HONGGUO_WEBKIT_GPU_POLICY", value)
		got := desktopLinuxOptions()
		if runtime.GOOS != "linux" {
			if got != nil {
				t.Fatal("Linux GPU policy must not configure other platforms")
			}
			continue
		}
		if got == nil || got.WebviewGpuPolicy != linuxWebviewGpuPolicy(value) {
			t.Fatalf("Linux options for %q did not apply the selected policy: %+v", value, got)
		}
	}
}
