package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	miniReelRangeProbeBytes = int64(64 << 10)
	miniReelRangeMaxMoov    = int64(16 << 20)
	miniReelRangeChunkBytes = int64(512 << 10)
	miniReelRangeMaxSamples = 1_000_000
	miniReelRangeRetries    = 2
)

const miniReelRangeRequestTimeout = 12 * time.Second

var miniReelRangeRetryDelays = [...]time.Duration{300 * time.Millisecond, 700 * time.Millisecond}

// A range source retains only the MP4 initialization section and its sample
// index. Media bytes stay upstream until the browser asks for them.
type miniReelRangeSource struct {
	URL       string
	ETag      string
	Length    int64
	Prefix    []byte
	Samples   []mp4Sample
	Key       []byte
	VID       string
	Quality   string
	Codec     string
	CodecMode string
	Width     int
	Height    int

	mu        sync.RWMutex
	refreshMu sync.Mutex
}

func resolveMiniReelMediaRangeQuality(ctx context.Context, seriesID, vid, quality string, fallback, allowStandardFallback bool) (map[string]any, error) {
	return resolveMiniReelMediaRangeQualityMode(ctx, seriesID, vid, quality, fallback, allowStandardFallback, "default")
}

func resolveMiniReelMediaRangeQualityMode(ctx context.Context, seriesID, vid, quality string, fallback, allowStandardFallback bool, codecMode string) (map[string]any, error) {
	quality, err := normalizePlaybackQuality(quality)
	if err != nil {
		return nil, err
	}
	codecMode, err = normalizeMiniReelCodecMode(codecMode)
	if err != nil {
		return nil, err
	}
	token := miniReelCacheTokenWithCodec(seriesID, vid, quality, fallback, "range", codecMode)
	result, err := resolveMiniReelMediaWithTokenMode(ctx, token, seriesID, vid, quality, fallback, codecMode, prepareMiniReelRangeMedia)
	if err == nil {
		return result, nil
	}
	if !allowStandardFallback {
		return nil, fmt.Errorf("按需读取准备失败: %w", err)
	}
	// Unsupported MP4 layouts, weak/missing validators, and upstream servers
	// that ignore Range all use the established whole-file preparation path.
	result, fallbackErr := resolveMiniReelMediaQualityMode(ctx, seriesID, vid, quality, fallback, codecMode)
	if fallbackErr != nil {
		return nil, fmt.Errorf("按需读取和完整文件准备均失败: %w", playbackPreparationFallback(err, fallbackErr))
	}
	result["mode"] = "full"
	result["range_fallback"] = "按需读取不可用，已切换完整文件播放模式"
	return result, nil
}

func prepareMiniReelRangeMedia(ctx context.Context, job *miniReelMediaJob, token, seriesID, vid, quality string, fallback bool) {
	resolveStarted := time.Now()
	options, err := miniReelNativeOptions(ctx, vid, job.CodecMode)
	job.ResolveMS = time.Since(resolveStarted).Milliseconds()
	if err != nil {
		job.Err = err
		return
	}
	if len(options) == 0 {
		job.Err = wrapPlaybackPreparation(miniReelNoCompatibleOptionsError(job.CodecMode), "source_select", "VIDEO_MODEL_NO_QUALITY")
		return
	}
	option, err := selectMiniReelQuality(options, quality, fallback)
	if err != nil {
		job.Err = wrapPlaybackPreparation(err, "source_select", "VIDEO_MODEL_NO_QUALITY")
		return
	}
	rangeStarted := time.Now()
	source, err := openMiniReelRangeSource(ctx, option, vid, job.CodecMode)
	job.RangeInitMS = time.Since(rangeStarted).Milliseconds()
	if err != nil {
		job.Err = err
		return
	}
	job.Range = source
	job.Quality = option.Quality
	job.Qualities = miniReelQualities(options)
	job.VideoCodec = source.Codec
	job.VideoWidth = source.Width
	job.VideoHeight = source.Height
	job.Mode = "range"
	_ = token
	_ = seriesID
}

func openMiniReelRangeSource(ctx context.Context, option miniReelOption, vid string, codecModes ...string) (result *miniReelRangeSource, err error) {
	started := time.Now()
	diagnostic := playbackPreparationDiagnostic{Code: "RANGE_INIT_TRANSPORT", Stage: "range_init"}
	defer func() { err = finishPlaybackPreparation(err, diagnostic, started) }()
	codecMode := "default"
	if len(codecModes) > 0 {
		codecMode = codecModes[0]
	}
	codecMode, err = normalizeMiniReelCodecMode(codecMode)
	if err != nil {
		return nil, err
	}
	firstEnd := miniReelRangeProbeBytes - 1
	response, err := miniReelDoRange(ctx, option.URL, 0, firstEnd, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	diagnostic.HTTPStatus = &response.StatusCode
	diagnostic.Code = "RANGE_INIT_HTTP"
	if response.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("upstream did not honor Range (HTTP %d)", response.StatusCode)
	}
	diagnostic.Code = "RANGE_INIT_INVALID"
	etag := strings.TrimSpace(response.Header.Get("ETag"))
	if !validMiniReelRangeETag(etag) {
		return nil, errors.New("upstream has no strong ETag")
	}
	start, end, length, ok := parseMiniReelContentRange(response.Header.Get("Content-Range"))
	if !ok || start != 0 || end < start || length <= end || length > miniReelMaxBytes || end > firstEnd {
		return nil, errors.New("upstream returned an invalid initial Content-Range")
	}
	prefix, err := miniReelReadLimited(response.Body, miniReelRangeMaxMoov)
	if err != nil {
		return nil, err
	}
	responseBytes := len(prefix)
	diagnostic.ResponseBytes = &responseBytes
	if int64(len(prefix)) != end+1 {
		return nil, errors.New("upstream returned a truncated initial Range")
	}
	moovEnd, complete, err := miniReelFindMoovEnd(prefix, length)
	if err != nil {
		return nil, err
	}
	if !complete {
		if moovEnd <= 0 || moovEnd > miniReelRangeMaxMoov {
			return nil, errors.New("MP4 moov exceeds the experimental limit")
		}
		prefix, err = fetchMiniReelInitialPrefix(ctx, option.URL, etag, length, moovEnd)
		if err != nil {
			return nil, err
		}
	}
	if int64(len(prefix)) < moovEnd {
		return nil, errors.New("MP4 initialization section is incomplete")
	}
	prefix = append([]byte(nil), prefix[:moovEnd]...)
	samples, err := indexMiniReelRangeMP4(prefix, option.Key, length)
	if err != nil {
		return nil, err
	}
	source := &miniReelRangeSource{URL: option.URL, ETag: etag, Length: length, Prefix: prefix,
		Samples: samples, Key: append([]byte(nil), option.Key...), VID: vid, Quality: option.Quality,
		Codec: option.Codec, CodecMode: codecMode,
		Width: option.Width, Height: option.Height}
	return source, nil
}

func fetchMiniReelInitialPrefix(ctx context.Context, target, etag string, length, end int64) (data []byte, err error) {
	started := time.Now()
	diagnostic := playbackPreparationDiagnostic{Code: "RANGE_INIT_TRANSPORT", Stage: "range_init"}
	defer func() { err = finishPlaybackPreparation(err, diagnostic, started) }()
	response, err := miniReelDoRange(ctx, target, 0, end-1, "")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	diagnostic.HTTPStatus = &response.StatusCode
	diagnostic.Code = "RANGE_INIT_INVALID"
	if response.StatusCode != http.StatusPartialContent || strings.TrimSpace(response.Header.Get("ETag")) != etag {
		return nil, errors.New("upstream changed while reading MP4 initialization")
	}
	start, gotEnd, gotLength, ok := parseMiniReelContentRange(response.Header.Get("Content-Range"))
	if !ok || start != 0 || gotEnd != end-1 || gotLength != length {
		return nil, errors.New("upstream returned an inconsistent initialization Range")
	}
	data, err = miniReelReadLimited(response.Body, miniReelRangeMaxMoov)
	if err != nil {
		return nil, err
	}
	responseBytes := len(data)
	diagnostic.ResponseBytes = &responseBytes
	if int64(len(data)) != end {
		return nil, errors.New("upstream returned a truncated initialization Range")
	}
	return data, nil
}

func miniReelFindMoovEnd(data []byte, total int64) (int64, bool, error) {
	offset := int64(0)
	for offset+8 <= int64(len(data)) {
		size32 := uint64(binaryBigEndianUint32(data[int(offset):int(offset+4)]))
		header := int64(8)
		size := int64(size32)
		if size32 == 1 {
			if offset+16 > int64(len(data)) {
				return 0, false, nil
			}
			extended := binaryBigEndianUint64(data[int(offset+8):int(offset+16)])
			if extended > uint64(total-offset) {
				return 0, false, errors.New("invalid extended MP4 box size")
			}
			size = int64(extended)
			header = 16
		} else if size32 == 0 {
			size = total - offset
		}
		if size < header || offset+size > total {
			return 0, false, errors.New("invalid top-level MP4 box")
		}
		typ := string(data[int(offset+4):int(offset+8)])
		if typ == "moov" {
			if size > miniReelRangeMaxMoov || offset+size > int64(len(data)) {
				return offset + size, false, nil
			}
			return offset + size, true, nil
		}
		if typ == "mdat" {
			return 0, false, errors.New("MP4 moov follows media data")
		}
		if offset+size > int64(len(data)) {
			return 0, false, nil
		}
		offset += size
	}
	if int64(len(data)) >= total {
		return 0, false, errors.New("MP4 has no complete moov box")
	}
	return 0, false, nil
}

func binaryBigEndianUint32(data []byte) uint32 {
	return uint32(data[0])<<24 | uint32(data[1])<<16 | uint32(data[2])<<8 | uint32(data[3])
}

func binaryBigEndianUint64(data []byte) uint64 {
	return uint64(binaryBigEndianUint32(data[:4]))<<32 | uint64(binaryBigEndianUint32(data[4:8]))
}

func indexMiniReelRangeMP4(prefix, key []byte, length int64) ([]mp4Sample, error) {
	root, err := parseMP4Boxes(prefix, 0, len(prefix))
	if err != nil {
		return nil, err
	}
	moov, ok := firstMP4Box(root, "moov")
	if !ok {
		return nil, errors.New("MP4 has no moov box")
	}
	children, err := parseMP4Boxes(prefix, moov.Payload, moov.End)
	if err != nil {
		return nil, err
	}
	indexed := make([]mp4Sample, 0)
	decryptedTracks := 0
	for _, track := range children {
		if track.Type != "trak" {
			continue
		}
		stbl, ok := findMP4Path(prefix, track, "mdia", "minf", "stbl")
		if !ok {
			continue
		}
		senc, encrypted := findMP4Child(prefix, stbl, "senc")
		if !encrypted {
			continue
		}
		if len(key) != 16 {
			return nil, errors.New("encrypted track has no CENC key")
		}
		samples, err := mp4TrackSamples(prefix, stbl, senc)
		if err != nil {
			return nil, err
		}
		if len(samples) > miniReelRangeMaxSamples-len(indexed) {
			return nil, errors.New("MP4 sample table exceeds the experimental limit")
		}
		for _, sample := range samples {
			if sample.Offset < 0 || sample.Size <= 0 || int64(sample.Offset) > length || int64(sample.Size) > length-int64(sample.Offset) {
				return nil, errors.New("MP4 sample is outside the source file")
			}
		}
		indexed = append(indexed, samples...)
		if err := renameEncryptedSampleEntry(prefix, stbl); err != nil {
			return nil, err
		}
		decryptedTracks++
	}
	if len(key) > 0 && decryptedTracks == 0 {
		return nil, errors.New("MP4 has no supported senc samples")
	}
	sort.Slice(indexed, func(i, j int) bool { return indexed[i].Offset < indexed[j].Offset })
	return indexed, nil
}

func miniReelDoRange(ctx context.Context, target string, start, end int64, etag string) (*http.Response, error) {
	return miniReelDoRangeWithTimeout(ctx, target, start, end, etag, 45*time.Second)
}

func miniReelDoRangeWithTimeout(ctx context.Context, target string, start, end int64, etag string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", miniReelAppUA)
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Referer", "https://novel.snssdk.com/")
	req.Header.Set("Origin", "https://novel.snssdk.com")
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	if etag != "" {
		req.Header.Set("If-Range", etag)
	}
	return (&http.Client{Timeout: timeout}).Do(req)
}

func validMiniReelRangeETag(etag string) bool {
	return len(etag) >= 2 && strings.HasPrefix(etag, `"`) && strings.HasSuffix(etag, `"`) && !strings.HasPrefix(strings.ToUpper(etag), "W/")
}

func miniReelRangeMemorySize(source *miniReelRangeSource) int64 {
	if source == nil {
		return 0
	}
	size := int64(len(source.Prefix) + len(source.Key) + 128)
	for _, sample := range source.Samples {
		size += 64 + int64(len(sample.IV))
	}
	return size
}

func parseMiniReelContentRange(value string) (int64, int64, int64, bool) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "bytes ") {
		return 0, 0, 0, false
	}
	parts := strings.Split(strings.TrimPrefix(value, "bytes "), "/")
	if len(parts) != 2 {
		return 0, 0, 0, false
	}
	span := strings.Split(parts[0], "-")
	if len(span) != 2 {
		return 0, 0, 0, false
	}
	start, errStart := strconv.ParseInt(span[0], 10, 64)
	end, errEnd := strconv.ParseInt(span[1], 10, 64)
	total, errTotal := strconv.ParseInt(parts[1], 10, 64)
	return start, end, total, errStart == nil && errEnd == nil && errTotal == nil && start >= 0 && end >= start && total > end
}

func (source *miniReelRangeSource) fetch(ctx context.Context, start, end int64) ([]byte, error) {
	if start < 0 || end < start || end >= source.Length {
		return nil, errors.New("invalid upstream byte range")
	}
	source.mu.RLock()
	target := source.URL
	source.mu.RUnlock()
	refreshed := false
	requestStart := start
	var result bytes.Buffer
	failures := 0
	var lastErr error
	for requestStart <= end {
		response, requestErr := miniReelDoRangeWithTimeout(ctx, target, requestStart, end, source.ETag, miniReelRangeRequestTimeout)
		if requestErr != nil {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			lastErr = requestErr
		} else if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden ||
			response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
			response.Body.Close()
			if refreshed {
				return nil, fmt.Errorf("upstream Range HTTP %d after URL refresh", response.StatusCode)
			}
			if err := source.refreshURL(ctx, target); err != nil {
				lastErr = err
			} else {
				source.mu.RLock()
				target = source.URL
				source.mu.RUnlock()
				refreshed = true
				continue
			}
		} else if response.StatusCode != http.StatusPartialContent {
			status := response.StatusCode
			response.Body.Close()
			lastErr = fmt.Errorf("upstream Range HTTP %d", status)
			if !miniReelRangeStatusRetryable(status) {
				return nil, lastErr
			}
		} else {
			gotStart, gotEnd, gotLength, ok := parseMiniReelContentRange(response.Header.Get("Content-Range"))
			if !ok || gotStart != requestStart || gotEnd < gotStart || gotEnd > end || gotLength != source.Length {
				response.Body.Close()
				return nil, errors.New("upstream byte range changed")
			}
			if strings.TrimSpace(response.Header.Get("ETag")) != source.ETag {
				response.Body.Close()
				return nil, errors.New("upstream ETag changed")
			}
			data, readErr := miniReelReadPartial(response.Body, gotEnd-gotStart+1)
			response.Body.Close()
			if int64(len(data)) > gotEnd-gotStart+1 {
				return nil, errors.New("upstream returned an oversized media range")
			}
			if len(data) > 0 {
				_, _ = result.Write(data)
				requestStart += int64(len(data))
				// A successful response that ends before the requested end is
				// progress, not a failed request. Continue immediately from the
				// received offset without consuming the retry budget.
				if readErr == nil && requestStart == gotEnd+1 && requestStart <= end {
					failures = 0
					continue
				}
			}
			if requestStart > end {
				return result.Bytes(), nil
			}
			if readErr != nil {
				lastErr = readErr
			} else {
				lastErr = errors.New("upstream returned a truncated media range")
			}
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		failures++
		if failures > miniReelRangeRetries {
			break
		}
		delayIndex := failures - 1
		if delayIndex >= len(miniReelRangeRetryDelays) {
			delayIndex = len(miniReelRangeRetryDelays) - 1
		}
		timer := time.NewTimer(miniReelRangeRetryDelays[delayIndex])
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, lastErr
}

// miniReelReadPartial keeps bytes received before a broken upstream response.
// The next Range request starts at that offset, so a transient network drop
// does not throw away the already downloaded part of the current chunk.
func miniReelReadPartial(reader io.Reader, maxBytes int64) ([]byte, error) {
	limited := io.LimitReader(reader, maxBytes+1)
	data, err := io.ReadAll(limited)
	if int64(len(data)) > maxBytes {
		return nil, errors.New("body exceeds range size limit")
	}
	return data, err
}

func miniReelRangeStatusRetryable(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooEarly || status == http.StatusTooManyRequests || status >= 500
}

func (source *miniReelRangeSource) refreshURL(ctx context.Context, failedURL string) error {
	source.refreshMu.Lock()
	defer source.refreshMu.Unlock()
	source.mu.RLock()
	currentURL := source.URL
	source.mu.RUnlock()
	if currentURL != failedURL {
		return nil
	}
	options, err := miniReelNativeOptions(ctx, source.VID, source.CodecMode)
	if err != nil {
		return err
	}
	var selected *miniReelOption
	for index := range options {
		if options[index].Quality == source.Quality {
			selected = &options[index]
			break
		}
	}
	if selected == nil || selected.Codec != source.Codec || !bytes.Equal(selected.Key, source.Key) {
		return errors.New("refreshed media identity changed")
	}
	probe, err := miniReelDoRange(ctx, selected.URL, 0, 0, "")
	if err != nil {
		return err
	}
	defer probe.Body.Close()
	start, end, total, ok := parseMiniReelContentRange(probe.Header.Get("Content-Range"))
	if probe.StatusCode != http.StatusPartialContent || !ok || start != 0 || end != 0 || total != source.Length ||
		strings.TrimSpace(probe.Header.Get("ETag")) != source.ETag {
		return errors.New("refreshed media does not match the active stream")
	}
	source.mu.Lock()
	if source.URL == failedURL {
		source.URL = selected.URL
	}
	source.mu.Unlock()
	return nil
}

func serveMiniReelRangeMedia(w http.ResponseWriter, r *http.Request, source *miniReelRangeSource) {
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("ETag", source.ETag)
	miniReelApplyCORS(w.Header())
	start, end, partial, err := parseMiniReelByteRange(r.Header.Get("Range"), source.Length)
	if err != nil {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", source.Length))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if partial && r.Header.Get("If-Range") != "" && r.Header.Get("If-Range") != source.ETag {
		partial = false
	}
	if partial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, source.Length))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusPartialContent)
			return
		}
		firstEnd := miniReelRangeChunkEnd(start, end)
		data, err := source.readAndTransform(r.Context(), start, firstEnd)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusPartialContent)
		if _, err := w.Write(data); err != nil {
			return
		}
		writeMiniReelRangeRemainder(w, r, source, firstEnd+1, end)
		return
	}
	w.Header().Set("Content-Length", strconv.FormatInt(source.Length, 10))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	firstEnd := miniReelRangeChunkEnd(0, source.Length-1)
	data, err := source.readAndTransform(r.Context(), 0, firstEnd)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		return
	}
	writeMiniReelRangeRemainder(w, r, source, firstEnd+1, source.Length-1)
}

func miniReelRangeChunkEnd(start, requestedEnd int64) int64 {
	end := start + miniReelRangeChunkBytes - 1
	if end > requestedEnd {
		end = requestedEnd
	}
	return end
}

func writeMiniReelRangeRemainder(w http.ResponseWriter, r *http.Request, source *miniReelRangeSource, start, end int64) {
	for start <= end {
		chunkEnd := miniReelRangeChunkEnd(start, end)
		data, err := source.readAndTransform(r.Context(), start, chunkEnd)
		if err != nil {
			return
		}
		if _, err := w.Write(data); err != nil {
			return
		}
		start = chunkEnd + 1
	}
}

func parseMiniReelByteRange(value string, length int64) (int64, int64, bool, error) {
	if strings.TrimSpace(value) == "" {
		return 0, length - 1, false, nil
	}
	if length <= 0 || !strings.HasPrefix(value, "bytes=") || strings.Contains(value, ",") {
		return 0, 0, false, errors.New("invalid byte range")
	}
	parts := strings.Split(strings.TrimPrefix(value, "bytes="), "-")
	if len(parts) != 2 {
		return 0, 0, false, errors.New("invalid byte range")
	}
	if parts[0] == "" {
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false, errors.New("invalid suffix range")
		}
		if suffix > length {
			suffix = length
		}
		return length - suffix, length - 1, true, nil
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= length {
		return 0, 0, false, errors.New("range starts outside media")
	}
	end := length - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return 0, 0, false, errors.New("invalid range end")
		}
		if end >= length {
			end = length - 1
		}
	}
	return start, end, true, nil
}

func (source *miniReelRangeSource) readAndTransform(ctx context.Context, start, end int64) ([]byte, error) {
	data, err := source.fetch(ctx, start, end)
	if err != nil {
		return nil, err
	}
	if prefixEnd := int64(len(source.Prefix)) - 1; prefixEnd >= start {
		copyEnd := end
		if copyEnd > prefixEnd {
			copyEnd = prefixEnd
		}
		copy(data[:copyEnd-start+1], source.Prefix[start:copyEnd+1])
	}
	if len(source.Samples) == 0 {
		return data, nil
	}
	block, err := aes.NewCipher(source.Key)
	if err != nil {
		return nil, err
	}
	index := sort.Search(len(source.Samples), func(i int) bool { return int64(source.Samples[i].Offset+source.Samples[i].Size) > start })
	for ; index < len(source.Samples); index++ {
		sample := source.Samples[index]
		sampleStart := int64(sample.Offset)
		sampleEnd := sampleStart + int64(sample.Size) - 1
		if sampleStart > end {
			break
		}
		from := start
		if from < sampleStart {
			from = sampleStart
		}
		to := end
		if to > sampleEnd {
			to = sampleEnd
		}
		if from > to {
			continue
		}
		fragment := data[from-start : to-start+1]
		if err := decryptMiniReelCTRFragment(fragment, sample.IV, block, from-sampleStart); err != nil {
			return nil, err
		}
	}
	return data, nil
}

func decryptMiniReelCTRFragment(data, iv []byte, block cipher.Block, offset int64) error {
	if offset < 0 || len(iv) != 8 && len(iv) != 16 {
		return errors.New("unsupported CENC range IV")
	}
	counter := make([]byte, aes.BlockSize)
	copy(counter, iv)
	blocks := uint64(offset / aes.BlockSize)
	for i := len(counter) - 1; i >= 0 && blocks > 0; i-- {
		value := uint64(counter[i]) + (blocks & 0xff)
		counter[i] = byte(value)
		blocks = (blocks >> 8) + (value >> 8)
	}
	if blocks > 0 {
		return errors.New("CENC counter overflow")
	}
	skip := int(offset % aes.BlockSize)
	if skip == 0 {
		cipher.NewCTR(block, counter).XORKeyStream(data, data)
		return nil
	}
	buffer := make([]byte, skip+len(data))
	copy(buffer[skip:], data)
	cipher.NewCTR(block, counter).XORKeyStream(buffer, buffer)
	copy(data, buffer[skip:])
	return nil
}
