package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The UI is embedded so Android, desktop and development browser builds use
// the same page and the same local HTTP contract.
//
//go:embed ui
var uiFiles embed.FS

var version = "0.2.9-dev"

type server struct {
	instanceID         string
	startedAt          time.Time
	hongguo            *hongguoClient
	radar              *radarService
	libraryStore       *libraryStore
	accounts           *accountManager
	numberInputs       *numberInputManager
	searchHistoryStore *searchHistoryStore
}

type statusResponse struct {
	OK             bool     `json:"ok"`
	Service        string   `json:"service"`
	Version        string   `json:"version"`
	InstanceID     string   `json:"instance_id,omitempty"`
	Implementation string   `json:"implementation"`
	StartedAt      string   `json:"started_at"`
	Capabilities   []string `json:"capabilities"`
}

func main() {
	port := flag.Int("port", 8797, "local HTTP port")
	instanceID := flag.String("instance-id", "", "Android child process identity")
	parentPID := flag.Int("parent-pid", 0, "exit when the Android host process ends")
	dataDir := flag.String("data-dir", defaultLibraryDir(), "persistent local library directory")
	flag.Parse()

	root, err := fs.Sub(uiFiles, "ui")
	if err != nil {
		log.Fatalf("prepare UI: %v", err)
	}

	library, err := newLibraryStore(*dataDir)
	if err != nil {
		log.Fatalf("prepare local library: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &server{instanceID: *instanceID, startedAt: time.Now().UTC(), hongguo: newHongguoClient(), radar: newRadarService(*dataDir, nil), libraryStore: library}
	s.numberInputs = newNumberInputManager()
	defer s.numberInputs.close()
	s.searchHistoryStore, err = newSearchHistoryStore(*dataDir)
	if err != nil {
		log.Printf("prepare recent search: %v", err)
	}
	s.accounts, err = newAccountManager(*dataDir, library, s.hongguo)
	if err != nil {
		log.Fatalf("prepare account: %v", err)
	}
	go s.accounts.run(ctx)
	if err := ensureMiniReelRoot(); err != nil {
		// Account and browsing pages remain usable; playback retries initialization.
		log.Printf("prepare media cache: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", s.health)
	mux.HandleFunc("/api/v1/status", s.status)
	mux.HandleFunc("/api/v1/library", s.library)
	mux.HandleFunc("/api/v1/account", s.account)
	mux.HandleFunc("/api/v1/account/", s.account)
	mux.HandleFunc("/api/v1/number-input", s.numberInput)
	mux.HandleFunc("/api/v1/search-history", s.searchHistory)
	mux.HandleFunc("/api/v1/category", s.category)
	mux.HandleFunc("/api/v1/Category", s.category)
	mux.HandleFunc("/api/v1/rank", s.rank)
	mux.HandleFunc("/api/v1/Rank", s.rank)
	mux.HandleFunc("/api/v1/radar", s.radarSnapshot)
	mux.HandleFunc("/api/v1/series/detail", s.seriesDetail)
	mux.HandleFunc("/api/v1/SeriesDetail", s.seriesDetail)
	mux.HandleFunc("/api/v1/series/next-season", s.nextSeason)
	mux.HandleFunc("/api/v1/series/seasons", s.seriesSeasons)
	mux.HandleFunc("/api/v1/search", s.search)
	mux.HandleFunc("/api/v1/search/suggestions", s.searchSuggestions)
	mux.HandleFunc("/api/v1/actors/works", s.actorWorks)
	mux.HandleFunc("/api/v1/lists/", s.lists)
	mux.HandleFunc("/api/v1/follow", s.follow)
	mux.HandleFunc("/api/v1/notifications", s.notifications)
	mux.HandleFunc("/api/v1/reservation", s.reservation)
	mux.HandleFunc("/api/v1/comments", s.discussion)
	mux.HandleFunc("/api/v1/danmaku", s.discussion)
	mux.HandleFunc("/api/v1/replies", s.discussion)
	mux.HandleFunc("/api/v1/player/action", s.playerAction)
	mux.HandleFunc("/api/v1/player/stats", s.engagement)
	mux.HandleFunc("/api/v1/player/diagnostics", s.playbackDiagnostics)
	mux.HandleFunc("/api/v1/Search", s.search)
	mux.HandleFunc("/api/v1/play/info", s.playInfo)
	mux.HandleFunc("/api/v1/PlayInfo", s.playInfo)
	// The TV APK owns the MiniReel resolver and media cache.  These routes are
	// served by the same process so the UI never needs a second playback host.
	mux.HandleFunc("/minireel-proxy/resolve", handleMiniReelResolve)
	mux.HandleFunc("/minireel-proxy/media/", handleMiniReelMedia)
	mux.Handle("/", serveUI(root))

	if err := serveLocalCore(ctx, *port, *instanceID, *parentPID, s.withCORS(mux)); err != nil {
		log.Fatal(err)
	}
}

func serveUI(root fs.FS) http.Handler {
	files := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// APK updates must use the embedded UI from the current core, while
		// leaving DOM storage, account records and the media cache intact.
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})
}

func (s *server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/account") || r.URL.Path == "/api/v1/number-input" || strings.HasPrefix(r.URL.Path, "/api/v1/lists/") || r.URL.Path == "/api/v1/search" || r.URL.Path == "/api/v1/Search" || r.URL.Path == "/api/v1/follow" || r.URL.Path == "/api/v1/notifications" || strings.HasPrefix(r.URL.Path, "/api/v1/player/") || r.URL.Path == "/api/v1/series/seasons" || r.URL.Path == "/api/v1/replies" || r.URL.Path == "/api/v1/reservation" || r.URL.Path == "/api/v1/comments" || r.URL.Path == "/api/v1/danmaku" || r.URL.Path == "/api/v1/library" {
			if !privateLocalRequest(r) {
				writeError(w, http.StatusForbidden, "只允许应用本身访问账号和记录")
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func privateLocalRequest(r *http.Request) bool {
	requestURL, err := url.Parse("http://" + r.Host)
	if err != nil || requestURL.User != nil {
		return false
	}
	requestHost := requestURL.Hostname()
	requestIP := net.ParseIP(requestHost)
	if requestHost != "localhost" && (requestIP == nil || !requestIP.IsLoopback()) {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "http" || u.Host != r.Host {
			return false
		}
	}
	if ref := r.Header.Get("Referer"); ref != "" {
		u, err := url.Parse(ref)
		if err != nil || u.Host != r.Host {
			return false
		}
	}
	return true
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, statusResponse{
		OK:             true,
		Service:        "hongguo-tv-core",
		Version:        version,
		InstanceID:     s.instanceID,
		Implementation: "go-api-adapter+embedded-playback",
		StartedAt:      s.startedAt.Format(time.RFC3339),
		Capabilities:   []string{"tv-ui", "local-http", "focus-state-machine", "category", "rank", "actor-works", "ranking-radar", "search", "series-detail", "series-reviews", "related-series", "follow-updates", "notifications", "play-info", "embedded-playback", "cenc-mp4", "range-media", "local-history", "local-favorites", "local-likes", "resume-playback", "next-episode", "next-season", "account-login", "account-mfa", "cloud-library", "new-series", "release-calendar", "reservations", "recommend-feed", "comments", "danmaku", "infinite-scroll"},
	})
}

func (s *server) category(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	request := CategoryRequest{
		Path:      r.URL.Query().Get("path"),
		Offset:    parseQueryInt(r, "offset"),
		SessionID: r.URL.Query().Get("session_id"),
		Shown:     splitQueryList(r.URL.Query().Get("shown")),
		Selectors: r.URL.Query().Get("selectors") == "1",
		Filters:   map[string]string{},
	}
	for kind := range categoryFilterNames {
		if r.URL.Query().Has(kind) {
			request.Filters[kind] = r.URL.Query().Get(kind)
		}
	}
	if _, err := categorySelection(request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := s.hongguo.Category(r.Context(), request)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result})
}

func (s *server) rank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	result, err := s.hongguo.Rank(r.Context(), RankRequest{Path: r.URL.Query().Get("path")})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result})
}

func (s *server) seriesDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	seriesID := r.URL.Query().Get("series_id")
	result, err := s.hongguo.SeriesDetail(r.Context(), seriesID)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result})
}

func (s *server) search(w http.ResponseWriter, r *http.Request) {
	// Keep the legacy route as a compatibility alias, but funnel every search
	// through the same registered-device API and pagination contract.
	request := r.Clone(r.Context())
	requestURL := *r.URL
	requestURL.Path = "/api/v1/lists/search"
	request.URL = &requestURL
	s.lists(w, request)
}

func (s *server) searchSuggestions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	result, err := s.hongguo.SearchSuggestions(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result})
}

func (s *server) actorWorks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	actorID := strings.TrimSpace(r.URL.Query().Get("actor_id"))
	if !validID(actorID) || actorID == "0" {
		writeError(w, http.StatusBadRequest, "actor_id 无效")
		return
	}
	result, err := s.hongguo.ActorWorks(r.Context(), actorID)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result})
}

func (s *server) follow(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		q, err := listQuery(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		client, generation, err := s.accounts.listClient(true)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err.Error())
			return
		}
		result, err := client.FollowUpdates(r.Context(), q)
		if !s.accounts.sameGeneration(generation) {
			writeError(w, http.StatusConflict, errAccountChanged.Error())
			return
		}
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result})
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		SeriesID string `json:"series_id"`
		Enabled  *bool  `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&body); err != nil || body.Enabled == nil {
		writeError(w, http.StatusBadRequest, "追更参数无效")
		return
	}
	client, generation, err := s.accounts.listClient(true)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	err = client.SetFollowUpdate(r.Context(), body.SeriesID, *body.Enabled)
	if !s.accounts.sameGeneration(generation) {
		writeError(w, http.StatusConflict, errAccountChanged.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "following_update": *body.Enabled})
}

func (s *server) playInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	quality, err := normalizePlaybackQuality(r.URL.Query().Get("quality"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	codecMode, err := normalizeMiniReelCodecMode(r.URL.Query().Get("codec_mode"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var result PlayInfo
	if r.URL.Query().Get("mode") == "range" {
		result, err = s.hongguo.PlayInfoRangeQualityMode(r.Context(), r.URL.Query().Get("series_id"), r.URL.Query().Get("vid"), quality, r.URL.Query().Get("fallback") == "1", r.URL.Query().Get("prefetch") != "1", codecMode)
	} else {
		result, err = s.hongguo.PlayInfoQualityMode(r.Context(), r.URL.Query().Get("series_id"), r.URL.Query().Get("vid"), quality, r.URL.Query().Get("fallback") == "1", codecMode)
	}
	if err != nil {
		writePlaybackPreparationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": result})
}

func parseQueryInt(r *http.Request, name string) int {
	value, _ := strconv.Atoi(r.URL.Query().Get(name))
	return value
}

func splitQueryList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	result := make([]string, 0)
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			result = append(result, item)
		}
	}
	return result
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write JSON: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": message})
}

func routeDescription(r *http.Request) string {
	return fmt.Sprintf("%s %s", r.Method, strings.TrimSpace(r.URL.Path))
}
