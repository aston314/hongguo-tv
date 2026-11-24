package jsupdatelab

import (
	"strings"
	"testing"

	"github.com/aston314/hongguo-tv/core/internal/jsupdate"
)

func TestInternetChannelSurvivesSourceRepositoryGoingPrivate(t *testing.T) {
	if InternetRoot+"manifest.json" != jsupdate.ManifestURL || !strings.Contains(InternetRoot, "/hongguo-tv-releases/main/") {
		t.Fatal("internet lab must read public release repository")
	}
	for _, name := range []string{"manifest.json", "resolver.js"} {
		if !jsupdate.OfficialURL(InternetRoot + name) {
			t.Fatalf("release asset rejected: %s", name)
		}
	}
	if jsupdate.OfficialURL("https://raw.githubusercontent.com/aston314/hongguo-tv/codex/resolver-js-update-fixtures/resolver.js") {
		t.Fatal("source repository must not be an artifact source")
	}
}
