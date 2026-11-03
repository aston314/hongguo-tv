package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Custom playback devices are deliberately separate from account and anonymous
// identities. They are used only for the final playback-address fallback.
type playbackCustomDevice struct {
	DID string `json:"did"`
	UID string `json:"uid,omitempty"`
}

var playbackCustomDeviceState = struct {
	sync.RWMutex
	path  string
	value playbackCustomDevice
}{
	value: playbackCustomDevice{},
}

var playbackDeviceIDRE = regexp.MustCompile(`^[0-9]{1,32}$`)

func initPlaybackCustomDevice(path string) error {
	playbackCustomDeviceState.Lock()
	defer playbackCustomDeviceState.Unlock()
	playbackCustomDeviceState.path = path
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var value playbackCustomDevice
	if err := json.Unmarshal(b, &value); err != nil {
		return err
	}
	if value.DID != "" {
		if err := validatePlaybackCustomDevice(value); err != nil {
			return err
		}
	}
	playbackCustomDeviceState.value = value
	return nil
}

func validatePlaybackCustomDevice(value playbackCustomDevice) error {
	value.DID = strings.TrimSpace(value.DID)
	value.UID = strings.TrimSpace(value.UID)
	if value.DID == "" {
		if value.UID != "" {
			return errors.New("手机设备号 did 不能为空")
		}
		return nil
	}
	if !playbackDeviceIDRE.MatchString(value.DID) || value.DID == "0" {
		return errors.New("手机设备号 did 格式无效")
	}
	if value.UID != "" && (!playbackDeviceIDRE.MatchString(value.UID) || value.UID == "0") {
		return errors.New("手机设备号 uid 格式无效")
	}
	return nil
}

func getPlaybackCustomDevice() playbackCustomDevice {
	playbackCustomDeviceState.RLock()
	defer playbackCustomDeviceState.RUnlock()
	return playbackCustomDeviceState.value
}

func setPlaybackCustomDevice(value playbackCustomDevice) error {
	value.DID = strings.TrimSpace(value.DID)
	value.UID = strings.TrimSpace(value.UID)
	if err := validatePlaybackCustomDevice(value); err != nil {
		return err
	}
	playbackCustomDeviceState.Lock()
	defer playbackCustomDeviceState.Unlock()
	if value.DID == "" {
		value = playbackCustomDevice{}
	}
	if playbackCustomDeviceState.path != "" {
		if err := atomicPrivateJSON(filepath.Clean(playbackCustomDeviceState.path), value); err != nil {
			return errors.New("手机设备号保存失败")
		}
	}
	playbackCustomDeviceState.value = value
	return nil
}

func (s *server) playbackCustomDevice(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": getPlaybackCustomDevice()})
	case http.MethodPost:
		var value playbackCustomDevice
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&value); err != nil {
			writeError(w, http.StatusBadRequest, "手机设备号参数无效")
			return
		}
		if err := setPlaybackCustomDevice(value); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": getPlaybackCustomDevice()})
	default:
		w.Header().Set("Allow", "GET, POST, OPTIONS")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
