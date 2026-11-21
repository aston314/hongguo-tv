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

func TestNativeMiniAspectLinux(t *testing.T) {
	if os.Getenv("DISPLAY") == "" {
		t.Skip("native X11 geometry harness requires Xvfb")
	}
	flags, err := exec.Command("pkg-config", "--cflags", "--libs", "gtk+-3.0", "x11").Output()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "aspect-check")
	args := append([]string{"-Wall", "-Wextra", "-Wno-unused-parameter", "testdata/mini_aspect_linux.c", "-o", path}, strings.Fields(string(flags))...)
	args = append(args, "-lm")
	if output, err := exec.Command("cc", args...).CombinedOutput(); err != nil {
		t.Fatalf("compile native GTK aspect harness: %v\n%s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, path).CombinedOutput(); err != nil {
		t.Fatalf("native GTK aspect: %v\n%s", err, output)
	}
}
