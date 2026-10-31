package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed frontend/dist/index.html
var startupHTML string

// Set to the same version/commit as the bundled Go core by CI.
var version = "desktop-dev"

type desktopApp struct {
	core          *coreHost
	updater       *desktopUpdater
	ctx           context.Context
	exitConfirmed atomic.Bool
	exitPending   atomic.Bool
}

func (a *desktopApp) startup(ctx context.Context) {
	a.ctx = ctx
	configureDesktopMedia()
	a.core.start()
	go a.updater.automatic()
}
func (a *desktopApp) shutdown(ctx context.Context) { a.updater.close(); a.core.stop() }
func (a *desktopApp) SetFullscreen(enabled bool) {
	if enabled {
		wruntime.WindowFullscreen(a.ctx)
	} else {
		wruntime.WindowUnfullscreen(a.ctx)
	}
}
func (a *desktopApp) GetWindowState() string {
	state := struct {
		Hidden     bool `json:"hidden"`
		Fullscreen bool `json:"fullscreen"`
	}{desktopWindowHidden(a.ctx), wruntime.WindowIsFullscreen(a.ctx)}
	b, _ := json.Marshal(state)
	return string(b)
}
func (a *desktopApp) OpenDownloads() {
	wruntime.BrowserOpenURL(a.ctx, "https://github.com/aston314/hongguo-tv/releases")
}
func (a *desktopApp) GetUpdateStatus() string {
	b, _ := json.Marshal(a.updater.snapshot())
	return string(b)
}
func (a *desktopApp) CheckUpdate()    { a.updater.check() }
func (a *desktopApp) DownloadUpdate() { a.updater.download() }
func (a *desktopApp) OpenUpdateFolder() {
	status := a.updater.snapshot()
	if status.State != "ready" || status.File == "" {
		return
	}
	// The folder opener only receives a path produced by this updater.
	directory := filepath.Dir(status.File)
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("explorer.exe", directory)
	} else if runtime.GOOS == "linux" {
		cmd = exec.Command("xdg-open", directory)
	} else {
		cmd = exec.Command("/usr/bin/open", directory)
	}
	configureProcess(cmd)
	go func() {
		if err := cmd.Run(); err != nil {
			a.updater.mu.Lock()
			a.updater.status.Message = "无法打开文件夹，ZIP 已保存在下载目录。"
			a.updater.mu.Unlock()
		}
	}()
}

func (a *desktopApp) FinishExit() {
	if !a.exitConfirmed.Swap(true) {
		wruntime.Quit(a.ctx)
	}
}
func (a *desktopApp) beforeClose(ctx context.Context) bool {
	if a.exitConfirmed.Load() {
		return false
	}
	if a.exitPending.Swap(true) {
		return true
	}
	labels, cancel := []string{"取消", "退出"}, "取消"
	if runtime.GOOS == "windows" {
		labels, cancel = []string{"Yes", "No"}, "no"
	}
	answer, err := wruntime.MessageDialog(ctx, wruntime.MessageDialogOptions{
		Type: wruntime.QuestionDialog, Title: "退出红果短剧", Message: "确定退出红果短剧吗？观看记录会保留。",
		Buttons: labels, DefaultButton: cancel, CancelButton: cancel,
	})
	if err != nil || answer != "退出" && answer != "Yes" {
		a.exitPending.Store(false)
		return true
	}
	wruntime.WindowExecJS(ctx, "Promise.resolve(window.HongguoTV ? window.HongguoTV.prepareExit() : null).then(function(){window.go.main.desktopApp.FinishExit();},function(){window.go.main.desktopApp.FinishExit();});")
	go func() { time.Sleep(5 * time.Second); a.FinishExit() }()
	return true
}

func main() {
	if runDesktopDiagnosticMode() {
		return
	}
	dataDir, err := desktopDataDir()
	if err != nil {
		log.Fatal(err)
	}
	downloads, err := downloadDirectory()
	if err != nil {
		log.Fatal(err)
	}
	code, err := strconv.Atoi(desktopVersionCode)
	if err != nil {
		log.Fatal(err)
	}
	app := &desktopApp{core: newCoreHost(), updater: newDesktopUpdater(code, dataDir, downloads, desktopPlatform())}
	err = wails.Run(desktopOptions(app, dataDir))
	if err != nil {
		app.core.stop()
		log.Fatal(err)
	}
}

func desktopOptions(app *desktopApp, dataDir string) *options.App {
	// On Linux, queue configuration before the WebView's initial navigation.
	configureDesktopMedia()
	return &options.App{
		Title: "红果短剧", Width: 1280, Height: 800, MinWidth: 960, MinHeight: 540,
		BackgroundColour: options.NewRGB(12, 13, 18),
		// No Assets filesystem: the core's embedded index is the actual page.
		AssetServer: &assetserver.Options{Handler: http.HandlerFunc(app.core.proxy)},
		OnStartup:   app.startup, OnShutdown: app.shutdown, OnBeforeClose: app.beforeClose,
		Bind:    []interface{}{app},
		Mac:     &mac.Options{Preferences: &mac.Preferences{TabFocusesLinks: mac.Enabled, TextInteractionEnabled: mac.Enabled, FullscreenEnabled: mac.Enabled}},
		Windows: &windows.Options{Theme: windows.Dark, WebviewUserDataPath: filepath.Join(dataDir, "webview2")},
		Linux:   desktopLinuxOptions(),
		SingleInstanceLock: &options.SingleInstanceLock{UniqueId: "rocks.aston.hongguo.desktop", OnSecondInstanceLaunch: func(options.SecondInstanceData) {
			if app.ctx != nil {
				wruntime.WindowShow(app.ctx)
				wruntime.WindowUnminimise(app.ctx)
			}
		}},
	}
}

func desktopDataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "HongguoDesktop"), nil
}
