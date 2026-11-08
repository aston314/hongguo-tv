//go:build linux

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeMiniTitlebarLinux(t *testing.T) {
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		t.Skip("run under Xvfb or a desktop session")
	}
	flags, err := exec.Command("pkg-config", "--cflags", "--libs", "gtk+-3.0").Output()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "titlebar-check")
	args := append([]string{"-Wall", "-Wextra", "-Wno-unused-parameter", "testdata/mini_titlebar_linux.c", "-o", path}, strings.Fields(string(flags))...)
	if output, err := exec.Command("cc", args...).CombinedOutput(); err != nil {
		t.Fatalf("compile native titlebar harness: %v\n%s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, path).CombinedOutput(); err != nil {
		t.Fatalf("native GTK titlebar: %v\n%s", err, output)
	}
}
