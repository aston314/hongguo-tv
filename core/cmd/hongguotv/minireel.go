package main

// Embedded playback resolver, adapted from the validated MiniReel protocol.
// The signed video_model endpoint supplies a short-lived MP4 URL and spade_a
// content key. This service prepares the selected episode, decrypts its CENC
// AES-CTR samples in place, and exposes an MP4 URL with Range support. The
// Android WebView owns playback and its controls; media is not transcoded.

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	miniReelMaxJSONBytes       = 5 * 1024 * 1024
	miniReelAPIBase            = "https://api5-normal-sinfonlineb.fqnovel.com"
	miniReelAPIPath            = "/novel/player/video_model/v1/"
	miniReelAppUA              = "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)"
	miniReelTTL                = 2 * time.Hour
	miniReelRangeTTL           = 15 * time.Minute
	miniReelMaxBytes           = 512 << 20
	miniReelMaxCache           = 512 << 20
	miniReelVideoModelAttempts = 3
)

var miniReelDefinitionRE = regexp.MustCompile(`(?i)(\d{3,4})`)
var miniReelCacheTokenRE = regexp.MustCompile(`^[a-f0-9]{24}$`)
var miniReelCacheFileRE = regexp.MustCompile(`^[a-f0-9]{24}\.mp4$`)

type miniReelOption struct {
	URL      string
	Key      []byte
	Height   int
	Quality  string
	Duration int
}

type miniReelMediaJob struct {
	Ready       chan struct{}
	Path        string
	Range       *miniReelRangeSource
	Mode        string
	Quality     string
	Qualities   []string
	Err         error
	Accessed    time.Time
	Context     context.Context
	Cancel      context.CancelFunc
	Waiters     int
	ResolveMS   int64
	DownloadMS  int64
	DecryptMS   int64
	RangeInitMS int64
}

var miniReelState = struct {
	sync.Mutex
	jobs            map[string]*miniReelMediaJob
	root            string
	lease           *os.File
	lastRootCleanup time.Time
}{jobs: make(map[string]*miniReelMediaJob)}

// plan/v is a metadata endpoint and keeps its existing process identity. This
// unregistered identity must not be used for video_model.
var miniReelSeasonIdentity = struct {
	sync.Once
	deviceID  string
	installID string
}{}

var errMiniReelVideoModelEmpty = errors.New("MiniReel video_model response is empty")

// Since 2026-10-26 video_model answers 200 with an empty body unless the
// device identity came from device_register. A registered identity can be
// reused, so keep one per process and replace it only after an empty response.
type miniReelDevice struct {
	deviceID  string
	installID string
}

var miniReelRegistration = struct {
	sync.Mutex
	base   string
	device miniReelDevice
}{base: passportDeviceAPI}

func handleMiniReelResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	seriesID := strings.TrimSpace(r.URL.Query().Get("series_id"))
	vid := strings.TrimSpace(r.URL.Query().Get("vid"))
	if !miniReelIDRE.MatchString(seriesID) || !miniReelIDRE.MatchString(vid) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "series_id and vid must be numeric"})
		return
	}

	result, err := resolveMiniReelMedia(r.Context(), seriesID, vid)
	if err != nil {
		log.Printf("[minireel] %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error(), "vid": vid})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

var miniReelIDRE = regexp.MustCompile(`^[0-9]{1,32}$`)

func handleMiniReelMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		miniReelApplyCORS(w.Header())
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/minireel-proxy/media/")
	if !regexp.MustCompile(`^[a-f0-9]{24}\.mp4$`).MatchString(name) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid media token"})
		return
	}
	token := strings.TrimSuffix(name, ".mp4")
	w = &diagnosticMediaWriter{ResponseWriter: w, token: token}

	miniReelState.Lock()
	job := miniReelState.jobs[token]
	if job != nil {
		job.Accessed = time.Now()
	}
	miniReelState.Unlock()
	if job == nil || !isMiniReelReady(job.Ready) {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "media is not prepared"})
		return
	}
	if job.Range != nil {
		serveMiniReelRangeMedia(w, r, job.Range)
		return
	}
	if job.Path == "" {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "media is not prepared"})
		return
	}
	file, err := os.Open(job.Path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "media is no longer available"})
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "media is no longer available"})
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	miniReelApplyCORS(w.Header())
	http.ServeContent(w, r, name, stat.ModTime(), file)
}

func resolveMiniReelMedia(ctx context.Context, seriesID, vid string) (map[string]any, error) {
	return resolveMiniReelMediaQuality(ctx, seriesID, vid, "", true)
}

func resolveMiniReelMediaQuality(ctx context.Context, seriesID, vid, quality string, fallback bool) (map[string]any, error) {
	return resolveMiniReelMediaWith(ctx, seriesID, vid, quality, fallback, prepareMiniReelMedia)
}

// Every foreground or speculative request joins the same preparation. Closing
// one request only cancels networking when no other consumer needs the job.
func resolveMiniReelMediaWith(ctx context.Context, seriesID, vid, quality string, fallback bool,
	prepare func(context.Context, *miniReelMediaJob, string, string, string, string, bool)) (map[string]any, error) {
	token := miniReelQualityToken(seriesID, vid, quality, fallback)
	return resolveMiniReelMediaWithToken(ctx, token, seriesID, vid, quality, fallback, prepare)
}

func resolveMiniReelMediaWithToken(ctx context.Context, token, seriesID, vid, quality string, fallback bool,
	prepare func(context.Context, *miniReelMediaJob, string, string, string, string, bool)) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	quality, err := normalizePlaybackQuality(quality)
	if err != nil {
		return nil, err
	}
	// A just-aborted speculative job must finish cleaning its partial file before
	// another job for the same token writes to that directory.
acquire:
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	miniReelState.Lock()
	miniReelCleanupLocked()
	job := miniReelState.jobs[token]
	if job != nil && !isMiniReelReady(job.Ready) && job.Context != nil && job.Context.Err() != nil {
		ready := job.Ready
		miniReelState.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ready:
			goto acquire
		}
	}
	// Failed preparations must be retryable, rather than cached for the TTL.
	if job != nil && isMiniReelReady(job.Ready) && job.Err != nil {
		delete(miniReelState.jobs, token)
		job = nil
	}
	if job != nil && isMiniReelReady(job.Ready) && job.Path != "" {
		if _, err := os.Stat(job.Path); err != nil {
			delete(miniReelState.jobs, token)
			job = nil
		}
	}
	if job == nil {
		jobCtx, cancel := context.WithTimeout(context.Background(), 95*time.Second)
		job = &miniReelMediaJob{Ready: make(chan struct{}), Accessed: time.Now(), Context: jobCtx, Cancel: cancel}
		miniReelState.jobs[token] = job
		go func() {
			prepare(jobCtx, job, token, seriesID, vid, quality, fallback)
			miniReelState.Lock()
			job.Accessed = time.Now()
			cancel()
			close(job.Ready)
			miniReelCleanupLocked()
			miniReelState.Unlock()
		}()
	} else {
		job.Accessed = time.Now()
	}
	ready := job.Ready
	job.Waiters++
	miniReelState.Unlock()
	defer func() {
		miniReelState.Lock()
		job.Waiters--
		if job.Waiters == 0 && !isMiniReelReady(job.Ready) && job.Cancel != nil {
			job.Cancel()
		}
		if isMiniReelReady(job.Ready) {
			miniReelCleanupLocked()
		}
		miniReelState.Unlock()
	}()

	timer := time.NewTimer(95 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, errors.New("MiniReel media preparation timed out")
	case <-ready:
	}
	miniReelState.Lock()
	defer miniReelState.Unlock()
	if job.Err != nil {
		return nil, job.Err
	}
	return map[string]any{
		"path":      "/minireel-proxy/media/" + token + ".mp4",
		"quality":   job.Quality,
		"qualities": job.Qualities,
		"vid":       vid,
		"mode":      firstNonEmpty(job.Mode, "full"),
	}, nil
}

func prepareMiniReelMedia(ctx context.Context, job *miniReelMediaJob, token, seriesID, vid, quality string, fallback bool) {
	directory := ""
	defer func() {
		if job.Err != nil && directory != "" {
			_ = os.RemoveAll(directory)
		}
	}()
	resolveStarted := time.Now()
	options, err := miniReelNativeOptions(ctx, vid)
	job.ResolveMS = time.Since(resolveStarted).Milliseconds()
	if err != nil {
		job.Err = err
		return
	}
	if len(options) == 0 {
		job.Err = errors.New("MiniReel returned no compatible video source")
		return
	}
	option, err := selectMiniReelQuality(options, quality, fallback)
	if err != nil {
		job.Err = err
		return
	}
	job.Quality = option.Quality
	job.Qualities = miniReelQualities(options)
	job.Mode = "full"
	if err := ensureMiniReelRoot(); err != nil {
		job.Err = err
		return
	}
	directory = filepath.Join(miniReelState.root, token)
	if err := os.MkdirAll(directory, 0700); err != nil {
		job.Err = err
		return
	}
	path := filepath.Join(directory, token+".mp4")
	downloadStarted := time.Now()
	if err := downloadMiniReelMedia(ctx, option.URL, path); err != nil {
		job.DownloadMS = time.Since(downloadStarted).Milliseconds()
		job.Err = err
		return
	}
	job.DownloadMS = time.Since(downloadStarted).Milliseconds()
	if err := ctx.Err(); err != nil {
		job.Err = err
		return
	}
	if len(option.Key) > 0 {
		decryptStarted := time.Now()
		if err := decryptMiniReelMP4(path, option.Key); err != nil {
			job.DecryptMS = time.Since(decryptStarted).Milliseconds()
			job.Err = fmt.Errorf("MiniReel CENC decrypt failed: %w", err)
			return
		}
		job.DecryptMS = time.Since(decryptStarted).Milliseconds()
	}
	if err := ctx.Err(); err != nil {
		job.Err = err
		return
	}
	job.Path = path
	_ = seriesID // kept in the job key so the same vid cannot cross series contexts.
}

func ensureMiniReelRoot() error {
	miniReelState.Lock()
	defer miniReelState.Unlock()
	if miniReelState.root == "" {
		// Android's os.TempDir may resolve to /data/local/tmp, which is not
		// writable by an ordinary application. ProxyService supplies the app
		// cache directory through MINIREEL_CACHE_DIR; keep portable fallbacks
		// for desktop builds and older APKs.
		candidates := []string{}
		if configured := strings.TrimSpace(os.Getenv("MINIREEL_CACHE_DIR")); configured != "" {
			candidates = append(candidates, configured)
		}
		if cache, err := os.UserCacheDir(); err == nil && strings.TrimSpace(cache) != "" {
			candidates = append(candidates, filepath.Join(cache, "hongguo-tv", "minireel"))
		}
		candidates = append(candidates, os.TempDir())
		var lastErr error
		for _, base := range candidates {
			if base == "" {
				continue
			}
			if err := os.MkdirAll(base, 0700); err != nil {
				lastErr = err
				continue
			}
			root, err := os.MkdirTemp(base, "minireel-go-")
			if err == nil {
				lease, leaseErr := createMediaCacheLease(root)
				if leaseErr != nil && leaseErr != os.ErrInvalid {
					_ = os.RemoveAll(root)
					lastErr = leaseErr
					continue
				}
				miniReelState.root = root
				miniReelState.lease = lease
				if leaseErr == nil {
					// Never migrate unmarked directories in a shared system temp
					// folder. The configured/user cache is owned by this application.
					cleanupMediaCacheRoots(base, root, filepath.Clean(base) != filepath.Clean(os.TempDir()))
					miniReelState.lastRootCleanup = time.Now()
				}
				break
			}
			lastErr = err
		}
		if miniReelState.root == "" {
			if lastErr == nil {
				lastErr = errors.New("no writable cache directory")
			}
			return lastErr
		}
	}
	return nil
}

func createMediaCacheLease(root string) (*os.File, error) {
	file, err := os.OpenFile(filepath.Join(root, ".core-lease"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := lockMediaCacheLease(file); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

// An inactive marked directory cannot be reused: its job index existed only
// in the exited process. Recent pre-lease directories are retained for the
// original TTL so a concurrent older core is not interrupted during migration.
func cleanupMediaCacheRoots(base, current string, migrateLegacy bool) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "minireel-go-") {
			continue
		}
		root := filepath.Join(base, entry.Name())
		if root == current {
			continue
		}
		leasePath := filepath.Join(root, ".core-lease")
		info, err := os.Lstat(leasePath)
		if os.IsNotExist(err) {
			if migrateLegacy && expiredLegacyMediaRoot(root) {
				_ = os.RemoveAll(root)
			}
			continue
		}
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		file, err := os.OpenFile(leasePath, os.O_RDWR, 0)
		if err != nil {
			continue
		}
		if lockMediaCacheLease(file) == nil {
			_ = os.RemoveAll(root)
		}
		_ = file.Close()
	}
}

func expiredLegacyMediaRoot(root string) bool {
	cutoff := time.Now().Add(-miniReelTTL)
	valid := true
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			valid = false
			return filepath.SkipAll
		}
		if entry.Type()&os.ModeSymlink != 0 {
			valid = false
			return filepath.SkipAll
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			valid = false
			return filepath.SkipAll
		}
		if path != root {
			if entry.IsDir() && !miniReelCacheTokenRE.MatchString(entry.Name()) ||
				!entry.IsDir() && !miniReelCacheFileRE.MatchString(entry.Name()) {
				valid = false
				return filepath.SkipAll
			}
		}
		return nil
	})
	return valid
}

func miniReelCleanupLocked() {
	now := time.Now()
	if miniReelState.lease != nil && miniReelState.root != "" && now.Sub(miniReelState.lastRootCleanup) >= time.Minute {
		base := filepath.Dir(miniReelState.root)
		cleanupMediaCacheRoots(base, miniReelState.root, filepath.Clean(base) != filepath.Clean(os.TempDir()))
		miniReelState.lastRootCleanup = now
	}
	for token, job := range miniReelState.jobs {
		ready := job.Ready != nil && isMiniReelReady(job.Ready)
		ttl := miniReelTTL
		if ready && job.Range != nil {
			ttl = miniReelRangeTTL
		}
		if job.Waiters > 0 || now.Sub(job.Accessed) <= ttl || !ready {
			continue
		}
		if miniReelState.root != "" {
			_ = os.RemoveAll(filepath.Join(miniReelState.root, token))
		}
		delete(miniReelState.jobs, token)
	}
	if miniReelState.root == "" {
		return
	}
	type cacheEntry struct {
		token    string
		accessed time.Time
		size     int64
	}
	entries := []cacheEntry{}
	var total int64
	for token, job := range miniReelState.jobs {
		if job.Ready == nil || !isMiniReelReady(job.Ready) {
			continue
		}
		size := int64(0)
		if job.Range != nil {
			size = miniReelRangeMemorySize(job.Range)
		} else if job.Path != "" {
			size = miniReelDirectorySize(filepath.Dir(job.Path))
		} else {
			continue
		}
		total += size
		if job.Waiters > 0 {
			continue
		}
		entries = append(entries, cacheEntry{token: token, accessed: job.Accessed, size: size})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].accessed.Before(entries[j].accessed) })
	for _, entry := range entries {
		if total <= miniReelMaxCache {
			break
		}
		_ = os.RemoveAll(filepath.Join(miniReelState.root, entry.token))
		delete(miniReelState.jobs, entry.token)
		total -= entry.size
	}
}

func miniReelDirectorySize(directory string) int64 {
	var total int64
	_ = filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if info, statErr := entry.Info(); statErr == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

func isMiniReelReady(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func miniReelToken(seriesID, vid string) string {
	digest := sha256.Sum256([]byte(seriesID + ":" + vid))
	return hex.EncodeToString(digest[:])[:24]
}

func normalizePlaybackQuality(quality string) (string, error) {
	quality = strings.ToUpper(strings.TrimSpace(quality))
	if quality == "" || quality == "AUTO" {
		return "", nil
	}
	if !regexp.MustCompile(`^[1-9][0-9]{2,3}P$`).MatchString(quality) {
		return "", errors.New("清晰度参数无效")
	}
	return quality, nil
}

func miniReelQualityToken(seriesID, vid, quality string, fallback bool) string {
	if quality == "" {
		return miniReelToken(seriesID, vid)
	}
	return miniReelToken(seriesID, vid+":"+quality+":"+strconv.FormatBool(fallback))
}

func miniReelQualities(options []miniReelOption) []string {
	seen := map[int]bool{}
	heights := []int{}
	for _, option := range options {
		if option.Height > 0 && option.Quality != "" && !seen[option.Height] {
			seen[option.Height] = true
			heights = append(heights, option.Height)
		}
	}
	sort.Ints(heights)
	qualities := []string{}
	for _, height := range heights {
		qualities = append(qualities, strconv.Itoa(height)+"P")
	}
	return qualities
}

func selectMiniReelQuality(options []miniReelOption, quality string, fallback bool) (miniReelOption, error) {
	if len(options) == 0 {
		return miniReelOption{}, errors.New("本集没有可播放的视频")
	}
	if quality != "" {
		for _, option := range options {
			if option.Quality == quality {
				return option, nil
			}
		}
		if !fallback {
			return miniReelOption{}, fmt.Errorf("本集不提供 %s，可重新选择清晰度", quality)
		}
	}
	return chooseMiniReelOption(options), nil
}

func miniReelNativeOptions(ctx context.Context, vid string) ([]miniReelOption, error) {
	return miniReelNativeOptionsEndpoint(ctx, vid, miniReelAPIBase+miniReelAPIPath)
}

func miniReelNativeOptionsEndpoint(ctx context.Context, vid, endpoint string) ([]miniReelOption, error) {
	var lastErr error
	for attempt := 0; attempt < miniReelVideoModelAttempts; attempt++ {
		device := miniReelPlaybackDevice(ctx)
		options, err := miniReelNativeOptionsAttempt(ctx, vid, endpoint, device)
		if err == nil {
			return options, nil
		}
		lastErr = err
		if !errors.Is(err, errMiniReelVideoModelEmpty) {
			return nil, err
		}
		miniReelDropDevice(device)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("MiniReel video_model empty after %d fresh device attempts: %w", miniReelVideoModelAttempts, lastErr)
}

func miniReelNativeOptionsAttempt(ctx context.Context, vid, endpoint string, device miniReelDevice) ([]miniReelOption, error) {
	stamp := time.Now().UnixMilli()
	params := url.Values{
		"_rticket": {strconv.FormatInt(stamp, 10)}, "ac": {"wifi"}, "aid": {"8662"},
		"channel": {"update_64"}, "device_brand": {"Redmi"}, "device_id": {device.deviceID},
		"device_platform": {"android"}, "device_type": {"25053RT47C"}, "dpi": {"520"},
		"iid": {device.installID}, "language": {"zh"}, "manifest_version_code": {"73532"},
		"os": {"android"}, "os_api": {"36"}, "os_version": {"16"}, "resolution": {"1280*2772"},
		"ssmix": {"a"}, "update_version_code": {"73532"}, "version_code": {"73532"},
		"version_name": {"7.3.5.32"}, "app_name": {"novelread"},
	}
	query := params.Encode()
	bodyBytes, _ := json.Marshal(map[string]any{
		"video_id": vid, "content_type": 1,
		"biz_param": map[string]any{"need_all_video_definition": true, "video_platform": 3},
	})
	query, signedHeaders, err := signPassportRequest(params, bodyBytes, stamp, device.deviceID)
	if err != nil {
		return nil, fmt.Errorf("MiniReel request signing failed: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"?"+query, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header = signedHeaders
	req.Header.Set("User-Agent", miniReelAppUA)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("X-XS-From-Web", "0")
	req.Header.Set("Sdk-Version", "2")
	req.Header.Set("X-SS-DP", "8662")
	req.Header.Set("X-Tt-Store-Region", "cn")
	req.Header.Set("X-Tt-Store-Region-Src", "did")
	client := &http.Client{Timeout: 35 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("MiniReel API HTTP %d", resp.StatusCode)
	}
	data, err := miniReelReadLimited(resp.Body, miniReelMaxJSONBytes)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(data)) == 0 {
		log.Printf("[minireel] video_model empty response status=%d content_length=%d tt_logid=%q device_digits=%d iid_digits=%d", resp.StatusCode, resp.ContentLength, resp.Header.Get("X-Tt-Logid"), len(device.deviceID), len(device.installID))
		return nil, errMiniReelVideoModelEmpty
	}
	var envelope map[string]any
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, err
	}
	modelValue := nestedMiniReelValue(envelope, "data", "video_model")
	if text := miniReelToString(modelValue); strings.HasPrefix(strings.TrimSpace(text), "{") {
		var decoded any
		if err := json.Unmarshal([]byte(text), &decoded); err == nil {
			modelValue = decoded
		}
	}
	model, ok := modelValue.(map[string]any)
	if !ok {
		return nil, errors.New("MiniReel response has no video_model")
	}
	rows := miniReelMapsFromAny(model["video_list"])
	options := make([]miniReelOption, 0, len(rows))
	for _, row := range rows {
		meta, _ := row["video_meta"].(map[string]any)
		encryption, _ := row["encrypt_info"].(map[string]any)
		if strings.EqualFold(miniReelToString(meta["codec_type"]), "bytevc2") {
			continue
		}
		rawURL := miniReelToString(row["main_url"])
		mediaURL := rawURL
		if !strings.HasPrefix(mediaURL, "http") {
			decoded, decodeErr := base64.StdEncoding.DecodeString(rawURL)
			if decodeErr != nil {
				decoded, decodeErr = base64.RawStdEncoding.DecodeString(rawURL)
			}
			if decodeErr != nil {
				continue
			}
			mediaURL = string(decoded)
		}
		if !strings.HasPrefix(mediaURL, "https://") {
			continue
		}
		key := []byte(nil)
		if spade := miniReelToString(encryption["spade_a"]); spade != "" {
			key, err = miniReelDecodeContentKey(spade)
			if err != nil {
				continue
			}
		}
		height := miniReelIntFromAny(meta["vheight"])
		if match := miniReelDefinitionRE.FindStringSubmatch(miniReelToString(meta["definition"])); len(match) > 1 {
			height, _ = strconv.Atoi(match[1])
		}
		quality := ""
		if height > 0 {
			quality = strconv.Itoa(height) + "P"
		}
		options = append(options, miniReelOption{URL: mediaURL, Key: key, Height: height, Quality: quality, Duration: miniReelIntFromAny(model["video_duration"])})
	}
	return options, nil
}

func miniReelRandomID() string {
	buf := make([]byte, 8)
	if _, err := crand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return strconv.FormatUint(binary.BigEndian.Uint64(buf)%8000000000000000000+1000000000000000000, 10)
}

func miniReelPlaybackDevice(ctx context.Context) miniReelDevice {
	miniReelRegistration.Lock()
	defer miniReelRegistration.Unlock()
	if miniReelRegistration.device.deviceID != "" {
		return miniReelRegistration.device
	}
	d, err := newPassportDevice()
	if err == nil {
		c := newPassportClient(accountSession{Device: d, Cookies: map[string]string{}})
		c.deviceBase = miniReelRegistration.base
		if err = c.registerDevice(ctx); err == nil {
			miniReelRegistration.device = miniReelDevice{deviceID: c.session.DeviceID, installID: c.session.InstallID}
			return miniReelRegistration.device
		}
	}
	// Some ad-blocking DNS lists block device_register; an unregistered
	// identity still ends in the existing empty-response error.
	log.Printf("[minireel] device registration failed, using unregistered identity: %v", err)
	return miniReelFreshDevice()
}

func miniReelDropDevice(device miniReelDevice) {
	miniReelRegistration.Lock()
	defer miniReelRegistration.Unlock()
	if miniReelRegistration.device == device {
		miniReelRegistration.device = miniReelDevice{}
	}
}

func miniReelFreshDevice() miniReelDevice {
	return miniReelDevice{deviceID: miniReelPlaybackID(), installID: miniReelPlaybackID()}
}

func miniReelPlaybackID() string {
	buf := make([]byte, 8)
	if _, err := crand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano()%9000000000000000+1000000000000000, 10)
	}
	return strconv.FormatUint(binary.BigEndian.Uint64(buf)%9000000000000000+1000000000000000, 10)
}

func miniReelSignRequest(query, body string, stamp int64) map[string]string {
	bodyDigest := md5.Sum([]byte(body))
	queryDigest := md5.Sum([]byte(query))
	payload := make([]byte, 20)
	copy(payload[0:4], queryDigest[:4])
	copy(payload[4:8], bodyDigest[:4])
	copy(payload[12:16], []byte{0, 6, 11, 28})
	binary.BigEndian.PutUint32(payload[16:20], uint32(stamp/1000))
	mask := []byte{0x44, 0xb9, 0xb9, 0xd9, 0xa4, 0xae, 0xf9, 0xfc, 0xa4, 0x93, 0xaa, 0x75, 0x7c, 0xa3, 0xc2, 0xc4, 0xa4, 0x96, 0x93, 0x8f}
	for i := range payload {
		payload[i] ^= mask[i]
	}
	for i := range payload {
		mixed := byte(((payload[i] << 4) | (payload[i] >> 4)) ^ payload[(i+1)%20])
		payload[i] = reverseBits(mixed) ^ 0xff ^ 20
	}
	return map[string]string{
		"X-Khronos":       strconv.FormatInt(stamp/1000, 10),
		"X-Gorgon":        "8404401c0000" + hex.EncodeToString(payload),
		"X-SS-STUB":       strings.ToUpper(hex.EncodeToString(bodyDigest[:])),
		"X-SS-Req-Ticket": strconv.FormatInt(stamp, 10),
	}
}

func reverseBits(value byte) byte {
	var out byte
	for i := 0; i < 8; i++ {
		out |= ((value >> i) & 1) << (7 - i)
	}
	return out
}

func miniReelDecodeContentKey(value string) ([]byte, error) {
	if len(value) > 1024 {
		return nil, errors.New("spade_a is too long")
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(value)
	}
	if err != nil || len(raw) < 3 {
		return nil, errors.New("invalid spade_a")
	}
	tagLength := int(raw[0]^raw[1]^raw[2]) - 48
	length := len(raw) - tagLength - 1
	if tagLength < 1 || length < 33 || length >= len(raw) {
		return nil, errors.New("invalid spade_a structure")
	}
	seed := raw[len(raw)-tagLength-2] ^ raw[len(raw)-tagLength-1]
	tag := make([]byte, tagLength)
	for i := range tag {
		tag[i] = raw[len(raw)-tagLength+i] ^ seed
	}
	if string(tag) == "app_v2" || string(tag) == "web_v2" {
		return nil, errors.New("unsupported spade_a format")
	}
	decoded := make([]byte, length)
	previous := [2]byte{250, 85}
	for i := 0; i < length; i++ {
		current := raw[i+1]
		decoded[i] = byte((int(previous[i%2]^current) - 21 - bitCount(uint(i))) & 0xff)
		previous[i%2] = current
	}
	keyLength := miniReelBase36(decoded[0])
	if keyLength < 0 {
		return nil, errors.New("invalid spade_a key marker")
	}
	if keyLength >= 36 || length-keyLength-1 != 32 {
		return nil, errors.New("invalid spade_a payload")
	}
	keyText := string(decoded[1:33])
	if len(keyText) != 32 {
		return nil, errors.New("invalid CENC key length")
	}
	key, err := hex.DecodeString(keyText)
	if err != nil || len(key) != 16 {
		return nil, errors.New("invalid CENC key")
	}
	return key, nil
}

func miniReelBase36(value byte) int {
	switch {
	case value >= '0' && value <= '9':
		return int(value - '0')
	case value >= 'a' && value <= 'z':
		return int(value-'a') + 10
	case value >= 'A' && value <= 'Z':
		return int(value-'A') + 10
	default:
		return -1
	}
}

func bitCount(value uint) int {
	count := 0
	for value != 0 {
		count++
		value &= value - 1
	}
	return count
}

func chooseMiniReelOption(options []miniReelOption) miniReelOption {
	choices := make([]miniReelOption, 0, len(options))
	for _, option := range options {
		if option.Height > 0 && option.Height <= 720 {
			choices = append(choices, option)
		}
	}
	if len(choices) == 0 {
		choices = options
	}
	best := choices[0]
	for _, option := range choices[1:] {
		if option.Height > best.Height {
			best = option
		}
	}
	return best
}

func downloadMiniReelMedia(ctx context.Context, target, path string) (err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", miniReelAppUA)
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Referer", "https://novel.snssdk.com/")
	req.Header.Set("Origin", "https://novel.snssdk.com")
	resp, err := (&http.Client{Timeout: 90 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("media HTTP %d", resp.StatusCode)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() {
		_ = file.Close()
		if err != nil {
			_ = os.Remove(path)
		}
	}()
	reader := io.LimitReader(resp.Body, miniReelMaxBytes+1)
	n, err := io.Copy(file, reader)
	if err != nil {
		return err
	}
	if n > miniReelMaxBytes {
		return errors.New("media exceeds local bridge limit")
	}
	if n < 12 {
		return errors.New("media response is too small")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return file.Sync()
}

type mp4Box struct {
	Start   int
	Size    int
	Header  int
	Type    string
	Payload int
	End     int
}

func parseMP4Boxes(data []byte, start, end int) ([]mp4Box, error) {
	boxes := []mp4Box{}
	offset := start
	for offset+8 <= end {
		size32 := binary.BigEndian.Uint32(data[offset : offset+4])
		header := 8
		size := int(size32)
		if size32 == 1 {
			if offset+16 > end {
				return nil, errors.New("truncated MP4 extended box")
			}
			extended := binary.BigEndian.Uint64(data[offset+8 : offset+16])
			if extended > uint64(end-offset) || extended < 16 {
				return nil, errors.New("invalid MP4 box size")
			}
			size = int(extended)
			header = 16
		} else if size32 == 0 {
			size = end - offset
		} else if size < 8 || offset+size > end {
			return nil, errors.New("invalid MP4 box size")
		}
		if offset+size > end || offset+4+len(data[offset+4:offset+8]) > len(data) {
			return nil, errors.New("truncated MP4 box")
		}
		boxes = append(boxes, mp4Box{Start: offset, Size: size, Header: header, Type: string(data[offset+4 : offset+8]), Payload: offset + header, End: offset + size})
		offset += size
	}
	if offset != end {
		return nil, errors.New("unaligned MP4 box table")
	}
	return boxes, nil
}

func findMP4Child(data []byte, parent mp4Box, typ string) (mp4Box, bool) {
	children, err := parseMP4Boxes(data, parent.Payload, parent.End)
	if err != nil {
		return mp4Box{}, false
	}
	for _, child := range children {
		if child.Type == typ {
			return child, true
		}
	}
	return mp4Box{}, false
}

func findMP4Path(data []byte, root mp4Box, path ...string) (mp4Box, bool) {
	current := root
	for _, typ := range path {
		next, ok := findMP4Child(data, current, typ)
		if !ok {
			return mp4Box{}, false
		}
		current = next
	}
	return current, true
}

type mp4Sample struct {
	Offset int
	Size   int
	IV     []byte
}

func decryptMiniReelMP4(path string, key []byte) error {
	if len(key) != 16 {
		return errors.New("CENC key must be 16 bytes")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	rootBoxes, err := parseMP4Boxes(data, 0, len(data))
	if err != nil {
		return err
	}
	moov, ok := firstMP4Box(rootBoxes, "moov")
	if !ok {
		return errors.New("MP4 has no moov box")
	}
	trakBoxes, err := parseMP4Boxes(data, moov.Payload, moov.End)
	if err != nil {
		return err
	}
	decryptedTracks := 0
	for _, trak := range trakBoxes {
		if trak.Type != "trak" {
			continue
		}
		stbl, ok := findMP4Path(data, trak, "mdia", "minf", "stbl")
		if !ok {
			continue
		}
		senc, hasSenc := findMP4Child(data, stbl, "senc")
		if !hasSenc {
			continue
		}
		samples, err := mp4TrackSamples(data, stbl, senc)
		if err != nil {
			return err
		}
		if len(samples) == 0 {
			continue
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return err
		}
		for _, sample := range samples {
			if sample.Offset < 0 || sample.Size < 0 || sample.Offset+sample.Size > len(data) {
				return errors.New("MP4 sample is outside file")
			}
			if err := decryptMP4Sample(data[sample.Offset:sample.Offset+sample.Size], sample.IV, block); err != nil {
				return err
			}
		}
		decryptedTracks++
		if err := renameEncryptedSampleEntry(data, stbl); err != nil {
			return err
		}
	}
	if decryptedTracks == 0 {
		return errors.New("MP4 has no supported senc samples")
	}
	return os.WriteFile(path, data, 0600)
}

func firstMP4Box(boxes []mp4Box, typ string) (mp4Box, bool) {
	for _, box := range boxes {
		if box.Type == typ {
			return box, true
		}
	}
	return mp4Box{}, false
}

func mp4TrackSamples(data []byte, stbl, senc mp4Box) ([]mp4Sample, error) {
	stsc, ok := findMP4Child(data, stbl, "stsc")
	if !ok {
		return nil, errors.New("MP4 track has no stsc")
	}
	stsz, ok := findMP4Child(data, stbl, "stsz")
	if !ok {
		return nil, errors.New("MP4 track has no stsz")
	}
	chunkOffsets, ok := findMP4Child(data, stbl, "stco")
	if !ok {
		chunkOffsets, ok = findMP4Child(data, stbl, "co64")
	}
	if !ok {
		return nil, errors.New("MP4 track has no chunk offsets")
	}
	offsets, err := parseMP4ChunkOffsets(data, chunkOffsets)
	if err != nil {
		return nil, err
	}
	sizes, err := parseMP4SampleSizes(data, stsz)
	if err != nil {
		return nil, err
	}
	entries, err := parseMP4Stsc(data, stsc)
	if err != nil {
		return nil, err
	}
	positions := make([]int, len(sizes))
	sampleIndex := 0
	for chunk := 1; chunk <= len(offsets) && sampleIndex < len(sizes); chunk++ {
		entry := entries[len(entries)-1]
		for index := range entries {
			if entries[index].FirstChunk <= chunk {
				entry = entries[index]
			}
		}
		current := offsets[chunk-1]
		for count := 0; count < entry.SamplesPerChunk && sampleIndex < len(sizes); count++ {
			positions[sampleIndex] = current
			current += sizes[sampleIndex]
			sampleIndex++
		}
	}
	if sampleIndex != len(sizes) {
		return nil, errors.New("MP4 stsc sample count mismatch")
	}
	ivs, err := parseMP4SencIVs(data, senc, len(sizes))
	if err != nil {
		return nil, err
	}
	samples := make([]mp4Sample, len(sizes))
	for i := range samples {
		samples[i] = mp4Sample{Offset: positions[i], Size: sizes[i], IV: ivs[i]}
	}
	return samples, nil
}

type mp4StscEntry struct{ FirstChunk, SamplesPerChunk int }

func parseMP4Stsc(data []byte, box mp4Box) ([]mp4StscEntry, error) {
	p := box.Payload + 4
	if p+4 > box.End {
		return nil, errors.New("invalid stsc")
	}
	count := int(binary.BigEndian.Uint32(data[p : p+4]))
	p += 4
	if count > miniReelRangeMaxSamples {
		return nil, errors.New("MP4 stsc table exceeds the sample limit")
	}
	entries := make([]mp4StscEntry, 0, count)
	for i := 0; i < count; i++ {
		if p+12 > box.End {
			return nil, errors.New("truncated stsc")
		}
		entries = append(entries, mp4StscEntry{int(binary.BigEndian.Uint32(data[p : p+4])), int(binary.BigEndian.Uint32(data[p+4 : p+8]))})
		p += 12
	}
	if len(entries) == 0 {
		return nil, errors.New("empty stsc")
	}
	return entries, nil
}

func parseMP4ChunkOffsets(data []byte, box mp4Box) ([]int, error) {
	p := box.Payload + 4
	if p+4 > box.End {
		return nil, errors.New("invalid chunk offsets")
	}
	count := int(binary.BigEndian.Uint32(data[p : p+4]))
	p += 4
	if count > miniReelRangeMaxSamples {
		return nil, errors.New("MP4 chunk table exceeds the sample limit")
	}
	offsets := make([]int, 0, count)
	wide := box.Type == "co64"
	for i := 0; i < count; i++ {
		if wide {
			if p+8 > box.End {
				return nil, errors.New("truncated co64")
			}
			value := binary.BigEndian.Uint64(data[p : p+8])
			if value > uint64(^uint(0)>>1) {
				return nil, errors.New("co64 offset too large")
			}
			offsets = append(offsets, int(value))
			p += 8
		} else {
			if p+4 > box.End {
				return nil, errors.New("truncated stco")
			}
			offsets = append(offsets, int(binary.BigEndian.Uint32(data[p:p+4])))
			p += 4
		}
	}
	return offsets, nil
}

func parseMP4SampleSizes(data []byte, box mp4Box) ([]int, error) {
	p := box.Payload + 4
	if p+8 > box.End {
		return nil, errors.New("invalid stsz")
	}
	constant := int(binary.BigEndian.Uint32(data[p : p+4]))
	count := int(binary.BigEndian.Uint32(data[p+4 : p+8]))
	p += 8
	if count > miniReelRangeMaxSamples {
		return nil, errors.New("MP4 sample table exceeds the sample limit")
	}
	sizes := make([]int, count)
	for i := range sizes {
		if constant != 0 {
			sizes[i] = constant
			continue
		}
		if p+4 > box.End {
			return nil, errors.New("truncated stsz")
		}
		sizes[i] = int(binary.BigEndian.Uint32(data[p : p+4]))
		p += 4
	}
	return sizes, nil
}

func parseMP4SencIVs(data []byte, box mp4Box, sampleCount int) ([][]byte, error) {
	p := box.Payload
	if p+8 > box.End {
		return nil, errors.New("invalid senc")
	}
	flags := binary.BigEndian.Uint32(data[p:p+4]) & 0xffffff
	count := int(binary.BigEndian.Uint32(data[p+4 : p+8]))
	if count > miniReelRangeMaxSamples {
		return nil, errors.New("MP4 senc table exceeds the sample limit")
	}
	if count != sampleCount {
		return nil, fmt.Errorf("senc count %d does not match samples %d", count, sampleCount)
	}
	p += 8
	remaining := box.End - p
	ivSize := 8
	if count > 0 && remaining == count*16 {
		ivSize = 16
	}
	ivs := make([][]byte, count)
	for i := 0; i < count; i++ {
		if p+ivSize > box.End {
			return nil, errors.New("truncated senc IV")
		}
		ivs[i] = append([]byte(nil), data[p:p+ivSize]...)
		p += ivSize
		if flags&0x2 != 0 {
			if p+2 > box.End {
				return nil, errors.New("truncated senc subsamples")
			}
			subCount := int(binary.BigEndian.Uint16(data[p : p+2]))
			p += 2 + subCount*6
			if p > box.End {
				return nil, errors.New("truncated senc subsample table")
			}
			return nil, errors.New("subsample encrypted MP4 is not supported")
		}
	}
	return ivs, nil
}

func decryptMP4Sample(sample, iv []byte, block cipher.Block) error {
	counter := make([]byte, aes.BlockSize)
	if len(iv) == 16 {
		copy(counter, iv)
	} else if len(iv) == 8 {
		copy(counter, iv)
	} else {
		return errors.New("unsupported CENC IV size")
	}
	cipher.NewCTR(block, counter).XORKeyStream(sample, sample)
	return nil
}

func renameEncryptedSampleEntry(data []byte, stbl mp4Box) error {
	stsd, ok := findMP4Child(data, stbl, "stsd")
	if !ok || stsd.Payload+8 > stsd.End {
		return errors.New("encrypted track has no stsd")
	}
	p := stsd.Payload + 8
	count := int(binary.BigEndian.Uint32(data[stsd.Payload+4 : stsd.Payload+8]))
	for i := 0; i < count; i++ {
		if p+8 > stsd.End {
			return errors.New("truncated stsd")
		}
		size := int(binary.BigEndian.Uint32(data[p : p+4]))
		if size < 8 || p+size > stsd.End {
			return errors.New("invalid stsd entry")
		}
		typ := string(data[p+4 : p+8])
		if typ == "encv" {
			format := encryptedVideoSampleEntryFormat(data, mp4Box{
				Start: p, Size: size, Header: 8, Type: typ, Payload: p + 8, End: p + size,
			})
			if format == "" {
				// Preserve the established HEVC fallback when frma is absent or
				// malformed. Existing red-fruit media is HEVC, so this keeps the
				// current playback path unchanged while allowing confirmed AVC.
				format = "hvc1"
			}
			copy(data[p+4:p+8], []byte(format))
			neutralizeSampleEntryProtection(data, mp4Box{
				Start: p, Size: size, Header: 8, Type: typ, Payload: p + 8, End: p + size,
			})
		}
		if typ == "enca" {
			copy(data[p+4:p+8], []byte("mp4a"))
			neutralizeSampleEntryProtection(data, mp4Box{
				Start: p, Size: size, Header: 8, Type: typ, Payload: p + 8, End: p + size,
			})
		}
		p += size
	}
	return nil
}

const visualSampleEntryHeaderSize = 78
const audioSampleEntryHeaderSize = 28

// neutralizeSampleEntryProtection keeps the MP4 layout and offsets intact
// while removing protection metadata after sample bytes have been decrypted.
// A free box remains in place of sinf because deleting bytes would invalidate
// stco/co64 offsets and the Range sample index.
func neutralizeSampleEntryProtection(data []byte, entry mp4Box) {
	headerSize := 0
	switch entry.Type {
	case "encv":
		headerSize = visualSampleEntryHeaderSize
	case "enca":
		headerSize = audioSampleEntryHeaderSize
	default:
		return
	}
	childrenStart := entry.Payload + headerSize
	if childrenStart < entry.Payload || childrenStart > entry.End || entry.End > len(data) {
		return
	}
	children, err := parseMP4Boxes(data, childrenStart, entry.End)
	if err != nil {
		// Keep the established codec fallback for malformed/truncated input.
		return
	}
	for _, child := range children {
		if child.Type != "sinf" || child.Start+8 > child.End || child.End > len(data) {
			continue
		}
		copy(data[child.Start+4:child.Start+8], []byte("free"))
		for i := child.Payload; i < child.End; i++ {
			data[i] = 0
		}
	}
}

// encryptedVideoSampleEntryFormat returns the original codec stored in the
// encrypted sample entry's sinf/frma boxes. A blank result deliberately means
// "use the legacy HEVC fallback"; unknown codecs are not passed to players.
func encryptedVideoSampleEntryFormat(data []byte, entry mp4Box) string {
	if entry.Type != "encv" || entry.Payload < 0 || entry.Payload > entry.End || entry.End > len(data) {
		return ""
	}
	childrenStart := entry.Payload + visualSampleEntryHeaderSize
	if childrenStart < entry.Payload || childrenStart > entry.End {
		return ""
	}
	children, err := parseMP4Boxes(data, childrenStart, entry.End)
	if err != nil {
		return ""
	}
	sinf, ok := firstMP4Box(children, "sinf")
	if !ok {
		return ""
	}
	frma, ok := findMP4Child(data, sinf, "frma")
	if !ok || frma.Payload < 0 || frma.Payload+4 > frma.End || frma.Payload+4 > len(data) {
		return ""
	}
	format := string(data[frma.Payload : frma.Payload+4])
	switch format {
	case "avc1", "hvc1", "hev1":
		return format
	default:
		return ""
	}
}

func nestedMiniReelValue(root map[string]any, path ...string) any {
	var current any = root
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	return current
}

func miniReelReadLimited(reader io.Reader, maxBytes int64) ([]byte, error) {
	limited := io.LimitReader(reader, maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errors.New("body exceeds size limit")
	}
	return data, nil
}

func miniReelMapsFromAny(value any) []map[string]any {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	results := make([]map[string]any, 0, len(list))
	for _, item := range list {
		if mapped, ok := item.(map[string]any); ok {
			results = append(results, mapped)
		}
	}
	return results
}

func miniReelIntFromAny(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		number, _ := typed.Int64()
		return int(number)
	case string:
		number, _ := strconv.Atoi(strings.TrimSpace(typed))
		return number
	default:
		return 0
	}
}

func miniReelToString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(typed)
	}
}

func miniReelApplyCORS(headers http.Header) {
	headers.Set("Access-Control-Allow-Origin", "*")
	headers.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Content-Type, Range, If-Range")
	headers.Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, ETag")
}
