package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Statistics are independent of progress/cloud history. No titles, episode
// records, positions, URLs or credentials are retained. Each day has at most
// four types and sixteen primary genres; only the last 366 days are kept.
const watchRetentionDays = 366

type watchDay struct {
	MS     int64            `json:"ms"`
	Types  map[string]int64 `json:"types"`
	Genres map[string]int64 `json:"genres"`
}

type watchStatisticsData struct {
	Version  int                  `json:"version"`
	Since    string               `json:"since"`
	ResetAt  int64                `json:"reset_at,omitempty"`
	Revision string               `json:"revision"`
	Days     map[string]*watchDay `json:"days"`
	Batches  []string             `json:"batches"`
}

type watchSegment struct {
	Day   string `json:"day"`
	MS    int64  `json:"ms"`
	Type  string `json:"type"`
	Genre string `json:"genre"`
}

type watchBatch struct {
	OwnerID  string         `json:"owner_id"`
	ID       string         `json:"id"`
	Revision string         `json:"revision,omitempty"`
	Items    []watchSegment `json:"items"`
}

type watchStatisticsStore struct {
	mu  sync.Mutex
	dir string
}

var watchBatchID = regexp.MustCompile(`^[a-zA-Z0-9_-]{8,96}$`)
var errWatchStatisticsReset = errors.New("statistics reset")

func watchDate(value string) (time.Time, bool) {
	d, err := time.Parse("2006-01-02", value)
	return d, err == nil && d.Format("2006-01-02") == value
}

func validWatchToday(value string, now time.Time) bool {
	d, ok := watchDate(value)
	u := now.UTC()
	today := time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
	return ok && !d.Before(today.AddDate(0, 0, -1)) && !d.After(today.AddDate(0, 0, 1))
}

func validWatchBatch(batch watchBatch, today time.Time) bool {
	if !watchBatchID.MatchString(batch.ID) || len(batch.Items) == 0 || len(batch.Items) > 128 {
		return false
	}
	var total int64
	for _, item := range batch.Items {
		d, ok := watchDate(item.Day)
		if !ok || d.Before(today.AddDate(0, 0, -7)) || d.After(today) || item.MS < 1 || item.MS > 60000 {
			return false
		}
		if item.Type != "real" && item.Type != "comic" && item.Type != "ai" && item.Type != "unknown" {
			return false
		}
		if len([]rune(item.Genre)) > 40 || strings.TrimSpace(item.Genre) != item.Genre || item.Genre == "__proto__" || item.Genre == "constructor" || item.Genre == "prototype" || strings.ContainsAny(item.Genre, "/\\<>:") {
			return false
		}
		for _, char := range item.Genre {
			if unicode.IsControl(char) {
				return false
			}
		}
		total += item.MS
	}
	return total <= 120000
}

func (s *watchStatisticsStore) file(owner string) string {
	hash := sha256.Sum256([]byte(owner))
	return filepath.Join(s.dir, "watch-statistics", hex.EncodeToString(hash[:16])+".json")
}

func newWatchStatistics() watchStatisticsData {
	return watchStatisticsData{Version: 1, Days: map[string]*watchDay{}, Batches: []string{}}
}

func pruneWatchStatistics(data *watchStatisticsData, today time.Time) {
	cutoff := today.AddDate(0, 0, 1-watchRetentionDays).Format("2006-01-02")
	for day := range data.Days {
		if _, valid := watchDate(day); !valid || day < cutoff {
			delete(data.Days, day)
		}
	}
	if data.Since != "" && data.Since < cutoff {
		data.Since = cutoff
	}
	if len(data.Batches) > 64 {
		data.Batches = data.Batches[len(data.Batches)-64:]
	}
}

func (s *watchStatisticsStore) read(owner string) (watchStatisticsData, error) {
	data := newWatchStatistics()
	f, err := os.Open(s.file(owner))
	if errors.Is(err, os.ErrNotExist) {
		return data, nil
	}
	if err != nil {
		return data, err
	}
	defer f.Close()
	err = json.NewDecoder(io.LimitReader(f, 1024*1024)).Decode(&data)
	if err != nil || data.Version != 1 || data.Days == nil {
		return newWatchStatistics(), errors.New("statistics unavailable")
	}
	return data, nil
}

func addWatchGenre(genres map[string]int64, genre string, ms int64) {
	if genre == "" {
		genre = "unknown"
	}
	if _, exists := genres[genre]; !exists && len(genres) >= 15 {
		genre = "unknown"
	}
	genres[genre] += ms
}

func (s *watchStatisticsStore) apply(batch watchBatch, today time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.read(batch.OwnerID)
	if err != nil {
		return err
	}
	if batch.Revision != data.Revision {
		return errWatchStatisticsReset
	}
	for _, id := range data.Batches {
		if id == batch.ID {
			return nil // A lost HTTP response must not count the same batch twice.
		}
	}
	pruneWatchStatistics(&data, today)
	for _, item := range batch.Items {
		day := data.Days[item.Day]
		if day == nil {
			day = &watchDay{Types: map[string]int64{}, Genres: map[string]int64{}}
			data.Days[item.Day] = day
		}
		ms := min(item.MS, 86400000-day.MS)
		if ms < 1 {
			continue
		}
		if day.Types == nil {
			day.Types = map[string]int64{}
		}
		if day.Genres == nil {
			day.Genres = map[string]int64{}
		}
		day.MS += ms
		day.Types[item.Type] += ms
		addWatchGenre(day.Genres, item.Genre, ms)
		if data.Since == "" || item.Day < data.Since {
			data.Since = item.Day
		}
	}
	data.Batches = append(data.Batches, batch.ID)
	pruneWatchStatistics(&data, today)
	return s.persist(batch.OwnerID, data)
}

func (s *watchStatisticsStore) reset(owner string, today time.Time, now time.Time) (watchStatisticsData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := newWatchStatistics()
	var revision [16]byte
	if _, err := rand.Read(revision[:]); err != nil {
		return data, err
	}
	data.Since = today.Format("2006-01-02")
	data.ResetAt = now.UnixMilli()
	data.Revision = hex.EncodeToString(revision[:])
	return data, s.persist(owner, data)
}

// The caller holds mu for both normal saves and resets.
func (s *watchStatisticsStore) persist(owner string, data watchStatisticsData) error {
	body, err := json.Marshal(data)
	if err != nil {
		return err
	}
	file := s.file(owner)
	if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".watch-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(body)
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), file)
	}
	// Deliberately no fsync: a best-effort aggregate must not force a storage
	// barrier while the device is playing. Atomic replacement protects readers.
	return err
}

func (s *server) watchStatistics(w http.ResponseWriter, r *http.Request) {
	if s.watchStatisticsStore == nil {
		writeError(w, 503, "观看统计暂不可用")
		return
	}
	owner := ""
	if s.accounts != nil {
		owner = s.accounts.currentAccountUID()
	}
	if r.URL.Query().Get("owner_id") != owner {
		writeError(w, 409, "账号已切换，请重新打开页面")
		return
	}
	today, ok := watchDate(r.URL.Query().Get("day"))
	if !ok || !validWatchToday(r.URL.Query().Get("day"), time.Now()) {
		writeError(w, 400, "统计日期无效")
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.watchStatisticsStore.mu.Lock()
		data, err := s.watchStatisticsStore.read(owner)
		s.watchStatisticsStore.mu.Unlock()
		if err != nil {
			writeError(w, 503, "观看统计暂不可用")
			return
		}
		pruneWatchStatistics(&data, today)
		data.Batches = nil
		writeJSON(w, 200, map[string]any{"ok": true, "data": data})
	case http.MethodPost:
		var batch watchBatch
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&batch) != nil || decoder.Decode(&struct{}{}) != io.EOF || !validWatchBatch(batch, today) {
			writeError(w, 400, "统计请求无效")
			return
		}
		if batch.OwnerID != owner {
			writeError(w, 409, "账号已切换，请重新打开页面")
			return
		}
		if err := s.watchStatisticsStore.apply(batch, today); err != nil {
			if errors.Is(err, errWatchStatisticsReset) {
				writeError(w, 409, "统计已重置，请重新记录")
				return
			}
			writeError(w, 503, "观看统计暂不可用")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	case http.MethodDelete:
		data, err := s.watchStatisticsStore.reset(owner, today, time.Now())
		if err != nil {
			writeError(w, 503, "重置统计失败，请重试")
			return
		}
		data.Batches = nil
		writeJSON(w, 200, map[string]any{"ok": true, "data": data})
	default:
		writeError(w, 405, "method not allowed")
	}
}
