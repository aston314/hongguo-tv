package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMiniReelFreshFallbackSingleModelProtocolAndOrder(t *testing.T) {
	for _, scenario := range []string{"tab_ok", "legacy_ok", "incompatible", "empty", "missing", "permanent", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			var order []string
			var singleIDs []string
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, r.URL.Path)
				switch r.URL.Path {
				case "/tab":
					if scenario == "tab_ok" {
						io.WriteString(w, strings.Replace(miniReelRecoveryModel, `"data":`, `"data":{"video_model_data":`, 1)+"}")
					}
				case "/legacy":
					if scenario == "legacy_ok" {
						io.WriteString(w, miniReelRecoveryModel)
					}
					if scenario == "incompatible" {
						io.WriteString(w, strings.ReplaceAll(miniReelRecoveryModel, `"h264"`, `"bytevc2"`))
					}
					if scenario == "missing" {
						io.WriteString(w, `{"code":0,"data":{}}`)
					}
					if scenario == "permanent" {
						io.WriteString(w, `{"code":100103}`)
					}
					if scenario == "cancel" {
						cancel()
					}
				case "/single":
					assertMiniReelPlaybackSignature(t, r)
					if r.Header.Get("Content-Encoding") != "" || r.Header.Get("User-Agent") != miniReelSingleUA {
						t.Error("incorrect single request headers")
					}
					q := r.URL.Query()
					if q.Get("version_code") != "73932" || q.Get("device_type") != "23127PN0CC" || q.Get("openudid") != "open" {
						t.Error("single profile leaked legacy settings")
					}
					singleIDs = append(singleIDs, q.Get("device_id"))
					body, _ := io.ReadAll(r.Body)
					var p struct {
						VID string `json:"video_id"`
						Biz struct {
							Platform int  `json:"video_platform"`
							All      bool `json:"need_all_video_definition"`
							Type     int  `json:"video_id_type"`
						} `json:"biz_param"`
					}
					if json.Unmarshal(body, &p) != nil || p.VID != "123" || p.Biz.Platform != 3 || !p.Biz.All || p.Biz.Type != 0 {
						t.Errorf("incorrect single payload %s", body)
					}
					io.WriteString(w, miniReelRecoveryModel)
				}
			}))
			defer server.Close()
			singleRegistrations := 0
			sources := miniReelPlaybackSources{tabEndpoint: server.URL + "/tab", tabIdentity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("tab"), nil }), legacyEndpoints: []string{server.URL + "/legacy"}, register: func(context.Context) (miniReelDevice, error) { return miniReelRecoveryDevice("legacy"), nil }, singleEndpoint: server.URL + "/single", registerSingle: func(context.Context) (miniReelDevice, error) {
				singleRegistrations++
				return miniReelDevice{deviceID: "1", installID: "2", cdid: "single", openUDID: "open"}, nil
			}}
			options, err := miniReelNativeOptionsWithSources(ctx, "123", "default", "1004", sources)
			wantSingle := scenario == "incompatible" || scenario == "empty" || scenario == "missing"
			if (singleRegistrations > 0) != wantSingle {
				t.Fatalf("single=%d order=%v err=%v", singleRegistrations, order, err)
			}
			if scenario == "cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				return
			}
			if scenario == "permanent" {
				if err == nil {
					t.Fatal("expected business rejection")
				}
				return
			}
			if err != nil || len(options) != 1 {
				t.Fatalf("options=%d err=%v", len(options), err)
			}
			if wantSingle && (singleRegistrations != 1 || len(singleIDs) != 1) {
				t.Fatal("unbounded registrations")
			}
			if scenario == "tab_ok" && strings.Join(order, ",") != "/tab" {
				t.Fatal(order)
			}
		})
	}
}

func TestMiniReelFreshFallbackMediaMustBeUsable(t *testing.T) {
	for _, failure := range []string{"http", "decrypt", "storage", "cancel", "quality", "success"} {
		t.Run(failure, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var order []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, r.URL.Path)
				model := miniReelRecoveryModel
				if r.URL.Path == "/tab" {
					model = strings.Replace(model, `"data":`, `"data":{"video_model_data":`, 1) + "}"
				}
				io.WriteString(w, model)
			}))
			defer server.Close()
			sources := miniReelPlaybackSources{tabEndpoint: server.URL + "/tab", tabIdentity: newMiniReelPlaybackDeviceCache(func() (miniReelDevice, error) { return miniReelRecoveryDevice("tab"), nil }), legacyEndpoints: []string{server.URL + "/legacy"}, register: func(context.Context) (miniReelDevice, error) { return miniReelRecoveryDevice("legacy"), nil }, singleEndpoint: server.URL + "/single", registerSingle: func(context.Context) (miniReelDevice, error) { return miniReelRecoveryDevice("single"), nil }}
			job := &miniReelMediaJob{CodecMode: "default", ContentType: "1004"}
			prepared := 0
			quality := ""
			if failure == "quality" {
				quality = "1080P"
			}
			prepareMiniReelWithSources(ctx, job, "123", quality, false, sources, func(miniReelOption) error {
				prepared++
				if prepared >= 3 || failure == "success" {
					return nil
				}
				switch failure {
				case "http":
					status := 403
					return &playbackPreparationError{diagnostic: playbackPreparationDiagnostic{Code: "MEDIA_DOWNLOAD_HTTP", HTTPStatus: &status}}
				case "decrypt":
					return wrapPlaybackPreparation(errors.New("invalid MP4"), "media_decrypt", "MEDIA_DECRYPT_FAILED")
				case "storage":
					return playbackStorageError(os.ErrPermission)
				case "cancel":
					cancel()
					return context.Canceled
				}
				return nil
			})
			if failure == "http" || failure == "decrypt" {
				if job.Err != nil || prepared != 3 || strings.Join(order, ",") != "/tab,/legacy,/single" {
					t.Fatalf("prepared=%d order=%v err=%v", prepared, order, job.Err)
				}
				return
			}
			if len(order) != 1 || prepared > 1 {
				t.Fatalf("non-source failure retried: %v", order)
			}
			if failure == "success" && job.Err != nil {
				t.Fatal(job.Err)
			}
			if failure != "success" && job.Err == nil {
				t.Fatal("expected failure")
			}
		})
	}
}

func TestMiniReelFreshFallbackSingleRegistrationProfileIsIsolated(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		encrypted, _ := io.ReadAll(r.Body)
		plain, err := passportTTDecrypt(encrypted)
		if err != nil {
			t.Error(err)
			return
		}
		var p struct {
			Header map[string]any `json:"header"`
		}
		_ = json.Unmarshal(plain, &p)
		if p.Header["app_version"] != "7.3.9.32" || p.Header["device_model"] != "23127PN0CC" || r.URL.Query().Get("version_name") != "7.3.9.32" {
			t.Error("registration profile mismatch")
		}
		if r.Header.Get("Cookie") != "" {
			t.Error("account cookies leaked")
		}
		io.WriteString(w, `{"device_id_str":"123","install_id_str":"456"}`)
	}))
	defer server.Close()
	d, err := registerMiniReelSingleDeviceAt(context.Background(), server.URL, server.Client())
	if err != nil || d.deviceID != "123" || d.openUDID == "" {
		t.Fatalf("registration failed: %v", err)
	}
}

func TestMiniReelFreshFallbackMediaHTTPReadRecovery(t *testing.T) {
	file := filepath.Join(t.TempDir(), "media.mp4")
	calls := 0
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(403)
			return
		}
		io.WriteString(w, "0123456789abcdefgh")
	}))
	defer media.Close()
	if err := downloadMiniReelMedia(context.Background(), media.URL, file); !miniReelMediaSourceFallbackAllowed(context.Background(), err) {
		t.Fatalf("HTTP failure not eligible: %v", err)
	}
	if err := downloadMiniReelMedia(context.Background(), media.URL, file); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "0123456789abcdefgh" {
		t.Fatal("bad media download")
	}
}

func TestMiniReelLiveSingleModelFallback(t *testing.T) {
	if os.Getenv("HONGGUO_LIVE_SINGLE_FALLBACK") != "1" {
		t.Skip("live upstream verification is opt-in")
	}
	vid := os.Getenv("HONGGUO_LIVE_MINIREEL_VIDEO_ID")
	if vid == "" {
		vid = "7702841953875938328"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	job := &miniReelMediaJob{CodecMode: "default", ContentType: "1004"}
	prepareMiniReelRangeMedia(ctx, job, "live", "7702841940475120702", vid, "", true)
	if job.Err != nil {
		t.Fatal(job.Err)
	}
	if job.Range == nil {
		t.Fatal("range preparation did not finish")
	}
	request := httptest.NewRequest(http.MethodGet, "/media.mp4", nil).WithContext(ctx)
	request.Header.Set("Range", "bytes=0-1048575")
	response := httptest.NewRecorder()
	serveMiniReelRangeMedia(response, request, job.Range)
	data := response.Body.Bytes()
	if response.Code != 206 || len(data) != 1<<20 || !bytes.Contains(data, []byte("hvcC")) || bytes.Contains(data, []byte("bv2C")) {
		t.Fatalf("media verification failed status=%d bytes=%d", response.Code, len(data))
	}
	t.Logf("prepared codec=%s size=%dx%d decrypted_media_bytes=%d resolve_ms=%d", job.VideoCodec, job.VideoWidth, job.VideoHeight, len(data), job.ResolveMS)
}

func TestMiniReelFreshFallbackMediaTimeoutDiffersFromJobCancellation(t *testing.T) {
	err := wrapPlaybackPreparation(context.DeadlineExceeded, "media_download", "MEDIA_DOWNLOAD_FAILED")
	if !miniReelMediaSourceFallbackAllowed(context.Background(), err) {
		t.Fatal("a CDN request timeout should allow another source")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if miniReelMediaSourceFallbackAllowed(ctx, err) {
		t.Fatal("a cancelled job must not start another source")
	}
}
