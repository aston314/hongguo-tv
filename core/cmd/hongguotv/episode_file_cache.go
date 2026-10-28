package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Desktop-only speculative work: one download, at most 64 MiB, using the
// existing 512 KiB Range/decryption path. Never resolve an arbitrary URL.
const episodeFileCacheLimit = int64(64 << 20)

var episodeFileCacheSlot = make(chan struct{}, 1)

func (s *server) cachePreparedEpisode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	result, err := cachePreparedEpisode(r.Context(), r.URL.Query().Get("media"))
	if err != nil {
		// Failure leaves the prepared Range source and foreground fallback intact.
		writeError(w, http.StatusConflict, "下一集完整缓存未就绪，保留原有播放方式")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result})
}

func cachePreparedEpisode(ctx context.Context, media string) (map[string]any, error) {
	const prefix = "/minireel-proxy/media/"
	if !strings.HasPrefix(media, prefix) || !miniReelCacheFileRE.MatchString(strings.TrimPrefix(media, prefix)) {
		return nil, errors.New("invalid prepared media")
	}
	token := strings.TrimSuffix(strings.TrimPrefix(media, prefix), ".mp4")
	miniReelState.Lock()
	sourceJob := miniReelState.jobs[token]
	if sourceJob == nil || !isMiniReelReady(sourceJob.Ready) || sourceJob.Err != nil || sourceJob.Range == nil {
		miniReelState.Unlock()
		return nil, errors.New("prepared Range source unavailable")
	}
	// Pin immutable metadata; a separate job owns the output. In-flight Range
	// readers must never observe a source switched to a partially written file.
	sourceJob.Waiters++
	sourceJob.Accessed = time.Now()
	source := sourceJob.Range
	quality := sourceJob.Quality
	qualities := append([]string(nil), sourceJob.Qualities...)
	miniReelState.Unlock()
	defer func() {
		miniReelState.Lock()
		sourceJob.Waiters--
		miniReelState.Unlock()
	}()
	if source.Length < 12 || source.Length > episodeFileCacheLimit {
		return nil, errors.New("episode exceeds optional cache budget")
	}
	// A renewed Range preparation may reuse its token with different media.
	// Include the validated representation identity, not its expiring URL.
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s:episode-file-v1:%s:%d", token, source.ETag, source.Length)))
	cacheToken := hex.EncodeToString(digest[:])[:24]
	return resolveMiniReelMediaWithPriority(ctx, cacheToken, "", source.VID, quality, true, true,
		func(ctx context.Context, job *miniReelMediaJob, token, _, _, _ string, _ bool) {
			job.Quality, job.Qualities, job.Mode = quality, qualities, "full"
			started := time.Now()
			job.Err = prepareEpisodeFileCache(ctx, job, token, source)
			job.DownloadMS = time.Since(started).Milliseconds()
		})
}

// Caller holds miniReelState. Cancellation never waits for disk/network cleanup.
func cancelEpisodeFileCachesLocked() {
	for _, job := range miniReelState.jobs {
		if job.Optional && !isMiniReelReady(job.Ready) && job.Cancel != nil {
			job.Cancel()
		}
	}
}

func beginEpisodeFileCache(ctx context.Context, job *miniReelMediaJob, needed int64) (func(), error) {
	select {
	case episodeFileCacheSlot <- struct{}{}:
	default:
		return nil, errors.New("another optional cache download is active")
	}
	release := func() { <-episodeFileCacheSlot }
	if err := ctx.Err(); err != nil {
		release()
		return nil, err
	}
	if err := ensureMiniReelRoot(); err != nil {
		release()
		return nil, err
	}
	miniReelState.Lock()
	busy := false
	for _, other := range miniReelState.jobs {
		if other != job && !isMiniReelReady(other.Ready) {
			busy = true
			break
		}
	}
	available := int64(miniReelMaxCache) - miniReelDirectorySize(miniReelState.root)
	for _, other := range miniReelState.jobs {
		if isMiniReelReady(other.Ready) && other.Range != nil {
			available -= miniReelRangeMemorySize(other.Range)
		}
	}
	miniReelState.Unlock()
	// The existing global limit remains a cleanup target. Speculation reserves
	// its entire file size before starting, without evicting foreground files.
	if busy || available < needed {
		release()
		return nil, errors.New("foreground preparation or cache budget takes priority")
	}
	return release, nil
}

func prepareEpisodeFileCache(ctx context.Context, job *miniReelMediaJob, token string, source *miniReelRangeSource) error {
	release, err := beginEpisodeFileCache(ctx, job, source.Length)
	if err != nil {
		return err
	}
	defer release()
	miniReelState.Lock()
	root := miniReelState.root
	miniReelState.Unlock()
	directory := filepath.Join(root, token)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(directory)
		}
	}()
	path := filepath.Join(directory, token+".mp4")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	for offset := int64(0); offset < source.Length; {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := miniReelRangeChunkEnd(offset, source.Length-1)
		data, err := source.readAndTransform(ctx, offset, end)
		if err != nil {
			return err
		}
		if int64(len(data)) != end-offset+1 {
			return io.ErrUnexpectedEOF
		}
		if _, err = file.Write(data); err != nil {
			return err
		}
		offset = end + 1
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	job.Path = path
	complete = true
	return nil
}
