//go:build darwin

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestNativeWindowRestoration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "window-state-check")
	cmd := exec.Command("clang", "-fobjc-arc", "-framework", "Cocoa", "testdata/window_state_darwin.m", "-o", path)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("compile native regression harness: %v\n%s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	var args []string
	// Interactive Space animations are opt-in; the observer/frame regression
	// and off-screen checks still run in the normal macOS test/CI suite.
	if os.Getenv("HONGGUO_TEST_NATIVE_FULLSCREEN") == "1" {
		args = append(args, "--fullscreen")
	}
	if output, err := exec.CommandContext(ctx, path, args...).CombinedOutput(); err != nil {
		t.Fatalf("native window regression: %v\n%s", err, output)
	} else {
		t.Log(string(output))
	}
}
